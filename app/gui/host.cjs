// Node-context glue for the RMCH GUI (NW.js, nodejs: true).
// Loads the project's ES modules (core/*.mjs) via dynamic import and starts
// the embedded BridgeServer. The page script (gui-core.js) talks to this
// module through require(); everything below runs in the Node context so
// dynamic import of absolute Windows paths is reliable.

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const state = {
  projectRoot: null,
  server: null,
  modules: null,
  bundle: null,
  libraryPath: null,
  library: { manualRoots: [] },
  logLines: [],
  onLog: null,
  onState: null,
  onSessions: null
};

function guiLog(message, extra) {
  const line = `[${new Date().toISOString()}] ${message}${extra ? " " + JSON.stringify(extra) : ""}`;
  state.logLines.push(line);
  if (state.logLines.length > 500) state.logLines.splice(0, state.logLines.length - 500);
  try { fs.appendFileSync(path.join(state.projectRoot, "runtime", "gui.log"), line + "\n", "utf8"); } catch (_) {}
  if (state.onLog) state.onLog(line);
}

// The page needs the same sink for its own diagnostics (mount confirmation,
// uncaught errors) — those must survive the window closing.
function pageLog(message) {
  if (!state.projectRoot) state.projectRoot = resolveProjectRoot(null);
  guiLog(String(message));
}

function resolveProjectRoot(explicit) {
  if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);
  if (process.env.RMCH_PROJECT_ROOT && fs.existsSync(process.env.RMCH_PROJECT_ROOT)) {
    return path.resolve(process.env.RMCH_PROJECT_ROOT);
  }
  // app/gui -> project root
  return path.resolve(__dirname, "..", "..");
}

// Core modules are ESM (.mjs). Inside NW.js, dynamic import() of .mjs files
// hard-crashes the mixed context and require() cannot load ESM, so under NW
// the modules come from the prebuilt CJS bundle (tools/gui-build.mjs
// regenerates it on every launch). Outside NW (plain-Node dev runs) the
// native dynamic import keeps working directly against the sources.
async function loadModule(relativePath) {
  if (process.versions.nw) {
    if (!state.bundle) state.bundle = require("./gui-bundle.cjs");
    return state.bundle.mod(relativePath);
  }
  return import(pathToFileURL(path.join(state.projectRoot, relativePath)).href);
}

async function init(explicitRoot) {
  if (state.server) return describe();
  state.projectRoot = resolveProjectRoot(explicitRoot);
  guiLog("gui boot", { projectRoot: state.projectRoot, node: process.version, nw: process.versions.nw || null });
  try {
    await boot();
  } catch (error) {
    // Boot errors are otherwise only visible in the page; mirror them into
    // runtime/gui.log so failures can be diagnosed after the fact.
    guiLog("gui boot FAILED", { error: String((error && error.stack) || error) });
    throw error;
  }
  return describe();
}

async function boot() {
  const scanner = await loadModule("core/scanner.mjs");
  const wsServer = await loadModule("core/ws-server.mjs");
  const launcher = await loadModule("core/launcher.mjs");
  const attach = await loadModule("core/attach.mjs");
  const tokenMod = await loadModule("core/token.mjs");
  const rgssArchive = await loadModule("core/rgss-archive.mjs");
  state.modules = { scanner, wsServer, launcher, attach, tokenMod, rgssArchive };

  state.libraryPath = path.join(state.projectRoot, "runtime", "gui-library.json");
  try {
    if (fs.existsSync(state.libraryPath)) {
      const saved = JSON.parse(fs.readFileSync(state.libraryPath, "utf8"));
      if (saved && Array.isArray(saved.manualRoots)) state.library.manualRoots = saved.manualRoots;
    }
  } catch (_) {}

  const token = tokenMod.getToken(state.projectRoot);
  const server = new wsServer.BridgeServer({ port: 47412, token });
  server.on("session-open", (gameKey) => {
    guiLog("bridge connected", { gameKey });
    notifySessions();
  });
  server.on("session-closed", (gameKey) => {
    guiLog("bridge disconnected", { gameKey });
    notifySessions();
  });
  server.on("state", (gameKey, gameState) => {
    if (state.onState) state.onState(gameKey, gameState);
  });
  await server.start();
  state.server = server;
  guiLog("bridge server listening on 127.0.0.1:47412");
  return describe();
}

