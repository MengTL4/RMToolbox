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
import { appendFileSync, existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { prepareRgssGame, RgssError } from "./rgss.mjs";
import { rgssContentsCode } from "./rgss-savecode.mjs";
import { externalSessions } from "./bridge-sessions.mjs";
import { JsonlReader } from "./jsonl-reader.mjs";
import { reconcileRgssSaves, recordRgssSaveLocation } from "./save-files.mjs";

export class RgssLaunchError extends Error {}

const COMMAND_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 60000;
const POLL_INTERVAL_MS = 40;

// Live sessions by gameKey, so the GUI host can route commands to them the
// same way it routes WebSocket sessions for MV/MZ.
export function getRgssSession(gameKey) {
  return externalSessions.get("rgss", gameKey);
}

export function listRgssSessions() {
  return externalSessions.list("rgss");
}

function syncSavesBack(shadowRoot, gameRoot, options = {}) {
  const result = reconcileRgssSaves({ shadowRoot, gameRoot, ...options });
  if (result.conflicts.length || result.errors.length) {
    const message = `RGSS 存档回流：${result.conflicts.length} 个同时间冲突（保留真实存档），${result.errors.length} 个文件失败。`;
    console.warn(message, result);
    // GUI users have no terminal; retain the report in the shared GUI log.
    const projectRoot = path.resolve(shadowRoot, "..", "..", "..");
    try {
      appendFileSync(
        path.join(projectRoot, "runtime", "gui.log"),
        `[${new Date().toISOString()}] ${message} ${JSON.stringify(result)}\n`
      );
    } catch (_) {}
  }
  return result;
}

class RgssSession extends EventEmitter {
  constructor({ dir, gameKey = "rgss", pid = 0 }) {
    super();
    this.dir = dir;
    this.gameKey = gameKey;
    // pid > 0: the game was attached, not launched — there is no child process
    // whose exit cleans the session up, so poll liveness instead.
    this.pid = pid;
    this.cmdPath = path.join(dir, "rmch-cmd.jsonl");
    this.resPath = path.join(dir, "rmch-res.jsonl");
    this.reader = new JsonlReader(this.resPath);
    this.nextId = 1;
    this.pending = new Map();
    this.hello = null;
    this.state = null;
    this.connectedAt = null;
    this.alive = true;
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.timer.unref?.();
    this.pidTimer = null;
    if (this.pid) {
      this.pidTimer = setInterval(() => this.checkPid(), 3000);
      this.pidTimer.unref?.();
    }
  }

  checkPid() {
    // process.kill(pid, 0) probes existence without touching the process;
    // EPERM means it exists but is owned by someone else — still alive.
    let alive;
    try {
      process.kill(this.pid, 0);
      alive = true;
    } catch (error) {
      alive = error && error.code === "EPERM";
    }
    if (!alive) this.teardown();
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
    if (this.pidTimer) clearInterval(this.pidTimer);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("bridge disconnected"));
    }
    this.pending.clear();
    this.emit("close", this);
  }

  poll() {
    try {
      for (const text of this.reader.readLines()) {
        const line = text.trim();
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
    if (!this.alive)
      return Promise.reject(new Error("bridge is not connected"));
    // MV/MZ's save.contents.apply carries {json} for an in-page JsonEx.parse.
    // The RGSS bridge evals generated Ruby source instead (Ruby 1.8.1 has no
    // JSON parser worth the name), so translate here and callers keep the
    // MV/MZ vocabulary. A multi-MB tree can outgrow the default timeout.
    if (
      type === "save.contents.apply" &&
      args &&
      typeof args.json === "string"
    ) {
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
        appendFileSync(
          this.cmdPath,
          JSON.stringify({ t: "cmd", id, type, args }) + "\n"
        );
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
export async function launchRgssGame({
  gameRoot,
  projectRoot,
  gameKey,
  onLaunch
} = {}) {
  if (!gameRoot) throw new RgssLaunchError("gameRoot is required");
  if (!projectRoot) throw new RgssLaunchError("projectRoot is required");

  const resolvedKey = gameKey || path.basename(gameRoot);

  // Rebuild from scratch every launch: the shadow accumulates patched-archive
  // bytes otherwise. Rescue any in-shadow saves first -- they only exist here
  // if the previous run died before its exit-time sync.
  const shadowRoot = path.join(
    projectRoot,
    "runtime",
    "rgss-shadow",
    resolvedKey
  );
  if (existsSync(shadowRoot)) {
    const recovered = syncSavesBack(shadowRoot, gameRoot);
    if (recovered.errors.length)
      throw new RgssLaunchError(
        "存档回流失败，已保留影子目录；请查看 runtime/gui.log 后重试。"
      );
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
    throw error instanceof RgssError
      ? new RgssLaunchError(error.message)
      : error;
  }

  const session = new RgssSession({
    dir: prepared.shadowRoot,
    gameKey: resolvedKey
  });
  let recordedSaveLocation = "";
  session.on("state", (state) => {
    if (state && state.saveLocation) {
      const encoded = JSON.stringify(state.saveLocation);
      if (encoded === recordedSaveLocation) return;
      try {
        recordRgssSaveLocation(prepared.shadowRoot, state.saveLocation);
        recordedSaveLocation = encoded;
      } catch (error) {
        console.warn("Could not retain RGSS save location:", error.message);
      }
    }
  });

  // Spawn BEFORE arming the connect timeout, so the timeout handler can report
  // whether the game process is still alive. That is the fact that separates the
  // two very different failures behind this one message: the game died on
  // startup (nothing to wait for), or it is running but never reached the scene
  // loop that starts the bridge.
  const child = spawn(prepared.exe, [], {
    cwd: prepared.shadowRoot,
    windowsHide: false,
    stdio: "ignore",
    detached: false
  });
  child.on("error", (error) => session.emit("error", error));
  if (onLaunch) onLaunch(child, prepared);

  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.close();
      // The bridge only starts once the game reaches its scene loop. A game
      // stuck on a missing RTP (audio/graphics load failure on the title
      // screen) never gets there, so say so instead of a bare timeout.
      const rtpHint = prepared.detect.rtp.length
        ? `; Game.ini declares RTP "${prepared.detect.rtp.join(", ")}" — if the game is stuck before the title screen, install the RTP first (https://rpgmakerweb.com/run-time-package)`
        : "";
      // Did the bridge script even run? It creates these on startup, so a
      // missing file means the script never executed (patch not applied, or the
      // game died earlier); an untouched file means it started but stopped.
      const bridgeFiles = [session.cmdPath, session.resPath]
        .map((file) => {
          try {
            return `${path.basename(file)}=${statSync(file).size}B`;
          } catch {
            return `${path.basename(file)}=absent`;
          }
        })
        .join(" ");
      const exit = child.exitCode;
      const state =
        exit !== null
          ? `game process exited with code ${exit}`
          : "game process is still running";
      reject(
        new RgssLaunchError(
          `timed out waiting for the injected bridge to start (${state}; ${bridgeFiles})${rtpHint}`
        )
      );
    }, CONNECT_TIMEOUT_MS);
    session.once("hello", () => {
      clearTimeout(timer);
      resolve(session);
    });
  });

  try {
    await connected;
  } catch (error) {
    try {
      child.kill();
    } catch (_) {}
    session.close();
    throw error;
  }

  externalSessions.register("rgss", session);
  child.on("exit", () => {
    // Clean exit: anchor the saves, then drop the shadow copies so a file the
    // user deletes later is not resurrected from the stale shadow. Abnormal
    // toolbox deaths skip this entirely, which is exactly the case the
    // launch-time rescue above covers.
    syncSavesBack(prepared.shadowRoot, gameRoot, {
      saveLocation: session.state && session.state.saveLocation,
      removeSynced: true
    });
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
      // The exit handler runs after the process has stopped writing. Syncing
      // immediately after kill() races the final in-game save.
      session.close();
    }
  };
}

/**
 * Adopt a bridge that appeared in `dir` because we ATTACHED to a running game
 * (core/attach.mjs) instead of launching one. Same session registry and
 * hello-wait as launchRgssGame, but there is no child process: the game pid's
 * liveness drives teardown, and the game writes its own saves, so no save
 * sync happens here.
 */
export async function adoptRgssSession({ dir, gameKey, pid }) {
  const session = new RgssSession({ dir, gameKey, pid });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.close();
      reject(
        new RgssLaunchError(
          "timed out waiting for the attached bridge to start"
        )
      );
    }, CONNECT_TIMEOUT_MS);
    session.once("hello", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  externalSessions.register("rgss", session);
  return session;
}

export { RgssSession, RgssError };
