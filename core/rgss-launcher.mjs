// Launcher for RGSS games: prepare a shadow copy, inject the bridge, start the
// game, and talk to it.
//
// The channel is a pair of append-only files inside the shadow directory rather
// than a socket: RGSS ships a Ruby without the socket library. Win32API can
// reach ws2_32 (verified working, including recv readback), but a blocking recv
// would freeze the game loop, so the file channel's worst case -- a stalled
// command with the game still running -- wins. Both sides track a read offset,
// so nothing is deleted or rewritten. Latency is one game frame plus the poll
// interval, which is far below what a trainer needs.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, openSync, readSync, closeSync, statSync, lstatSync, mkdirSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import { prepareRgssGame, RgssError } from "./rgss.mjs";
import { rgssContentsCode } from "./rgss-savecode.mjs";

export class RgssLaunchError extends Error {}

const COMMAND_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 60000;
const POLL_INTERVAL_MS = 40;

// Live sessions by gameKey, so the GUI host can route commands to them the
// same way it routes WebSocket sessions for MV/MZ.
const rgssSessions = new Map();

export function getRgssSession(gameKey) {
  return rgssSessions.get(gameKey) || null;
}

export function listRgssSessions() {
  return [...rgssSessions.values()].map((session) => session.describe());
}

// In-game saves land in the shadow copy (that is the game's cwd). Anything not
// anchored back would vanish with the next shadow rebuild, so when the game
// exits, copy save files back into the real game directory. Custom save
// systems may use a subdirectory (e.g. SaveData/) — when that subdirectory is
// a real directory in the shadow rather than a junction to the original,
// sync one level down as well.
const SAVE_FILE_RE = /^save\d+\.(rxdata|rvdata|rvdata2)$/i;

// removeSynced deletes each shadow file once the real directory holds an
// up-to-date copy. Without it a save deleted from the real directory while
// the game is not running would be resurrected by the next launch's rescue
// sync, because its shadow copy was still sitting there.
function syncSaveDir(shadowDir, realDir, { removeSynced = false } = {}) {
  let copied = 0;
  let entries = [];
  try {
    entries = readdirSync(shadowDir);
  } catch (_) {
    return copied;
  }
  for (const entry of entries) {
    if (!SAVE_FILE_RE.test(entry)) continue;
    const source = path.join(shadowDir, entry);
    const target = path.join(realDir, entry);
    try {
      const sourceStat = statSync(source);
      if (!sourceStat.isFile()) continue;
      const targetStat = existsSync(target) ? statSync(target) : null;
      if (!(targetStat && targetStat.size === sourceStat.size && targetStat.mtimeMs >= sourceStat.mtimeMs)) {
        mkdirSync(realDir, { recursive: true });
        copyFileSync(source, target);
        copied += 1;
      }
      // Shadow-root files are hardlinks or shadow-only copies, so removing
      // them never touches the real file; junctioned subdirectories never
      // reach this function (syncSavesBack skips them).
      if (removeSynced) rmSync(source, { force: true });
    } catch (_) {}
  }
  return copied;
}

function syncSavesBack(shadowRoot, gameRoot, { removeSynced = false } = {}) {
  let copied = syncSaveDir(shadowRoot, gameRoot, { removeSynced });
  try {
    for (const entry of readdirSync(shadowRoot)) {
      const sub = path.join(shadowRoot, entry);
      const stat = lstatSync(sub);
      // Junctions point into the real game already — writes pass through.
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      copied += syncSaveDir(sub, path.join(gameRoot, entry), { removeSynced });
    }
  } catch (_) {}
  return copied;
}