// Version/runtime facts for the About dialog. appVersion comes from the GUI's
// own package.json (app/gui), which is also where NW reads the window title.
let cachedAbout = null;
function aboutInfo() {
  if (cachedAbout) return cachedAbout;
  let appVersion = null;
  try {
    appVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version || null;
  } catch (_) {}
  cachedAbout = {
    appVersion,
    nw: process.versions.nw || null,
    chromium: process.versions.chromium || null,
    node: process.version
  };
  return cachedAbout;
}

function describe() {
  return { projectRoot: state.projectRoot, port: 47412, about: aboutInfo() };
}

function notifySessions() {
  if (state.onSessions) state.onSessions(listSessions());
}

function listSessions() {
  const sessions = state.server ? state.server.listSessions() : [];
  // BridgeSession.describe() flattens its info ({...this.info, alive, state}).
  const described = sessions.map((session) => ({
    gameKey: session.gameKey,
    alive: session.alive,
    bridgeVersion: session.bridgeVersion,
    engine: session.engine,
    connectedAt: session.connectedAt,
    state: session.state
  }));
  // RGSS sessions live outside the WebSocket server (file channel) but must
  // look identical to the page.
  const { launcher } = state.modules || {};
  if (launcher && launcher.listRgssSessions) {
    return described.concat(launcher.listRgssSessions());
  }
  return described;
}

function saveLibrary() {
  try {
    fs.mkdirSync(path.dirname(state.libraryPath), { recursive: true });
    fs.writeFileSync(state.libraryPath, JSON.stringify(state.library, null, 2), "utf8");
  } catch (_) {}
}

// The library is fully user-managed: only roots added via 添加游戏目录 show up
// (persisted in runtime/gui-library.json). No Steam auto-scan anywhere — a fresh
// install opens to an empty library, and removing an entry actually removes it.
function listLibrary() {
  const { scanGame } = state.modules.scanner;
  const games = [];
  for (const root of state.library.manualRoots) {
    try {
      games.push(scanGame(root));
    } catch (error) {
      guiLog("manual library entry failed to scan", { root, error: String(error.message || error) });
    }
  }
  return games;
}

function addManualRoot(root) {
  const resolved = path.resolve(root);
  const info = state.modules.scanner.scanGame(resolved);
  if (!state.library.manualRoots.includes(info.root)) {
    state.library.manualRoots.push(info.root);
    saveLibrary();
  }
  return info;
}

function removeManualRoot(root) {
  const resolved = path.resolve(root);
  state.library.manualRoots = state.library.manualRoots.filter((entry) => entry !== resolved);
  saveLibrary();
}

async function launch(gameRoot) {
  const summary = await state.modules.launcher.launchGame({
    gameRoot,
    projectRoot: state.projectRoot,
    port: 47412
  });
  guiLog("game launched", {
    gameKey: summary.gameKey,
    strategy: summary.strategy,
    pid: summary.pid
  });
  // RGSS sessions bypass the WebSocket server; wire their events into the same
  // GUI sinks here so the page cannot tell the difference.
  const rgssSession = summary.rgssSession;
  if (rgssSession) {
    guiLog("bridge connected", { gameKey: summary.gameKey, channel: "file" });
    rgssSession.on("state", (gameState) => {
      if (state.onState) state.onState(summary.gameKey, gameState);
    });
    rgssSession.on("close", () => {
      guiLog("bridge disconnected", { gameKey: summary.gameKey });
      notifySessions();
    });
    notifySessions();
  }
  return summary;
}

