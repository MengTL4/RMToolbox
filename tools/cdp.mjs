// Minimal Chrome DevTools Protocol client — zero dependencies, matching the
// rest of the project. Used to verify the NW.js GUI actually renders: probe the
// live DOM and capture screenshots without a browser automation stack.
//
//   node tools/cdp.mjs eval "document.title"
//   node tools/cdp.mjs eval-file probe.js
//   node tools/cdp.mjs click ".n-dropdown-option"      (trusted mouse events)
//   node tools/cdp.mjs rclick ".jsoneditor-value"
//   node tools/cdp.mjs type "54321"                    (into whatever has focus)
//   node tools/cdp.mjs key "ctrl+shift+z"              (real key events)
//   node tools/cdp.mjs shot runtime/screenshots/gui.png [width] [height]
//   node tools/cdp.mjs targets
//
// Requires the target to be launched with --remote-debugging-port=<port>
// (default 9222, override with RMCH_CDP_PORT).

import net from "node:net";
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.RMCH_CDP_PORT || 9222);

// --- HTTP helper (the /json endpoints are plain HTTP) -------------------------

// The DevTools HTTP endpoint keeps the socket open regardless of
// `Connection: close`, so resolve on Content-Length rather than on "end".
function httpGet(pathname) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, "127.0.0.1", () => {
      socket.write(`GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n\r\n`);
    });
    let raw = "";
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(null, new Error(`timed out reading ${pathname} from 127.0.0.1:${PORT}`));
    }, 8000);

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      raw += chunk;
      const split = raw.indexOf("\r\n\r\n");
      if (split === -1) return;
      const head = raw.slice(0, split);
      const body = raw.slice(split + 4);
      const match = /content-length:\s*(\d+)/i.exec(head);
      if (match && Buffer.byteLength(body, "utf8") >= Number(match[1])) finish(body);
    });
    socket.on("end", () => {
      const split = raw.indexOf("\r\n\r\n");
      finish(split === -1 ? "" : raw.slice(split + 4));
    });
    socket.on("error", (error) => finish(null, error));
  });
}

// --- minimal RFC6455 client --------------------------------------------------

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

      const onHandshake = (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = this.buffer.slice(0, end).toString("latin1");
        if (!/^HTTP\/1\.1 101/.test(head)) {
          reject(new Error("websocket upgrade refused: " + head.split("\r\n")[0]));
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
      if (frame.opcode === 0x8) { this.socket.end(); return; }
      if (frame.opcode === 0x9) { this.send(frame.payload, 0xa); continue; }
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
    try { this.send(Buffer.alloc(0), 0x8); } catch (_) {}
    try { this.socket.end(); } catch (_) {}
  }
}

// --- CDP session -------------------------------------------------------------

async function openSession() {
  const listing = await httpGet("/json/list");
  let targets;
  try {
    targets = JSON.parse(listing);
  } catch (_) {
    throw new Error(`no CDP endpoint on 127.0.0.1:${PORT} — launch with --remote-debugging-port=${PORT}`);
  }
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("no debuggable page target found");

  const ws = new WsClient(page.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  ws.onMessage = (text) => {
    let message;
    try { message = JSON.parse(text); } catch (_) { return; }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result);
    }
  };
  await ws.connect();

  function call(method, params, timeoutMs) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      // The timer must be cleared on settle, or a pending 30s handle keeps the
      // process alive long after the command answered.
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(method + " timed out"));
      }, timeoutMs || 30000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  return { target: page, call, close: () => ws.close() };
}

async function evaluate(session, expression) {
  const result = await session.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails;
    throw new Error("page threw: " + (detail.exception?.description || detail.text));
  }
  return result.result.value;
}

// Naive UI's popovers ignore synthetic MouseEvents dispatched from page script,
// so UI verification needs trusted input. Resolve a selector to its centre and
// dispatch real mouse events there.
async function clickSelector(session, selector, button) {
  const box = await evaluate(session, `
    (function () {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()
  `);
  if (!box) throw new Error(`selector matched nothing visible: ${selector}`);
  await dispatchClick(session, box.x, box.y, button);
  return box;
}

async function dispatchClick(session, x, y, button) {
  const which = button || "left";
  const common = { x, y, button: which, clickCount: 1, buttons: which === "right" ? 2 : 1 };
  await session.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  await session.call("Input.dispatchMouseEvent", { ...common, type: "mousePressed" });
  await session.call("Input.dispatchMouseEvent", { ...common, type: "mouseReleased" });
}

// Named keys beyond the printable set, with the codes ace/jsoneditor expect.
const NAMED_KEYS = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  insert: { key: "Insert", code: "Insert", vk: 45 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
};