class RgssSession extends EventEmitter {
  constructor({ dir, gameKey = "rgss" }) {
    super();
    this.dir = dir;
    this.gameKey = gameKey;
    this.cmdPath = path.join(dir, "rmch-cmd.jsonl");
    this.resPath = path.join(dir, "rmch-res.jsonl");
    this.resOffset = 0;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.hello = null;
    this.state = null;
    this.connectedAt = null;
    this.alive = true;
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  describe() {
    return {
      gameKey: this.gameKey,
      alive: this.alive && !!this.hello,
      bridgeVersion: this.hello ? this.hello.version : null,
      engine: this.hello ? this.hello.engine : null,
      connectedAt: this.connectedAt,
      state: this.state
    };
  }

  teardown() {
    if (!this.alive) return;
    this.alive = false;
    clearInterval(this.timer);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("bridge disconnected"));
    }
    this.pending.clear();
    this.emit("close", this);
  }

  poll() {
    try {
      if (!existsSync(this.resPath)) return;
      const size = statSync(this.resPath).size;
      if (size <= this.resOffset) return;
      const fd = openSync(this.resPath, "r");
      const length = size - this.resOffset;
      const chunk = Buffer.allocUnsafe(length);
      readSync(fd, chunk, 0, length, this.resOffset);
      closeSync(fd);
      this.resOffset = size;
      this.buffer += chunk.toString("utf8");

      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        newline = this.buffer.indexOf("\n");
        if (line) this.handleLine(line);
      }
    } catch (_) {
      // The game may be mid-write; try again next tick.
    }
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      return;
    }
    if (message.t === "hello") {
      this.hello = message;
      this.connectedAt = Date.now();
      this.emit("hello", message);
      return;
    }
    if (message.t === "state") {
      this.state = message.state || null;
      this.emit("state", this.state);
      return;
    }
    if (message.t === "event") {
      this.emit("event", message);
      return;
    }
    if (message.t === "result" && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.payload);
      else entry.reject(new Error(message.error || "bridge command failed"));
    }
  }

  send(type, args = {}, timeout = COMMAND_TIMEOUT_MS) {
    if (!this.alive) return Promise.reject(new Error("bridge is not connected"));
    // MV/MZ's save.contents.apply carries {json} for an in-page JsonEx.parse.
    // The RGSS bridge evals generated Ruby source instead (Ruby 1.8.1 has no
    // JSON parser worth the name), so translate here and callers keep the
    // MV/MZ vocabulary. A multi-MB tree can outgrow the default timeout.
    if (type === "save.contents.apply" && args && typeof args.json === "string") {
      args = { code: rgssContentsCode(args.json), reload: args.reload };
      timeout = Math.max(timeout, 120000);
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`command timed out: ${type}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        appendFileSync(this.cmdPath, JSON.stringify({ t: "cmd", id, type, args }) + "\n");
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  close() {
    clearInterval(this.timer);
    this.teardown();
  }
}

/**
 * Prepare, launch, and wait for the bridge to announce itself.
 */
export async function launchRgssGame({ gameRoot, projectRoot, gameKey, onLaunch } = {}) {
  if (!gameRoot) throw new RgssLaunchError("gameRoot is required");
  if (!projectRoot) throw new RgssLaunchError("projectRoot is required");

  const resolvedKey = gameKey || path.basename(gameRoot);

  // Rebuild from scratch every launch: the shadow accumulates patched-archive
  // bytes otherwise. Rescue any in-shadow saves first -- they only exist here
  // if the previous run died before its exit-time sync.
  const shadowRoot = path.join(projectRoot, "runtime", "rgss-shadow", resolvedKey);
  if (existsSync(shadowRoot)) {
    syncSavesBack(shadowRoot, gameRoot);
    rmSync(shadowRoot, { recursive: true, force: true });
  }

  let prepared;
  try {
    prepared = prepareRgssGame({
      gameRoot,
      projectRoot,
      gameKey: resolvedKey,
      // port/token are substituted into the bridge but unused by the file
      // channel; they are reserved for a possible TCP transport.
      port: 0,
      token: ""
    });
  } catch (error) {
    throw error instanceof RgssError ? new RgssLaunchError(error.message) : error;
  }

  const session = new RgssSession({ dir: prepared.shadowRoot, gameKey: resolvedKey });

  const unregister = () => {
    if (rgssSessions.get(resolvedKey) === session) rgssSessions.delete(resolvedKey);
  };
  session.on("close", unregister);

  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.close();
      // The bridge only starts once the game reaches its scene loop. A game
      // stuck on a missing RTP (audio/graphics load failure on the title
      // screen) never gets there, so say so instead of a bare timeout.
      const rtpHint = prepared.detect.rtp.length
        ? `; Game.ini declares RTP "${prepared.detect.rtp.join(", ")}" — if the game is stuck before the title screen, install the RTP first (https://rpgmakerweb.com/run-time-package)`
        : "";
      reject(new RgssLaunchError(`timed out waiting for the injected bridge to start${rtpHint}`));
    }, CONNECT_TIMEOUT_MS);
    session.once("hello", () => {
      clearTimeout(timer);
      resolve(session);
    });
  });

  const child = spawn(prepared.exe, [], {
    cwd: prepared.shadowRoot,
    windowsHide: false,
    stdio: "ignore",
    detached: false
  });
  child.on("error", (error) => session.emit("error", error));
  if (onLaunch) onLaunch(child, prepared);

  try {
    await connected;
  } catch (error) {
    try {
      child.kill();
    } catch (_) {}
    session.close();
    throw error;
  }

  rgssSessions.set(resolvedKey, session);
  child.on("exit", () => {
    // Clean exit: anchor the saves, then drop the shadow copies so a file the
    // user deletes later is not resurrected from the stale shadow. Abnormal
    // toolbox deaths skip this entirely, which is exactly the case the
    // launch-time rescue above covers.
    syncSavesBack(prepared.shadowRoot, gameRoot, { removeSynced: true });
    session.close();
  });

  return {
    session,
    child,
    prepared,
    gameKey: resolvedKey,
    stop() {
      try {
        child.kill();
      } catch (_) {}
      syncSavesBack(prepared.shadowRoot, gameRoot, { removeSynced: true });
      session.close();
    }
  };
}

export { RgssSession, RgssError };