// Attach to an ALREADY-RUNNING game (DLL injection). The bridge dials into the
// GUI's own WS server (attachGame's ensureServer sees the port in use), so the
// session shows up through the normal "session-open" event — nothing extra to
// wire here beyond the RGSS file-channel session, mirroring launch().
async function attach(gameRoot) {
  const summary = await state.modules.attach.attachGame({
    gameRoot,
    projectRoot: state.projectRoot,
    port: 47412
  });
  guiLog("game attached", {
    gameKey: summary.gameKey,
    strategy: summary.strategy,
    pid: summary.pid || null,
    injected: summary.injected || null
  });
  const rgssSession = summary.session;
  if (rgssSession) {
    guiLog("bridge connected", { gameKey: summary.gameKey, channel: "file" });
    rgssSession.on("state", (gameState) => {
      if (state.onState) state.onState(summary.gameKey, gameState);
    });
    rgssSession.on("close", () => {
      guiLog("bridge disconnected", { gameKey: summary.gameKey });
      notifySessions();
    });
    notifySessions();
  }
  return summary;
}

function stop(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve({ ok: false, reason: "no pid" });
    const { execFile } = require("child_process");
    execFile("taskkill", ["/PID", String(pid), "/F", "/T"], (error) => {
      const ok = !error;
      guiLog("game stopped", { pid, ok, error: error && error.message || null });
      resolve({ ok, pid });
    });
  });
}

function send(gameKey, type, args) {
  // RGSS sessions sit outside the WebSocket server; route by gameKey first.
  const launcher = state.modules && state.modules.launcher;
  if (launcher && launcher.getRgssSession) {
    const rgss = launcher.getRgssSession(gameKey);
    if (rgss) return rgss.send(type, args || {});
  }
  if (!state.server) return Promise.reject(new Error("server not started"));
  return state.server.sendCommand(gameKey, type, args || {});
}

// --- save backup (zero-dependency: directory copy) ---------------------------

function saveDirOf(gameKey) {
  // Prefer a live bridge answer (handles custom StorageManager layouts),
  // fall back to the scanner's save dir guess.
  for (const session of listSessions()) {
    if (session.gameKey === gameKey && session.state && session.state.saveDir) {
      return session.state.saveDir;
    }
  }
  const { scanGame, findSteamLibraries, scanLibrary } = state.modules.scanner;
  for (const library of findSteamLibraries()) {
    for (const info of scanLibrary(library)) {
      if (info.gameKey === gameKey && info.paths.saveDir) return info.paths.saveDir;
    }
  }
  for (const root of state.library.manualRoots) {
    try {
      const info = scanGame(root);
      if (info.gameKey === gameKey && info.paths.saveDir) return info.paths.saveDir;
    } catch (_) {}
  }
  return null;
}

// Only real save files are copied: for RGSS games the save directory is often
// the game root itself, and an unfiltered copy would drag Game.exe and the
// archive into every backup. MV/MZ save dirs contain nothing but these
// extensions anyway, so the filter is a no-op there.
const SAVE_FILE_EXT_RE = /\.(rpgsave|rmmzsave|rxdata|rvdata|rvdata2)$/i;