async function dispatchCombo(session, combo) {
  const parts = combo.split("+").map((s) => s.trim()).filter(Boolean);
  const keyName = parts.pop();
  const MODIFIERS = { ctrl: 2, control: 2, alt: 1, shift: 8, meta: 4, cmd: 4, win: 4 };
  let modifiers = 0;
  for (const part of parts) {
    if (!(part in MODIFIERS)) throw new Error(`unknown modifier "${part}" in "${combo}"`);
    modifiers |= MODIFIERS[part];
  }

  let def;
  const fn = keyName.match(/^f([1-9]|1[0-2])$/);
  if (keyName.length === 1) {
    const vk = keyName.toUpperCase().charCodeAt(0);
    def = {
      key: keyName,
      code: /^[a-z]$/.test(keyName) ? "Key" + keyName.toUpperCase()
        : (/^[0-9]$/.test(keyName) ? "Digit" + keyName : undefined),
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      // With ctrl/alt/meta held the keystroke is a command, not text input.
      text: modifiers & ~8 ? undefined : keyName,
    };
  } else if (fn) {
    const vk = 111 + Number(fn[1]);
    def = { key: keyName.toUpperCase(), code: keyName.toUpperCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  } else if (keyName in NAMED_KEYS) {
    const named = NAMED_KEYS[keyName];
    def = {
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.vk,
      nativeVirtualKeyCode: named.vk,
      text: modifiers ? undefined : named.text,
    };
  } else {
    throw new Error(`unknown key "${keyName}"`);
  }

  await session.call("Input.dispatchKeyEvent", { type: "keyDown", modifiers, ...def });
  await session.call("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...def });
}

// --- CLI ---------------------------------------------------------------------

const [command, ...args] = process.argv.slice(2);

let session = null;

try {
  if (command === "targets") {
    console.log(await httpGet("/json/list"));
    process.exit(0);
  }

  session = await openSession();

  if (command === "eval" || command === "eval-file") {
    const expression = command === "eval" ? args.join(" ") : readFileSync(args[0], "utf8");
    const value = await evaluate(session, expression);
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  } else if (command === "click" || command === "rclick") {
    const selector = args.join(" ");
    if (!selector) throw new Error("click needs a CSS selector");
    const box = await clickSelector(session, selector, command === "rclick" ? "right" : "left");
    console.log(`clicked ${selector} at ${box.x},${box.y}`);
  } else if (command === "type") {
    // jsoneditor edits values in contenteditable divs, and setting textContent
    // from page script does not run its input handling. Insert real text.
    const text = args.join(" ");
    if (!text) throw new Error("type needs text");
    await session.call("Input.insertText", { text });
    console.log(`typed ${text.length} char(s)`);
  } else if (command === "key") {
    // "ctrl+shift+z", "enter", "escape" — real key events, same reason as type:
    // jsoneditor's undo stack hangs off the container's keydown handler.
    const combo = (args[0] || "").trim().toLowerCase();
    if (!combo) throw new Error('key needs a combo like "ctrl+z" or "enter"');
    await dispatchCombo(session, combo);
    console.log(`key ${combo}`);
  } else if (command === "shot") {
    const file = args[0] || "runtime/screenshots/gui.png";
    const width = Number(args[1] || 0);
    const height = Number(args[2] || 0);
    // An occluded window has its compositor paused, and captureScreenshot then
    // hands back whatever was last composited — a stale frame. Focus it first.
    // Windows refuses foreground changes requested by a background process, so
    // bringToFront can also just never answer: cap it and move on.
    try {
      await session.call("Page.bringToFront", {}, 4000);
    } catch (_) {
      // Not fatal: a headless, detached or unraisable target has nothing to raise.
    }
    if (width && height) {
      await session.call("Emulation.setDeviceMetricsOverride", {
        width, height, deviceScaleFactor: 1, mobile: false,
      }, 8000);
    }
    // One more frame after focus/resize so the capture sees the settled layout.
    await new Promise((resolve) => setTimeout(resolve, 400));
    // A minimized window never produces a surface frame, so the default capture
    // path waits forever. Fall back to the renderer's own snapshot, which does
    // not need the compositor (it also cannot see GPU layers — fine for DOM UI).
    let shot;
    try {
      shot = await session.call("Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false }, 12000);
    } catch (error) {
      console.error("cdp: surface capture failed (" + error.message + "), retrying fromSurface:false");
      shot = await session.call("Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false, fromSurface: false }, 20000);
    }
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    if (width && height) await session.call("Emulation.clearDeviceMetricsOverride", {}, 8000);
    console.log(`wrote ${file}`);
  } else {
    console.error("usage: cdp.mjs <targets | eval <expr> | eval-file <path> | " +
      "click <selector> | rclick <selector> | type <text> | key <combo> | shot [file] [w] [h]>");
    process.exitCode = 2;
  }
} catch (error) {
  console.error("cdp: " + error.message);
  process.exitCode = 1;
} finally {
  // Without this the error paths kept a live websocket handle and hung the
  // process long after its exit code was set.
  if (session) {
    try { session.close(); } catch (_) {}
  }
}
