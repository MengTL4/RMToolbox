// rmch send: deliver one command to a running bridge.
// Primary path: connect to the local server's /client channel and forward the
// command. Fallback: append to the game's commands.jsonl queue (works even
// when no server is running, because the bridge polls the file too).

import net from "node:net";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { scanGame } from "../core/scanner.mjs";
import { getToken } from "../core/token.mjs";
import { ensureServer } from "../core/launcher.mjs";

function portInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1200, () => done(false));
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}

function sendViaServer({ port, token, gameKey, type, args, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${port}/client?token=${encodeURIComponent(token)}`);
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      try { socket.close(); } catch (_) {}
      reject(new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.onopen = () => {
      socket.send(JSON.stringify({ t: "send", id: randomUUID(), gameKey, type, args }));
    };
    socket.onmessage = (event) => {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      if (!message || message.t !== "result") return;
      clearTimeout(timer);
      try { socket.close(); } catch (_) {}
      if (message.ok) resolve({ channel: "ws", payload: message.payload });
      else reject(new Error(message.error || "command failed"));
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("cannot connect to the RMCH server"));
    };
  });
}

function sendViaFile({ projectRoot, gameKey, type, args }) {
  const bridgeDir = path.join(projectRoot, "runtime", "bridge-state", gameKey);
  mkdirSync(bridgeDir, { recursive: true });
  const command = {
    commandId: randomUUID(),
    ts: Date.now(),
    type,
    args
  };
  appendFileSync(path.join(bridgeDir, "commands.jsonl"), JSON.stringify(command) + "\n", "utf8");
  return { channel: "file", queued: command };
}

export async function sendCommand({ projectRoot, target, type, args, port = 47412, timeoutMs = 15000 }) {
  let gameKey = null;
  let gameRoot = null;
  if (existsSync(target) && existsSync(path.join(target, "Game.exe"))) {
    const scan = scanGame(target);
    gameKey = scan.gameKey;
    gameRoot = scan.root;
  } else {
    gameKey = target;
  }

  const token = getToken(projectRoot);
  if (await portInUse(port)) {
    try {
      return await sendViaServer({ port, token, gameKey, type, args, timeoutMs });
    } catch (error) {
      // Only fall back to the file queue when the server itself is unreachable;
      // a command failure (bridge rejected it) must propagate to the caller.
      if (!/cannot connect to the RMCH server/.test(String(error.message))) throw error;
    }
  } else if (gameRoot) {
    // No server running: the launcher normally starts one; if the game was
    // started manually, still try to boot it so the WS path works.
    await ensureServer({ projectRoot, port, token });
    try {
      return await sendViaServer({ port, token, gameKey, type, args, timeoutMs });
    } catch (error) {
      // fall through to the file queue
    }
  }
  return sendViaFile({ projectRoot, gameKey, type, args });
}
