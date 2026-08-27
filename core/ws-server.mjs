// Zero-dependency RFC 6455 WebSocket server for the RMCH bridge channel.
// Binds 127.0.0.1 only. Auth: the upgrade URL must carry the project token.
//
// Wire protocol (JSON text frames):
//   bridge -> server: {"t":"hello",...} {"t":"pong"} {"t":"state","state":{...}}
//                         {"t":"result","id":..,"ok":bool,"payload":..|,"error":..}
//   server -> bridge: {"t":"hello","ok":true} {"t":"ping"}
//                         {"t":"cmd","id":..,"type":..,"args":{...}}
//   client (CLI/GUI) -> server on /client: {"t":"list"} {"t":"send",...}
//                             {"t":"watch"}
//   server -> client: {"t":"welcome"} {"t":"list","sessions":[...]}
//                         {"t":"result",...} {"t":"state",...} {"t":"event",...}
// The bridge identifies itself by URL path /bridge/<encodeURIComponent(gameKey)>.

import http from "node:http";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PING_INTERVAL_MS = 10000;
const PONG_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 20000;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export class BridgeServerError extends Error {}

function acceptKey(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

class WebSocketConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;

    socket.on("data", (chunk) => this.feed(chunk));
    const onDead = () => this.close();
    socket.on("close", onDead);
    socket.on("error", onDead);
    socket.on("end", onDead);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch (_) {}
    if (this.onclose) this.onclose();
  }

  feed(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (true) {
      const frame = this.tryReadFrame();
      if (!frame) break;
      if (!this.handleFrame(frame)) return;
    }
  }

  tryReadFrame() {
    const buffer = this.buffer;
    if (buffer.length < 2) return null;
    const first = buffer[0];
    const second = buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < offset + 2) return null;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null;
      const big = buffer.readBigUInt64BE(offset);
      if (big > BigInt(MAX_FRAME_BYTES)) {
        this.close();
        return null;
      }
      length = Number(big);
      offset += 8;
    }
    if (length > MAX_FRAME_BYTES) {
      this.close();
      return null;
    }
    const maskKey = masked ? 4 : 0;
    if (buffer.length < offset + maskKey + length) return null;
    let payload = buffer.subarray(offset + maskKey, offset + maskKey + length);
    if (masked) {
      const key = buffer.subarray(offset, offset + 4);
      const unmasked = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index += 1) {
        unmasked[index] = payload[index] ^ key[index & 3];
      }
      payload = unmasked;
    }
    this.buffer = buffer.subarray(offset + maskKey + length);
    return { fin, opcode, payload };
  }

  handleFrame(frame) {
    switch (frame.opcode) {
      case 0x0: { // continuation
        if (!this.fragments.length) return true;
        this.fragments.push(frame.payload);
        if (frame.fin) {
          const opcode = this.fragOpcode;
          const payload = Buffer.concat(this.fragments);
          this.fragments = [];
          this.fragOpcode = 0;
          if (opcode === 0x1 && this.onmessage) this.onmessage(payload.toString("utf8"));
        }
        return true;
      }
      case 0x1: // text
      case 0x2: { // binary
        if (!frame.fin) {
          this.fragments = [frame.payload];
          this.fragOpcode = frame.opcode;
          return true;
        }
        if (this.onmessage) this.onmessage(frame.payload.toString("utf8"));
        return true;
      }
      case 0x8: { // close
        try {
          this.socket.write(encodeFrame(0x8, Buffer.alloc(0)));
        } catch (_) {}
        this.close();
        return false;
      }
      case 0x9: { // ping
        try { this.socket.write(encodeFrame(0xA, frame.payload)); } catch (_) {}
        return true;
      }
      case 0xA: // pong
        return true;
      default:
        return true;
    }
  }

  sendText(text) {
    if (this.closed) return false;
    try {
      this.socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
      return true;
    } catch (_) {
      this.close();
      return false;
    }
  }

  sendJson(value) {
    return this.sendText(JSON.stringify(value));
  }
}

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

export class BridgeServer extends EventEmitter {
  constructor({ port = 47412, token, host = "127.0.0.1" } = {}) {
    super();
    this.port = port;
    this.host = host;
    this.token = token;
    this.httpServer = null;
    /** @type {Map<string, Session>} gameKey -> session */
    this.sessions = new Map();
    this.nextCommandId = 1;
    this.stopped = false;
  }

