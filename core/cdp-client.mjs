// Minimal Chrome DevTools Protocol client for talking to WebView2/Chromium
// targets (Tauri-shelled games in particular). Zero dependencies, same as
// tools/cdp.mjs — that one is a CLI for GUI self-checks, this one is the
// library the Tauri launcher (core/tauri-cdp.mjs) builds on.
//
// Only what the launcher needs: HTTP /json listing, a RFC6455 client,
// Runtime.evaluate with awaitPromise, and event dispatch.

import net from "node:net";
import crypto from "node:crypto";

export class CdpError extends Error {}

// The DevTools HTTP endpoint keeps the socket open regardless of
// `Connection: close`, so resolve on Content-Length rather than on "end".
export function httpGet(port, pathname, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let raw = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new CdpError(`GET ${pathname} timed out`));
    }, timeoutMs);
    const tryFinish = () => {
      const split = raw.indexOf("\r\n\r\n");
      if (split === -1) return;
      const match = /content-length:\s*(\d+)/i.exec(raw.slice(0, split));
      if (!match) return;
      const body = raw.slice(split + 4);
      if (Buffer.byteLength(body) < Number(match[1])) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(body);
    };
    socket.on("data", (chunk) => {
      raw += chunk;
      tryFinish();
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function listTargets(port, timeoutMs) {
  const body = await httpGet(port, "/json/list", timeoutMs);
  try {
    return JSON.parse(body);
  } catch (_) {
    throw new CdpError(`no CDP endpoint on 127.0.0.1:${port}`);
  }
}

// --- minimal RFC6455 client (mirrors tools/cdp.mjs) ----------------------------

class WsClient {
  constructor(url) {
    const parsed = new URL(url);
    this.host = parsed.hostname;
    this.port = Number(parsed.port || 80);
    this.path = parsed.pathname + parsed.search;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.onMessage = null;
    this.onClose = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      this.socket = net.connect(this.port, this.host, () => {
        this.socket.write(
          `GET ${this.path} HTTP/1.1\r\n` +
            `Host: ${this.host}:${this.port}\r\n` +
            "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      this.socket.on("error", reject);
      this.socket.on("close", () => {
        if (this.onClose) this.onClose();
      });

      const onHandshake = (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = this.buffer.slice(0, end).toString("latin1");
        if (!/^HTTP\/1\.1 101/.test(head)) {
          reject(new CdpError("websocket upgrade refused: " + head.split("\r\n")[0]));
          return;
        }
        this.buffer = this.buffer.slice(end + 4);
        this.socket.removeListener("data", onHandshake);
        this.socket.on("data", (next) => {
          this.buffer = Buffer.concat([this.buffer, next]);
          this.drain();
        });
        this.drain();
        resolve();
      };
      this.socket.on("data", onHandshake);
    });
  }

  drain() {
    for (;;) {
      const frame = this.readFrame();
      if (!frame) return;
      if (frame.opcode === 0x8) {
        this.socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        this.send(frame.payload, 0xa);
        continue;
      }
      if (frame.opcode === 0xa) continue;

      if (frame.opcode === 0x0) {
        this.fragments.push(frame.payload);
      } else {
        this.fragments = [frame.payload];
        this.fragmentOpcode = frame.opcode;
      }
      if (!frame.fin) continue;

      const payload = Buffer.concat(this.fragments);
      this.fragments = [];
      if (this.fragmentOpcode === 0x1 && this.onMessage) this.onMessage(payload.toString("utf8"));
    }
  }

  readFrame() {
    if (this.buffer.length < 2) return null;
    const first = this.buffer[0];
    const second = this.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (this.buffer.length < offset + 2) return null;
      length = this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (this.buffer.length < offset + 8) return null;
      const big = this.buffer.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("frame too large");
      length = Number(big);
      offset += 8;
    }
    const maskKey = masked ? this.buffer.slice(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (this.buffer.length < offset + length) return null;

    let payload = this.buffer.slice(offset, offset + length);
    if (maskKey) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
    }
    this.buffer = this.buffer.slice(offset + length);
    return { fin, opcode, payload };
  }

  // Client frames must be masked (RFC6455 §5.3).
  send(data, opcode = 0x1) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    const mask = crypto.randomBytes(4);
    const header = [];
    header.push(0x80 | opcode);
    if (payload.length < 126) {
      header.push(0x80 | payload.length);
    } else if (payload.length < 0x10000) {
      header.push(0x80 | 126, payload.length >> 8, payload.length & 0xff);
    } else {
      header.push(0x80 | 127, 0, 0, 0, 0,
        (payload.length >>> 24) & 0xff, (payload.length >>> 16) & 0xff,
        (payload.length >>> 8) & 0xff, payload.length & 0xff);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([Buffer.from(header), mask, masked]));
  }

  close() {
    try {
      this.send(Buffer.alloc(0), 0x8);
    } catch (_) {}
    try {
      this.socket.end();
    } catch (_) {}
  }
}

// --- CDP session ---------------------------------------------------------------

// Connects to a page target on `port`. `matchUrl` optionally pins the page
// (a Tauri game serves https://tauri.localhost/); without it the first page
// target wins. `onEvent(method, params)` receives unsolicited CDP events —
// diagnostics only: the Tauri transport avoids enabling any domain because
// Runtime.enable is a watchdog kill trigger (see core/tauri-cdp.mjs).
export async function openCdpSession({ port, matchUrl = null, timeoutMs = 30000, onEvent = null }) {
  const targets = await listTargets(port);
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const page = matchUrl
    ? pages.find((t) => String(t.url || "").startsWith(matchUrl))
    : pages[0];
  if (!page) {
    throw new CdpError(
      `no debuggable page target${matchUrl ? ` matching ${matchUrl}` : ""} on 127.0.0.1:${port} ` +
        `(pages: ${pages.map((t) => t.url).join(", ") || "none"})`
    );
  }

  const ws = new WsClient(page.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  ws.onMessage = (text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch (_) {
      return;
    }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new CdpError(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
    } else if (message.method && onEvent) {
      try {
        onEvent(message.method, message.params || {});
      } catch (_) {}
    }
  };
  await ws.connect();

  function call(method, params, callTimeoutMs) {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CdpError(method + " timed out"));
      }, callTimeoutMs || timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  async function evaluate(expression, evalTimeoutMs) {
    const result = await call(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      evalTimeoutMs
    );
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new CdpError("page threw: " + ((detail.exception && detail.exception.description) || detail.text));
    }
    return result.result ? result.result.value : undefined;
  }

  const session = {
    target: page,
    call,
    evaluate,
    onClose: null, // assignable; fired when the devtools socket drops
    close: () => ws.close(),
    _ws: ws
  };
  ws.onClose = () => {
    if (session.onClose) session.onClose();
  };
  return session;
}
