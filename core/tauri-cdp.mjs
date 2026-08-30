// Tauri-shelled RPG Maker games (e.g. "YanBin RPG Maker Builder" titles): the
// runtime is real MZ JavaScript, but the shell is a Rust Tauri app on the
// system WebView2 — no NW.js, so neither --load-extension nor DLL injection
// applies, and there is no on-disk www/ to edit.
//
// How we get in instead:
//
//   1. WRY (Tauri's webview layer) hardcodes the WebView2 browser arguments as
//      a plain string in the exe's rodata. We copy game.exe to
//      game.rmch-cdp.exe and overwrite one argument token IN PLACE (same byte
//      length, space-padded) with --remote-debugging-port=<port>. The original
//      exe is never touched; the copy is an extra file Steam ignores.
//   2. Launching the copy makes WebView2 expose Chrome DevTools Protocol on
//      127.0.0.1:<port>. (The WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS env var is
//      NOT honored here: an app's own AdditionalBrowserArguments override it.)
//   3. The page runs under https://tauri.localhost/, and this game family also
//      sabotages loopback with empty --proxy-server= args plus Chromium's
//      mixed-content/PNA blocking — so the bridge's usual WebSocket dial-out
//      CANNOT work from page context. Transport therefore rides the CDP
//      connection itself, but with extreme care: the game's watchdog kills the
//      process within milliseconds of a Runtime.enable call (observed:
//      Inspector.detached, then exit 0). Only Runtime.evaluate is safe. So
//      page→host messages pile into window.__rmchOutbox, drained by host-side
//      evaluate polling; host→page is an evaluate of window.__rmchDispatch(json).
//      Same caution at boot: hitting the DevTools endpoint in the first ~2s
//      after spawn also kills the game, hence BOOT_GRACE_MS below.
//
// The result mirrors RgssSession's interface (describe/send/events) so the GUI
// host routes Tauri sessions exactly like RGSS ones.

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, openSync, readSync, closeSync, readFileSync, statSync, writeSync, readdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { openCdpSession, listTargets } from "./cdp-client.mjs";
import { buildBridge } from "./bridge-bundler.mjs";

export class TauriLaunchError extends Error {}

const COMMAND_TIMEOUT_MS = 15000;
const CDP_WAIT_TIMEOUT_MS = 60000; // first boot of a big game can be slow
const CDP_POLL_MS = 400;
// The WebView2 DevTools server binds BEFORE the app finishes booting, and an
// HTTP hit inside that early window makes this game family exit cleanly
// (observed: /json/list at ~0.4s after spawn kills the process; at ≥2.5s it
// is safe). Keep off the port for a grace period after spawn; override with
// RMCH_TAURI_BOOT_GRACE_MS on slower machines.
const BOOT_GRACE_MS = Number(process.env.RMCH_TAURI_BOOT_GRACE_MS || 5000);

// Verbose launch diagnostics: RMCH_TAURI_DEBUG=1 node ...
const DEBUG = process.env.RMCH_TAURI_DEBUG === "1";
function dbg(...args) {
  if (DEBUG) console.error("[tauri-cdp]", new Date().toISOString().slice(11, 23), ...args);
}

// The WRY default AdditionalBrowserArguments tokens, as found in the exe's
// rodata. Either may be followed by app-specific extras (the YanBin builder
// appends empty --proxy-server=http:// / --proxy-server=socks5:// to sabotage
// network access). A token is a patch slot: it must be replaced by bytes of
// EXACTLY the same length (Rust &str slices carry their length externally).
const PATCH_ANCHORS = [
  "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
  "--autoplay-policy=no-user-gesture-required"
];

// Cheap markers that the exe is a Tauri/WRY app. Both live in early .rdata on
// the observed builder (within the first 8MB); the probe window stays bounded
// so scanning a library folder never reads a whole 150MB binary per game.
const TAURI_MARKERS = ["tauri.localhost", "--disable-features=msWebOOUI"];
const PROBE_WINDOW_BYTES = 16 * 1024 * 1024;