  async start() {
    if (this.httpServer) return;
    const server = http.createServer((req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("RMCH bridge server: WebSocket only\n");
    });
    server.on("upgrade", (req, socket) => this.handleUpgrade(req, socket));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, resolve);
    });
    this.httpServer = server;
    this.pingTimer = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
    this.pingTimer.unref?.();
    return this;
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    for (const session of this.sessions.values()) session.drop("server stopped");
    this.sessions.clear();
    if (this.clients) {
      for (const client of this.clients) client.close();
      this.clients.clear();
      this.clientSubscriptions.clear();
    }
    if (!this.httpServer) return;
    const server = this.httpServer;
    this.httpServer = null;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  handleUpgrade(req, socket) {
    const url = new URL(req.url, "http://localhost");
    const isClient = url.pathname === "/client";
    if (!isClient && url.pathname !== "/bridge" && !url.pathname.startsWith("/bridge/")) {
      socket.destroy();
      return;
    }
    if (this.token && url.searchParams.get("token") !== this.token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }
    const gameKey = decodeURIComponent(url.pathname.slice("/bridge/".length)) || "unknown";
    const handshake = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      "\r\n"
    ].join("\r\n");
    socket.write(handshake);

    const connection = new WebSocketConnection(socket);

    if (isClient) {
      this.attachClient(connection);
      return;
    }

    const previous = this.sessions.get(gameKey);
    if (previous) previous.drop("replaced by a new bridge connection");

    const session = new Session(gameKey, connection, this);
    this.sessions.set(gameKey, session);
    connection.onmessage = (text) => session.handleMessage(text);
    connection.onclose = () => {
      session.clearPingDeadline();
      if (this.sessions.get(gameKey) === session) this.sessions.delete(gameKey);
      this.emit("session-closed", gameKey);
    };

    session.sendJson({ t: "hello", ok: true });
    this.emit("session-open", gameKey);
  }

  pingAll() {
    for (const session of this.sessions.values()) session.ping();
  }

  // --- /client control channel ------------------------------------------------

  attachClient(connection) {
    connection.onmessage = (text) => this.handleClientMessage(connection, text);
    connection.onclose = () => {
      this.clients.delete(connection);
      for (const event of this.clientSubscriptions.get(connection) || []) {
        this.removeClientListener(event, connection);
      }
      this.clientSubscriptions.delete(connection);
    };
    if (!this.clients) this.clients = new Set();
    if (!this.clientSubscriptions) this.clientSubscriptions = new Map();
    this.clients.add(connection);
    this.clientSubscriptions.set(connection, new Set());
    connection.sendJson({ t: "welcome", sessions: this.listSessions() });
  }

  handleClientMessage(connection, text) {
    let message = null;
    try {
      message = JSON.parse(text);
    } catch (_) {
      return;
    }
    if (!message || typeof message !== "object") return;
    switch (message.t) {
      case "list":
        connection.sendJson({ t: "list", sessions: this.listSessions() });
        break;
      case "watch": {
        const subs = this.clientSubscriptions.get(connection);
        if (subs) subs.add("state");
        break;
      }
      case "send": {
        const { gameKey, type, args } = message;
        this.sendCommand(gameKey, type, args || {})
          .then((payload) => connection.sendJson({ t: "result", id: message.id, ok: true, gameKey, payload }))
          .catch((error) => connection.sendJson({
            t: "result", id: message.id, ok: false, gameKey,
            error: String(error && error.message || error)
          }));
        break;
      }
      default:
        break;
    }
  }

  broadcastToClients(value) {
    if (!this.clients) return;
    for (const client of this.clients) {
      const subs = this.clientSubscriptions.get(client);
      if (subs && subs.has("state")) client.sendJson(value);
    }
  }

  addClientListener(event, connection) {
    if (!this.clientListeners) this.clientListeners = new Map();
    if (!this.clientListeners.has(event)) this.clientListeners.set(event, new Set());
    this.clientListeners.get(event).add(connection);
  }

  removeClientListener(event, connection) {
    const listeners = this.clientListeners && this.clientListeners.get(event);
    if (listeners) listeners.delete(connection);
  }

  session(gameKey) {
    return this.sessions.get(gameKey) || null;
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((session) => session.describe());
  }

  sendCommand(gameKey, type, args = {}, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
    const session = this.sessions.get(gameKey);
    if (!session) {
      return Promise.reject(new BridgeServerError(`no running bridge for "${gameKey}"`));
    }
    return session.sendCommand(type, args, timeoutMs);
  }
}

class Session {
  constructor(gameKey, connection, server) {
    this.gameKey = gameKey;
    this.connection = connection;
    this.server = server;
    this.info = { gameKey, bridgeVersion: null, engine: null, connectedAt: Date.now() };
    this.state = null;
    this.pending = new Map();
    this.lastPongAt = Date.now();
    this.pingDeadline = null;
  }

  describe() {
    return { ...this.info, alive: !!this.connection && !this.connection.closed, state: this.state };
  }

  sendJson(value) {
    return this.connection.sendJson(value);
  }

  ping() {
    if (!this.sendJson({ t: "ping" })) return;
    clearTimeout(this.pingDeadline);
    this.pingDeadline = setTimeout(() => {
      if (Date.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
        this.drop("pong timeout");
      }
    }, PONG_TIMEOUT_MS);
    this.pingDeadline.unref?.();
  }

  clearPingDeadline() {
    clearTimeout(this.pingDeadline);
  }

  drop(reason) {
    for (const entry of this.pending.values()) {
      entry.reject(new BridgeServerError(`bridge connection dropped: ${reason}`));
    }
    this.pending.clear();
    this.connection.close();
  }

  handleMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch (_) {
      return;
    }
    if (!message || typeof message !== "object") return;
    switch (message.t) {
      case "hello":
        this.info.bridgeVersion = message.bridgeVersion || null;
        this.info.engine = message.engine || null;
        this.server.emit("bridge-info", this.gameKey, this.info);
        break;
      case "pong":
        this.lastPongAt = Date.now();
        break;
      case "state":
        this.state = message.state || null;
        this.server.emit("state", this.gameKey, this.state);
        this.server.broadcastToClients({ t: "state", gameKey: this.gameKey, state: this.state });
        break;
      case "result": {
        const entry = this.pending.get(message.id);
        if (!entry) break;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.payload);
        else entry.reject(new BridgeServerError(message.error || "command failed"));
        break;
      }
      default:
        break;
    }
  }

  sendCommand(type, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = `c${this.server.nextCommandId++}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeServerError(`command "${type}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      if (!this.sendJson({ t: "cmd", id, type, args })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeServerError("bridge connection is closed"));
        return;
      }
    });
  }

  rejectAll(reason) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeServerError(reason));
    }
    this.pending.clear();
  }
}