function backupSaves(gameKey) {
  const sourceDir = saveDirOf(gameKey);
  if (!sourceDir || !fs.existsSync(sourceDir)) throw new Error(`save directory not found for "${gameKey}"`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const destDir = path.join(state.projectRoot, "backups", gameKey, stamp);
  fs.mkdirSync(destDir, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(sourceDir)) {
    if (!SAVE_FILE_EXT_RE.test(entry)) continue;
    const source = path.join(sourceDir, entry);
    if (fs.statSync(source).isFile()) {
      fs.copyFileSync(source, path.join(destDir, entry));
      count += 1;
    }
  }
  guiLog("save backup created", { gameKey, destDir, files: count });
  return { gameKey, destDir, files: count };
}

function listBackups(gameKey) {
  const root = path.join(state.projectRoot, "backups", gameKey);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .map((name) => {
      const dir = path.join(root, name);
      let files = 0;
      let bytes = 0;
      if (fs.existsSync(dir)) {
        for (const entry of fs.readdirSync(dir)) {
          const stat = fs.statSync(path.join(dir, entry));
          if (stat.isFile()) { files += 1; bytes += stat.size; }
        }
      }
      return { name, dir, files, bytes, ts: fs.statSync(dir).mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

// Only ever called with a name listBackups produced, but re-validate anyway —
// this deletes recursively.
function deleteBackup(gameKey, name) {
  const clean = String(name || "");
  if (!clean || clean !== path.basename(clean) || clean.includes("..")) {
    throw new Error(`bad backup name: ${name}`);
  }
  const dir = path.join(state.projectRoot, "backups", gameKey, clean);
  if (!fs.existsSync(dir)) throw new Error(`backup not found: ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true });
  guiLog("save backup deleted", { gameKey, name: clean });
  return { gameKey, name: clean, deleted: true };
}

function restoreBackup(gameKey, name) {
  const backupDir = path.join(state.projectRoot, "backups", gameKey, name);
  if (!fs.existsSync(backupDir)) throw new Error(`backup not found: ${backupDir}`);
  const target = saveDirOf(gameKey);
  if (!target || !fs.existsSync(target)) throw new Error(`save directory not found for "${gameKey}"`);
  let count = 0;
  for (const entry of fs.readdirSync(backupDir)) {
    fs.copyFileSync(path.join(backupDir, entry), path.join(target, entry));
    count += 1;
  }
  guiLog("save backup restored", { gameKey, name, files: count });
  return { gameKey, name, restored: count };
}

function readBridgeLog(gameKey) {
  const file = path.join(state.projectRoot, "runtime", "bridge-state", gameKey, "bridge.log");
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-200).join("\n");
  } catch (_) {
    return "(no bridge log yet)";
  }
}

// --- misc shell / assets ------------------------------------------------------

// Reveal a directory in the OS file manager. nw.Shell is the right tool under
// NW; the explorer fallback keeps plain-Node dev runs working (explorer.exe
// returns a bogus nonzero exit code even on success, so its error is ignored).
function openPath(target) {
  if (!target || !fs.existsSync(target)) throw new Error(`path not found: ${target}`);
  if (typeof nw !== "undefined" && nw.Shell && typeof nw.Shell.openPath === "function") {
    nw.Shell.openPath(target);
  } else {
    require("child_process").execFile("explorer.exe", [target], () => {});
  }
  guiLog("path opened", { target });
  return { opened: target };
}

// Delete one file from the game's save directory. The bridge can save/load
// slots but has no delete, so the GUI does it from this side — same directory
// save.list read from (saveDirOf prefers the live session's answer).
function deleteSaveFile(gameKey, fileName) {
  const name = String(fileName || "");
  if (!/^[\w.()@-]+$/i.test(name) || name.includes("..")) {
    throw new Error(`bad file name: ${fileName}`);
  }
  const dir = saveDirOf(gameKey);
  if (!dir) throw new Error(`save directory not found for "${gameKey}"`);
  const target = path.join(dir, name);
  if (!fs.existsSync(target)) throw new Error(`file not found: ${name}`);
  fs.unlinkSync(target);
  // An RGSS shadow copy (live session or leftover) would resurrect the file
  // on the next save sync, so remove it too. Junctioned subdirectories point
  // at the real directory, where the unlink above already landed — those
  // attempts just miss. Best-effort: the real delete already succeeded.
  const shadowRoot = path.join(state.projectRoot, "runtime", "rgss-shadow", gameKey);
  try {
    for (const entry of [".", ...fs.readdirSync(shadowRoot)]) {
      const sub = entry === "." ? shadowRoot : path.join(shadowRoot, entry);
      if (!fs.statSync(sub).isDirectory()) continue;
      fs.rmSync(path.join(sub, name), { force: true });
    }
  } catch (_) {}
  guiLog("save file deleted", { gameKey, name });
  return { gameKey, name, deleted: true };
}

// Read an image as a data URL. The page needs this instead of a plain file://
// <img src> because the icon set is drawn onto <canvas> for slicing, and a
// file:// image taints the canvas even from a file:// page.
function readImageDataUrl(file, capBytes) {
  const limit = capBytes || 24 * 1024 * 1024;
  const size = fs.statSync(file).size;
  if (size > limit) return null;
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
    : ext === ".webp" ? "image/webp"
    : ext === ".gif" ? "image/gif"
    : "image/png";
  return `data:${mime};base64,` + fs.readFileSync(file).toString("base64");
}

// The game's own window icon, for library cards. MV/MZ standard layout.
function gameIcon(root) {
  for (const rel of ["www/icon/icon.png", "icon/icon.png"]) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) return readImageDataUrl(file);
  }
  return null;
}

// The shared icon sheet items/weapons/armors/skills/states index into.
// MV/MZ: www/img/system/IconSet.png (32px cells). RGSS2/3 (VX/Ace): the same
// sheet concept at Graphics/System/IconSet.png (24px cells) — encrypted games
// keep it inside the packed archive, so fall back to extracting the entry.
// RGSS1 (XP) uses one file per icon (Graphics/Icons/<name>.png) and does not
// expose icon_index through the bridge catalog, so no sheet applies there.
function iconSetImage(root) {
  const file = path.join(root, "www", "img", "system", "IconSet.png");
  if (fs.existsSync(file)) return readImageDataUrl(file);
  const rgssFile = path.join(root, "Graphics", "System", "IconSet.png");
  if (fs.existsSync(rgssFile)) return readImageDataUrl(rgssFile);
  const { rgssArchive } = state.modules || {};
  if (rgssArchive) {
    for (const rel of ["Game.rgss3a", "Game.rgss2a"]) {
      const archive = path.join(root, rel);
      if (!fs.existsSync(archive)) continue;
      try {
        const bytes = rgssArchive.extractEntry(archive, "Graphics\\System\\IconSet.png");
        return "data:image/png;base64," + Buffer.from(bytes).toString("base64");
      } catch (_) {}
    }
  }
  return null;
}

// --- value-lock persistence (MTool 保存/读取锁定状态) -------------------------
//
// The bridge holds the live lock set (it has to, it re-applies them per frame);
// the file on this side is what survives a game restart. Kept per game so lock
// ids, which are game-specific, never leak across titles.

function lockPath(gameKey) {
  return path.join(state.projectRoot, "runtime", "locks", `${sanitizeKey(gameKey)}.json`);
}

function sanitizeKey(gameKey) {
  return String(gameKey).replace(/[\\/:*?"<>|]/g, "_");
}

function saveLocks(gameKey, locks) {
  const file = lockPath(gameKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ gameKey, savedAt: new Date().toISOString(), locks }, null, 2), "utf8");
  guiLog("locks saved", { gameKey, file });
  return { file };
}

function loadLocks(gameKey) {
  const file = lockPath(gameKey);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return parsed && parsed.locks ? parsed.locks : null;
}

function hasLocks(gameKey) {
  return fs.existsSync(lockPath(gameKey));
}

module.exports = {
  init,
  describe,
  log: pageLog,
  listLibrary,
  addManualRoot,
  removeManualRoot,
  listSessions,
  launch,
  attach,
  stop,
  send,
  backupSaves,
  listBackups,
  deleteBackup,
  restoreBackup,
  saveDirOf,
  readBridgeLog,
  openPath,
  deleteSaveFile,
  gameIcon,
  iconSetImage,
  saveLocks,
  loadLocks,
  hasLocks,
  getLog: () => state.logLines.slice(-200).join("\n"),
  setHandlers({ onLog, onState, onSessions }) {
    state.onLog = onLog || state.onLog;
    state.onState = onState || state.onState;
    state.onSessions = onSessions || state.onSessions;
  }
};