// --- exe probing / patching ----------------------------------------------------

function readPrefix(exePath, maxBytes) {
  const fd = openSync(exePath, "r");
  try {
    const size = Math.min(statSync(exePath).size, maxBytes);
    const buffer = Buffer.alloc(size);
    readSync(fd, buffer, 0, size, 0);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

// Expands a found anchor token to the FULL browser-args string around it. The
// string is a run of printable ASCII (spaces included), bounded by
// non-printable bytes (rodata strings are \0-separated).
//
// Why the whole region, and not just the anchor token: WRY re-joins the
// additional args from an unordered set and the joined result is effectively
// capped at ~105 bytes by the time it reaches the WebView2 loader (verified
// empirically on wry 0.53 / Tauri 2.9: longer strings lose their tail token,
// and WHICH token lands in the cut tail varies per launch). So every original
// token must go — the patched region carries our CDP switch and nothing else.
function expandArgsRegion(buffer, anchorOffset) {
  const printable = (byte) => byte >= 0x20 && byte <= 0x7e;
  let start = anchorOffset;
  while (start > 0 && printable(buffer[start - 1])) start -= 1;
  let end = anchorOffset;
  while (end < buffer.length && printable(buffer[end])) end += 1;
  return { offset: start, length: end - start };
}

// Detect a Tauri/WRY shell and locate the patch region in one pass. Reads the
// whole exe only when `deep` is set (strong external evidence like the YanBin
// arc_* asset dirs); otherwise stops after PROBE_WINDOW_BYTES.
// Returns { isTauri, anchor: {offset, length} | null } — anchor is the full
// browser-args region (see expandArgsRegion), not a single token.
export function probeTauriShell(exePath, { deep = false } = {}) {
  const empty = { isTauri: false, anchor: null };
  let head;
  try {
    head = readPrefix(exePath, PROBE_WINDOW_BYTES);
  } catch (_) {
    return empty;
  }
  const scan = (buffer) => {
    const isTauri = TAURI_MARKERS.every((marker) => buffer.includes(marker));
    if (!isTauri) return null;
    for (const anchor of PATCH_ANCHORS) {
      const offset = buffer.indexOf(anchor);
      if (offset !== -1) return expandArgsRegion(buffer, offset);
    }
    return { offset: -1, length: 0 };
  };
  let found = scan(head);
  if (!found && deep) {
    let full;
    try {
      full = readPrefix(exePath, Number.MAX_SAFE_INTEGER);
    } catch (_) {
      return empty;
    }
    if (full.length > head.length) found = scan(full);
    if (found) return { isTauri: true, anchor: found.offset === -1 ? null : found, buffer: full };
    return { isTauri: TAURI_MARKERS.every((m) => full.includes(m)), anchor: null, buffer: full };
  }
  if (!found) return empty;
  return { isTauri: true, anchor: found.offset === -1 ? null : found };
}

// Builds the replacement bytes for the patch region: our CDP switch plus space
// padding to the region's exact length (Rust &str slices carry their length
// externally, so the byte count must not change). Fails loudly when the port
// cannot fit (never silently corrupts the exe).
export function buildPatchReplacement(regionLength, cdpPort) {
  const replacement = `--remote-debugging-port=${cdpPort}`;
  if (replacement.length > regionLength) {
    throw new TauriLaunchError(`CDP switch does not fit the ${regionLength}-byte patch region`);
  }
  return replacement + " ".repeat(regionLength - replacement.length);
}

// Copies exePath to destPath and patches the args region. Verifies before AND
// after writing — a game update shifts offsets, and writing blind into a
// 150MB binary must never be silent. The region must still contain one of the
// known anchor tokens; we do not patch strings we don't recognize.
export function buildPatchedExe({ exePath, destPath, anchor, cdpPort }) {
  const source = readPrefix(exePath, Number.MAX_SAFE_INTEGER);
  const region = source.toString("latin1", anchor.offset, anchor.offset + anchor.length);
  const printable = /^[\x20-\x7e]+$/;
  const anchorPresent = PATCH_ANCHORS.some((candidate) => region.startsWith(candidate));
  if (!anchorPresent || !printable.test(region)) {
    throw new TauriLaunchError(
      `patch region mismatch at offset ${anchor.offset} (game updated?) — expected a printable args string containing a known anchor, found ${JSON.stringify(region.slice(0, 80))}...`
    );
  }
  copyFileSync(exePath, destPath);
  const replacement = Buffer.from(buildPatchReplacement(anchor.length, cdpPort), "latin1");
  const fd = openSync(destPath, "r+");
  try {
    const written = Buffer.alloc(anchor.length);
    // Patch bytes land, then read back to prove the write took.
    writeSync(fd, replacement, 0, anchor.length, anchor.offset);
    readSync(fd, written, 0, anchor.length, anchor.offset);
    if (!written.equals(replacement)) throw new TauriLaunchError("patch read-back mismatch");
  } finally {
    closeSync(fd);
  }
  return destPath;
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

// --- session ---------------------------------------------------------------------

const tauriSessions = new Map();

export function getTauriSession(gameKey) {
  return tauriSessions.get(gameKey) || null;
}

export function listTauriSessions() {
  return [...tauriSessions.values()].map((session) => session.describe());
}

// How often the host drains the page's outbound queue. 250ms keeps trainer
// feedback snappy while the evaluate calls stay invisible to the game.
const OUTBOX_POLL_MS = 250;

class TauriSession extends EventEmitter {
  constructor({ gameKey, pid, cdpPort, saveDir, patchedExe }) {
    super();
    this.gameKey = gameKey;
    this.pid = pid;
    this.cdpPort = cdpPort;
    this.saveDir = saveDir || null;
    this.patchedExe = patchedExe || null;
    this.nextId = 1;
    this.pending = new Map();
    this.hello = null;
    this.state = null;
    this.connectedAt = null;
    this.alive = true;
    this.cdp = null;
    this.pollTimer = null;
    this.pidTimer = setInterval(() => this.checkPid(), 3000);
    this.pidTimer.unref?.();
  }

  checkPid() {
    let alive;
    try {
      process.kill(this.pid, 0);
      alive = true;
    } catch (error) {
      alive = error && error.code === "EPERM";
    }
    if (!alive) {
      dbg("game pid gone, tearing down session");
      this.teardown();
    }
  }

  describe() {
    return {
      gameKey: this.gameKey,
      alive: this.alive && !!this.hello,
      bridgeVersion: this.hello ? this.hello.bridgeVersion : null,
      engine: this.hello ? this.hello.engine : null,
      connectedAt: this.connectedAt,
      state: this.state
    };
  }

  teardown() {
    if (!this.alive) return;
    this.alive = false;
    clearInterval(this.pidTimer);
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.cdp) {
      try {
        this.cdp.close();
      } catch (_) {}
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("bridge disconnected"));
    }
    this.pending.clear();
    this.emit("close", this);
  }

  async connect() {
    // The page target can appear in /json before its renderer answers
    // inspector calls, so the open retries on a clock.
    //
    // No Runtime.enable, no Runtime.addBinding, no other domain calls: this
    // game family's watchdog exits the process within milliseconds of a
    // Runtime.enable (observed: a burst of executionContextCreated /
    // consoleAPICalled, then Inspector.detached and the app is gone). Bare
    // WebSocket + Runtime.evaluate is the proven-safe subset.
    const deadline = Date.now() + 30000;
    let lastError = null;
    for (;;) {
      try {
        this.cdp = await openCdpSession({
          port: this.cdpPort,
          matchUrl: "https://tauri.localhost/",
          timeoutMs: 10000
        });
        this.cdp.onClose = () => {
          dbg("devtools socket dropped");
          this.teardown();
        };
        dbg("CDP session open on target", this.cdp.target.url);
        return;
      } catch (error) {
        lastError = error;
        dbg("connect attempt failed:", error.message);
        if (this.cdp) {
          try {
            this.cdp.close();
          } catch (_) {}
          this.cdp = null;
        }
        if (Date.now() > deadline) {
          throw new TauriLaunchError(`CDP session never became ready: ${lastError.message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  // Starts draining the bridge's outbound queue. Called by launchTauriGame
  // once the bootstrap eval has installed the bridge (which pushes its hello
  // into the outbox immediately, so the first drain picks it up).
  startPolling() {
    if (this.pollTimer || !this.alive) return;
    // Entries are JSON strings; \n framing is safe because JSON.stringify
    // never emits raw newlines. Splice-then-join drains atomically from the
    // page's perspective (evaluate runs to completion on the main thread).
    const DRAIN =
      "(window.__rmchOutbox && window.__rmchOutbox.length ? window.__rmchOutbox.splice(0).join(\"\\n\") : \"\")";
    this.pollTimer = setInterval(async () => {
      if (!this.alive || !this.cdp) return;
      let batch;
      try {
        batch = await this.cdp.evaluate(DRAIN, 5000);
      } catch (error) {
        // A failed drain is not fatal on its own (page busy, momentary
        // inspector hiccup); a dead socket triggers teardown via onClose.
        dbg("outbox drain failed:", error.message);
        return;
      }
      if (!batch) return;
      for (const line of String(batch).split("\n")) {
        if (line) this.handleBridgeMessage(line);
      }
    }, OUTBOX_POLL_MS);
    this.pollTimer.unref?.();
  }

  handleBridgeMessage(payload) {
    let message;
    try {
      message = JSON.parse(payload);
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

  // The slot list is the one save feature the in-page bridge cannot answer in
  // degraded (no-Node) mode — but the files are plain <gameRoot>/save/*.rmmzsave
  // and THIS side of the CDP tunnel has a filesystem, so answer it locally.
  answerSaveList() {
    const dir = this.saveDir;
    const entries = [];
    if (dir && existsSync(dir)) {
      try {
        for (const name of readdirSync(dir)) {
          if (!/\.rmmzsave$/i.test(name)) continue;
          const stat = statSync(path.join(dir, name));
          entries.push({ name, size: stat.size, mtime: stat.mtime.toISOString() });
        }
      } catch (_) {}
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { dir, entries };
  }

  send(type, args = {}, timeout = COMMAND_TIMEOUT_MS) {
    if (!this.alive || !this.cdp) return Promise.reject(new Error("bridge is not connected"));
    if (type === "save.list") {
      try {
        return Promise.resolve(this.answerSaveList());
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (type === "save.contents.apply") timeout = Math.max(timeout, 120000);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`command timed out: ${type}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      const text = JSON.stringify({ t: "cmd", id, type, args });
      // __rmchDispatch is installed by the bridge's CDP transport (55-transport).
      this.cdp.evaluate(`window.__rmchDispatch && window.__rmchDispatch(${JSON.stringify(text)})`, timeout)
        .catch((error) => {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  close() {
    this.teardown();
  }
}

// --- launch ------------------------------------------------------------------------

// Polls child liveness during the post-spawn grace period. We must not touch
// the CDP port yet (see BOOT_GRACE_MS), so liveness is the only signal.
async function waitForBootGrace(child, graceMs) {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new TauriLaunchError(`game exited during startup (code ${child.exitCode})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// Polls the CDP endpoint until the Tauri page target answers (or the child
// dies / the deadline hits).
async function waitForTauriPage(cdpPort, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let lastStatus = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new TauriLaunchError(`game exited during startup (code ${child.exitCode})`);
    }
    let status;
    try {
      const targets = await listTargets(cdpPort, 1500);
      if (targets.some((t) => t.type === "page" && String(t.url || "").startsWith("https://tauri.localhost/"))) {
        dbg("page target found:", targets.map((t) => `${t.type}:${t.url}`).join(" | "));
        return;
      }
      status = "targets: " + (targets.map((t) => `${t.type}:${String(t.url || "").slice(0, 60)}`).join(" | ") || "none");
      lastError = new TauriLaunchError("page target not listed yet");
    } catch (error) {
      status = "poll error: " + error.message;
      lastError = error;
    }
    if (status !== lastStatus) {
      dbg(status);
      lastStatus = status;
    }
    await new Promise((resolve) => setTimeout(resolve, CDP_POLL_MS));
  }
  throw new TauriLaunchError(`timed out waiting for CDP on 127.0.0.1:${cdpPort}: ${lastError ? lastError.message : "no targets"}`);
}

export function buildTauriBootstrap({ gameRoot, projectRoot, gameKey, saveDir }) {
  const bridgePath = path.join(projectRoot, "runtime", "bridge", "page-bridge.js");
  const bridgeSource = readFileSync(bridgePath, "utf8");
  const env = {
    RMCH_GAME_ROOT: gameRoot,
    RMCH_PROJECT_ROOT: projectRoot,
    RMCH_GAME_KEY: gameKey,
    RMCH_TRANSPORT: "cdp",
    RMCH_SAVE_DIR: saveDir || ""
  };
  return [
    "(function(){",
    "  if (window.__rmchBridge) return 'already-attached';",
    "  if (!document || !document.querySelector) return 'no-dom-yet';",
    "  window.__rmchEnv = " + JSON.stringify(env) + ";",
    "  (0, eval)(" + JSON.stringify(bridgeSource) + ");",
    "  return window.__rmchBridge ? 'ok' : 'bridge-refused';",
    "})();"
  ].join("\n");
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.on("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

// A previous launch already paid for the 100MB+ copy. Reuse the patched exe
// as-is when it is at least as new as the source (game not updated since),
// its patch region still reads as our switch, and the port embedded in it is
// currently free. Returns the embedded port, or null to re-copy and re-patch.
async function reusablePatchedPort(sourceExe, patchedExe, anchor) {
  let match = null;
  try {
    if (statSync(patchedExe).mtimeMs < statSync(sourceExe).mtimeMs) return null;
    const fd = openSync(patchedExe, "r");
    try {
      const buffer = Buffer.alloc(anchor.length);
      readSync(fd, buffer, 0, anchor.length, anchor.offset);
      match = /^--remote-debugging-port=(\d+) +$/.exec(buffer.toString("latin1"));
    } finally {
      closeSync(fd);
    }
  } catch (_) {
    return null;
  }
  if (!match) return null;
  const port = Number(match[1]);
  return (await portIsFree(port)) ? port : null;
}

function launchSummary(session, scan) {
  return {
    game: scan.title,
    gameKey: scan.gameKey,
    root: scan.root,
    engine: scan.engine.id,
    protection: scan.protection,
    strategy: "tauri-cdp",
    strategyReason: "Tauri WebView2: patched exe copy opens CDP; bridge transport is evaluate-polled outbox",
    pid: session.pid,
    patchedExe: session.patchedExe,
    cdpPort: session.cdpPort,
    tauriSession: session,
    server: null,
    port: null
  };
}

// Launching is slow (boot grace + first paint) and the GUI button used to
// accept a second click mid-launch — which then died on EBUSY re-copying the
// exe the first instance was already running. So: a live session answers
// immediately, and a concurrent launch joins the in-flight one.
const tauriLaunches = new Map(); // gameKey -> in-flight launch promise

export function launchTauriGame({ scan, projectRoot }) {
  const key = scan.gameKey;
  const existing = tauriSessions.get(key);
  if (existing && existing.alive) {
    dbg("already running, handing back the live session");
    return Promise.resolve(launchSummary(existing, scan));
  }
  const inflight = tauriLaunches.get(key);
  if (inflight) {
    dbg("launch already in flight, joining it");
    return inflight;
  }
  const promise = doLaunchTauriGame({ scan, projectRoot }).finally(() => {
    if (tauriLaunches.get(key) === promise) tauriLaunches.delete(key);
  });
  tauriLaunches.set(key, promise);
  return promise;
}

async function doLaunchTauriGame({ scan, projectRoot }) {
  const sourceExe = scan.paths && scan.paths.exe;
  if (!sourceExe || !existsSync(sourceExe)) {
    throw new TauriLaunchError(`game exe not found: ${sourceExe || "(none scanned)"}`);
  }
  const probe = probeTauriShell(sourceExe, { deep: true });
  if (!probe.isTauri) throw new TauriLaunchError(`${sourceExe} does not look like a Tauri/WRY app`);
  if (!probe.anchor) throw new TauriLaunchError("no patchable browser-args string found in the exe");

  buildBridge(projectRoot);

  const parsed = path.parse(sourceExe);
  const patchedExe = path.join(parsed.dir, `${parsed.name}.rmch-cdp${parsed.ext}`);
  let cdpPort = await reusablePatchedPort(sourceExe, patchedExe, probe.anchor);
  if (cdpPort) {
    dbg("reusing patched exe, embedded port", cdpPort);
  } else {
    cdpPort = await pickFreePort();
    try {
      buildPatchedExe({ exePath: sourceExe, destPath: patchedExe, anchor: probe.anchor, cdpPort });
    } catch (error) {
      if (error && error.code === "EBUSY") {
        throw new TauriLaunchError(
          `无法写入 ${path.basename(patchedExe)}：文件被占用。通常是游戏还在运行` +
          "（从库里直接连接那个会话，或先关掉游戏）；也可能是杀毒软件正在扫描，稍候重试。"
        );
      }
      throw error;
    }
  }

  const child = spawn(patchedExe, [], {
    cwd: scan.root,
    detached: true,
    stdio: "ignore",
    // GUI-subsystem exe; hiding would be inherited as SW_HIDE by the window.
    windowsHide: false
  });
  child.unref();
  dbg("spawned pid", child.pid, "port", cdpPort, "exe", patchedExe);
  child.on("exit", (code, signal) => dbg("child exit:", code, signal));
  child.on("error", (error) => dbg("child error:", error.message));

  try {
    await waitForBootGrace(child, BOOT_GRACE_MS);
    dbg("boot grace elapsed, polling CDP");
    await waitForTauriPage(cdpPort, child, CDP_WAIT_TIMEOUT_MS);
  } catch (error) {
    try {
      process.kill(child.pid);
    } catch (_) {}
    throw error;
  }

  const session = new TauriSession({
    gameKey: scan.gameKey,
    pid: child.pid,
    cdpPort,
    saveDir: scan.paths.saveDir || path.join(scan.root, "save"),
    patchedExe
  });
  try {
    await session.connect();
    const bootstrap = buildTauriBootstrap({
      gameRoot: scan.root,
      projectRoot,
      gameKey: scan.gameKey,
      saveDir: session.saveDir
    });
    const verdict = await session.cdp.evaluate(bootstrap, 30000);
    if (verdict !== "ok" && verdict !== "already-attached") {
      throw new TauriLaunchError(`bridge bootstrap refused: ${verdict}`);
    }
    // Bridge is in: its hello is already sitting in the outbox, so start
    // draining right away.
    session.startPolling();
  } catch (error) {
    session.teardown();
    try {
      process.kill(child.pid);
    } catch (_) {}
    throw error;
  }
  tauriSessions.set(scan.gameKey, session);
  session.on("close", () => {
    if (tauriSessions.get(scan.gameKey) === session) tauriSessions.delete(scan.gameKey);
  });

  return launchSummary(session, scan);
}
