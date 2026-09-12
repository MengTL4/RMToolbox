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
  sessions: null,
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
  if (state.logLines.length > 500)
    state.logLines.splice(0, state.logLines.length - 500);
  try {
    fs.appendFileSync(
      path.join(state.projectRoot, "runtime", "gui.log"),
      line + "\n",
      "utf8"
    );
  } catch (_) {}
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
  if (
    process.env.RMCH_PROJECT_ROOT &&
    fs.existsSync(process.env.RMCH_PROJECT_ROOT)
  ) {
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
  guiLog("gui boot", {
    projectRoot: state.projectRoot,
    node: process.version,
    nw: process.versions.nw || null
  });
  try {
    await boot();
  } catch (error) {
    // Boot errors are otherwise only visible in the page; mirror them into
    // runtime/gui.log so failures can be diagnosed after the fact.
    guiLog("gui boot FAILED", {
      error: String((error && error.stack) || error)
    });
    throw error;
  }
  return describe();
}

async function boot() {
  const scanner = await loadModule("core/scanner.mjs");
  const wsServer = await loadModule("core/ws-server.mjs");
  const { BridgeSessions } = await loadModule("core/bridge-sessions.mjs");
  const { GameRuntime } = await loadModule("core/game-runtime.mjs");
  // Route attempts (including a fallback after a failed one) belong in the
  // shared GUI log — they are the first thing asked for when a launch fails.
  const gameRuntime = new GameRuntime({
    log: (message, extra) => guiLog(message, extra)
  });
  const tokenMod = await loadModule("core/token.mjs");
  const rgssArchive = await loadModule("core/rgss-archive.mjs");
  const saveFiles = await loadModule("core/save-files.mjs");
  const adapters = await loadModule("core/adapters/index.mjs");
  const overrides = await loadModule("core/strategy-overrides.mjs");
  state.modules = {
    scanner,
    wsServer,
    gameRuntime,
    tokenMod,
    rgssArchive,
    saveFiles,
    adapters,
    overrides
  };

  state.libraryPath = path.join(
    state.projectRoot,
    "runtime",
    "gui-library.json"
  );
  try {
    if (fs.existsSync(state.libraryPath)) {
      const saved = JSON.parse(fs.readFileSync(state.libraryPath, "utf8"));
      if (saved && Array.isArray(saved.manualRoots))
        state.library.manualRoots = saved.manualRoots;
    }
  } catch (error) {
    // The library file exists but cannot be read or parsed. Staying silent here
    // looked like "the toolbox forgot all my games" with nothing to act on: the
    // user cannot tell a corrupt file from a deleted one, and the next save
    // overwrites the evidence. Say so, and keep the old file for inspection.
    guiLog("gui library unreadable; starting empty", {
      path: state.libraryPath,
      error: String((error && error.message) || error)
    });
    state.libraryLoadError = String((error && error.message) || error);
  }

  const token = tokenMod.getToken(state.projectRoot);
  const server = new wsServer.BridgeServer({
    port: 47412,
    token,
    stateDir: path.join(state.projectRoot, "runtime", "bridge-state")
  });
  const sessions = new BridgeSessions({ server });
  state.sessions = sessions;
  sessions.on("session-open", (gameKey) => {
    guiLog("bridge connected", { gameKey });
    notifySessions();
  });
  sessions.on("session-closed", (gameKey) => {
    guiLog("bridge disconnected", { gameKey });
    notifySessions();
  });
  sessions.on("changed", notifySessions);
  sessions.on("state", (gameKey, gameState) => {
    if (state.onState) state.onState(gameKey, gameState);
  });
  try {
    await server.start();
  } catch (error) {
    sessions.dispose();
    state.sessions = null;
    throw error;
  }
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
    appVersion =
      JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"))
        .version || null;
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

// "A newer release exists" — deliberately read-only.
//
// This only asks the GitHub Releases API what the latest tag is; it never
// downloads or replaces anything. A 200 MB self-update would have to swap the
// running NW.js app out from under itself, and the toolbox already refuses to
// touch files it does not have to (see the 不碰游戏目录 rule). Telling the user
// where to get the new ZIP is the whole feature.
//
// Every failure path returns { ok: false } instead of throwing: this runs at
// startup, and being offline, rate-limited or behind a proxy must never look
// like a toolbox error. The result is cached for a day so a restart loop does
// not hammer the API.
const UPDATE_REPO = "MengTL4/RMToolbox";
const UPDATE_TTL_MS = 24 * 60 * 60 * 1000;
let updateCache = null;

function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value || ""));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewer(candidate, current) {
  const a = versionParts(candidate),
    b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

async function checkForUpdate() {
  if (updateCache && Date.now() - updateCache.at < UPDATE_TTL_MS)
    return updateCache.value;
  const current = aboutInfo().appVersion;
  const base = {
    current,
    latest: null,
    url: `https://github.com/${UPDATE_REPO}/releases`,
    checkedAt: Date.now()
  };
  const record = (value) => {
    updateCache = { at: Date.now(), value };
    return value;
  };
  if (!current)
    return record({ ...base, ok: false, reason: "unknown-version" });
  if (typeof fetch !== "function")
    return record({ ...base, ok: false, reason: "no-fetch" });
  try {
    const response = await fetch(
      `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "RMToolbox/" + current
        },
        signal: AbortSignal.timeout(8000)
      }
    );
    if (!response.ok)
      return record({ ...base, ok: false, reason: `HTTP ${response.status}` });
    const release = await response.json();
    if (release && release.draft)
      return record({ ...base, ok: true, updateAvailable: false });
    const latest = String((release && release.tag_name) || "").replace(
      /^v/,
      ""
    );
    if (!latest) return record({ ...base, ok: false, reason: "no-tag" });
    return record({
      ...base,
      ok: true,
      latest,
      url: (release && release.html_url) || base.url,
      notes: (release && release.name) || null,
      updateAvailable: isNewer(latest, current)
    });
  } catch (error) {
    // Offline, DNS failure, timeout, proxy interception — all normal.
    return record({
      ...base,
      ok: false,
      reason: String((error && error.message) || error)
    });
  }
}

function notifySessions() {
  if (state.onSessions) state.onSessions(listSessions());
}

// Session engine arrives as a string from the RGSS bridge ("RGSS1") and as
// { maker: "MZ" } from the MV/MZ bridge.
function sessionEngineId(session) {
  const engine = session && session.engine;
  if (typeof engine === "string") return engine;
  if (engine && typeof engine.maker === "string") return engine.maker;
  return null;
}

function listSessions() {
  if (!state.sessions) return [];
  const { capabilitiesForScan } = state.modules.adapters || {};
  const list = state.sessions.list();
  if (!capabilitiesForScan) return list;
  // 能力声明随会话一起流向界面：不在游戏库里（附加进来的）游戏也能按能力
  // 渲染。未声明任何能力的家族保持原样——界面按历史全量呈现。
  return list.map((session) => {
    const id = sessionEngineId(session);
    if (!id) return session;
    const capabilities = capabilitiesForScan({ engine: { id } });
    return capabilities.length ? { ...session, capabilities } : session;
  });
}

function saveLibrary() {
  try {
    fs.mkdirSync(path.dirname(state.libraryPath), { recursive: true });
    fs.writeFileSync(
      state.libraryPath,
      JSON.stringify(state.library, null, 2),
      "utf8"
    );
  } catch (_) {}
}

// The library is fully user-managed: only roots added via 添加游戏目录 show up
// (persisted in runtime/gui-library.json). No Steam auto-scan anywhere — a fresh
// install opens to an empty library, and removing an entry actually removes it.
function listLibrary() {
  const { scanGame } = state.modules.scanner;
  const { capabilitiesForScan } = state.modules.adapters || {};
  const games = [];
  for (const root of state.library.manualRoots) {
    try {
      const info = scanGame(root);
      // 能力声明随扫描结果流向界面（ADR 0002）：面板按能力渲染。
      if (capabilitiesForScan) {
        const capabilities = capabilitiesForScan(info);
        if (capabilities.length) info.capabilities = capabilities;
      }
      games.push(info);
    } catch (error) {
      guiLog("manual library entry failed to scan", {
        root,
        error: String(error.message || error)
      });
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
  state.library.manualRoots = state.library.manualRoots.filter(
    (entry) => entry !== resolved
  );
  saveLibrary();
}

async function launch(gameRoot, strategy = "auto") {
  let planned = null;
  try {
    if (
      state.modules.gameRuntime &&
      typeof state.modules.gameRuntime.plan === "function"
    ) {
      planned = state.modules.gameRuntime.plan({ gameRoot, strategy });
      guiLog("game launch plan", {
        gameRoot,
        requested: strategy,
        family: planned.family,
        preferred: planned.preferred,
        selected: planned.selected,
        fallback: planned.fallback,
        override: planned.override || null,
        blocked: planned.blocked
      });
    }
  } catch (error) {
    guiLog("game launch plan FAILED", {
      gameRoot,
      error: String((error && error.stack) || error)
    });
  }
  // A remembered route choice that no longer fits the current scan (the game
  // updated, the route retired) is ignored and reclaimed — launch falls back
  // to 自动 rather than failing on the stale record, and the zombie record is
  // removed so it cannot shadow future scans. (GUI callers only ever send
  // dropdown-validated or remembered routes; the CLI path stays strict.)
  let effective = strategy;
  if (strategy && strategy !== "auto" && planned) {
    effective =
      state.modules.overrides.resolveRouteOverride(planned, strategy) || "auto";
    if (effective !== strategy) {
      guiLog("route override incompatible with current scan; using auto", {
        gameRoot,
        route: strategy
      });
      try {
        const gameKey = state.modules.scanner.scanGame(gameRoot).gameKey;
        state.modules.overrides.clearStrategyOverride(
          state.projectRoot,
          gameKey
        );
      } catch (_) {}
    }
  }
  const summary = await state.modules.gameRuntime.launch({
    gameRoot,
    projectRoot: state.projectRoot,
    port: 47412,
    strategy: effective,
    onProgress: (() => {
      let last = 0;
      return (progress) => {
        const now = Date.now();
        if (progress.files === progress.filesTotal || now - last >= 1000) {
          last = now;
          guiLog("evb unpack progress", progress);
        }
      };
    })()
  });
  guiLog("game launched", {
    gameKey: summary.gameKey,
    strategy: summary.strategy,
    pid: summary.pid,
    route: summary.launchPlan
      ? {
          family: summary.launchPlan.family,
          preferred: summary.launchPlan.preferred,
          selected: summary.launchPlan.selected,
          fallback: summary.launchPlan.fallback,
          override: summary.launchPlan.override || null
        }
      : planned
        ? {
            family: planned.family,
            preferred: planned.preferred,
            selected: planned.selected,
            fallback: planned.fallback,
            override: planned.override || null
          }
        : null
  });
  return summary;
}

function plan(gameRoot, strategy = "auto") {
  if (
    !state.modules ||
    !state.modules.gameRuntime ||
    typeof state.modules.gameRuntime.plan !== "function"
  ) {
    throw new Error("工具箱启动路线规划器尚未就绪");
  }
  return state.modules.gameRuntime.plan({ gameRoot, strategy });
}

// --- 策略覆盖记录 -------------------------------------------------------------
// The route dropdown's manual choice is remembered per game (CONTEXT.md
// 策略覆盖记录): only the diff from the scanner-derived default is stored.
// Choosing 自动 (or asking to restore it) clears the record.

function setRouteChoice(root, gameKey, route) {
  const { overrides } = state.modules;
  if (!route || route === "auto") {
    overrides.clearStrategyOverride(state.projectRoot, gameKey);
    guiLog("route override cleared", { gameKey });
    return { ok: true, route: "auto" };
  }
  // Validate against the current plan: a route the game does not offer can
  // never be persisted.
  const planned = state.modules.gameRuntime.plan({ gameRoot: root });
  const chosen = overrides.resolveRouteOverride(planned, route);
  if (!chosen) {
    return { ok: false, reason: `路线 ${route} 不适用于当前游戏` };
  }
  overrides.saveStrategyOverride(state.projectRoot, gameKey, chosen);
  guiLog("route override saved", { gameKey, route: chosen });
  return { ok: true, route: chosen };
}

function clearRouteChoice(gameKey) {
  state.modules.overrides.clearStrategyOverride(state.projectRoot, gameKey);
  guiLog("route override cleared", { gameKey });
  return { ok: true };
}

function listRouteChoices() {
  return state.modules.overrides.listStrategyOverrides(state.projectRoot);
}

// Session discovery and notifications are owned by BridgeSessions for both
// launch and attach, including sessions that appear after the call returns.
async function attach(gameRoot) {
  const summary = await state.modules.gameRuntime.attach({
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
  return summary;
}

function stop(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve({ ok: false, reason: "no pid" });
    const { execFile } = require("child_process");
    execFile("taskkill", ["/PID", String(pid), "/F", "/T"], (error) => {
      const ok = !error;
      guiLog("game stopped", {
        pid,
        ok,
        error: (error && error.message) || null
      });
      resolve({ ok, pid });
    });
  });
}

function send(gameKey, type, args) {
  if (!state.sessions) return Promise.reject(new Error("server not started"));
  return state.sessions.send(gameKey, type, args);
}

// --- save backup (zero-dependency: directory copy) ---------------------------

function saveDirOf(gameKey) {
  const location = saveLocationOf(gameKey);
  return location && location.saveDir;
}

function saveLocationOf(gameKey) {
  // Prefer a live bridge answer (handles custom StorageManager layouts),
  // fall back to the scanner's save dir guess.
  let live = null;
  for (const session of listSessions()) {
    if (
      session.gameKey === gameKey &&
      session.state &&
      session.state.saveStorage === "webstorage"
    ) {
      return { saveDir: null, saveStorage: "webstorage" };
    }
    if (session.gameKey === gameKey && session.state && session.state.saveDir) {
      live = {
        saveDir: session.state.saveDir,
        saveLocation: session.state.saveLocation
      };
      if (live.saveLocation && live.saveLocation.gameRoot)
        return { ...live, gameRoot: live.saveLocation.gameRoot };
      break;
    }
  }
  const { scanGame, findSteamLibraries, scanLibrary } = state.modules.scanner;
  try {
    for (const library of findSteamLibraries()) {
      for (const info of scanLibrary(library)) {
        if (info.gameKey === gameKey && (live || info.paths.saveDir))
          return { saveDir: info.paths.saveDir, ...live, gameRoot: info.root };
      }
    }
  } catch (error) {
    if (!live) throw error;
  }
  for (const root of state.library.manualRoots) {
    try {
      const info = scanGame(root);
      if (info.gameKey === gameKey && (live || info.paths.saveDir))
        return { saveDir: info.paths.saveDir, ...live, gameRoot: info.root };
    } catch (_) {}
  }
  return live;
}

function saveFiles() {
  return state.modules.saveFiles.createSaveFiles({
    projectRoot: state.projectRoot,
    resolveLocation: saveLocationOf
  });
}

function webStorageBackupFile(gameKey, name) {
  for (const value of [gameKey, name]) {
    if (
      !value ||
      value === "." ||
      value.includes("..") ||
      /[\\/:\x00-\x1f]/.test(value)
    )
      throw new Error("invalid backup name");
  }
  const dir = path.join(state.projectRoot, "backups", gameKey, name);
  const file = path.join(dir, "webstorage.json");
  for (const target of [
    path.join(state.projectRoot, "backups"),
    path.dirname(dir),
    dir,
    file
  ]) {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
      throw new Error("invalid backup link");
  }
  return file;
}

async function runtimeSaveStorage(gameKey) {
  const live = listSessions().find(
    (session) => session.gameKey === gameKey && session.alive
  );
  if (!live) return false;
  const storage = (await send(gameKey, "save.list", {})).storage;
  return ["webstorage", "native"].includes(storage) ? storage : null;
}

function runtimeBackupStorage(format) {
  if (format === "rmch-mv-native-v1") return "native";
  if (["rmch-mv-webstorage-v1", "rmch-mz-forage-v1"].includes(format))
    return "webstorage";
  return null;
}

async function backupSaves(gameKey) {
  let result;
  const storage = await runtimeSaveStorage(gameKey);
  if (storage) {
    const snapshot = await send(gameKey, `save.${storage}.export`, {});
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .slice(0, 19);
    let name = stamp,
      suffix = 1;
    while (fs.existsSync(path.dirname(webStorageBackupFile(gameKey, name))))
      name = `${stamp}-${suffix++}`;
    const target = webStorageBackupFile(gameKey, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(snapshot), { flag: "wx" });
    result = {
      gameKey,
      destDir: path.dirname(target),
      files: snapshot.entries.length,
      storage
    };
  } else result = saveFiles().backup(gameKey);
  guiLog("save backup created", result);
  return result;
}

function listBackups(gameKey) {
  return saveFiles()
    .listBackups(gameKey)
    .map((entry) => {
      const file = webStorageBackupFile(gameKey, entry.name);
      if (!fs.existsSync(file)) return entry;
      const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
      const storage = runtimeBackupStorage(snapshot.format);
      if (!storage || !Array.isArray(snapshot.entries))
        throw new Error("invalid runtime save backup");
      return {
        ...entry,
        storage,
        files: snapshot.entries.length,
        bytes: fs.statSync(file).size
      };
    });
}

// Only ever called with a name listBackups produced, but re-validate anyway —
// this deletes recursively.
function deleteBackup(gameKey, name) {
  const result = saveFiles().deleteBackup(gameKey, name);
  guiLog("save backup deleted", { gameKey, name: result.name });
  return result;
}

async function restoreBackup(gameKey, name) {
  const file = webStorageBackupFile(gameKey, name);
  let result;
  if (fs.existsSync(file)) {
    const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
    const storage = await runtimeSaveStorage(gameKey);
    if (!storage || runtimeBackupStorage(snapshot.format) !== storage)
      throw new Error("请先连接使用对应存档方式的游戏，再恢复这份备份");
    result = {
      gameKey,
      name,
      ...(await send(gameKey, `save.${storage}.import`, { snapshot }))
    };
  } else result = saveFiles().restore(gameKey, name);
  guiLog("save backup restored", { gameKey, name, files: result.restored });
  return result;
}

function readBridgeLog(gameKey) {
  const file = path.join(
    state.projectRoot,
    "runtime",
    "bridge-state",
    gameKey,
    "bridge.log"
  );
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
// Open an http(s) URL in the user's browser. Separate from openPath on purpose:
// openPath stats the target and hands it to nw.Shell.openPath, which is wrong
// for a URL twice over (no file to stat, and a path opener will not route http).
//
// The URL is passed through the environment rather than interpolated into the
// command string, so a URL containing & or ^ cannot be read as shell syntax.
function openExternal(url) {
  const target = String(url || "");
  if (!/^https?:\/\//i.test(target))
    throw new Error(`refusing to open non-http URL: ${target}`);
  if (
    typeof nw !== "undefined" &&
    nw.Shell &&
    typeof nw.Shell.openExternal === "function"
  ) {
    nw.Shell.openExternal(target);
  } else {
    require("child_process").execFile(
      "cmd.exe",
      ["/c", "start", '""', '"%RMCH_OPEN_URL%"'],
      { env: { ...process.env, RMCH_OPEN_URL: target } },
      () => {}
    );
  }
  guiLog("external url opened", { url: target });
  return { opened: target };
}

function openPath(target) {
  if (!target || !fs.existsSync(target))
    throw new Error(`path not found: ${target}`);
  if (
    typeof nw !== "undefined" &&
    nw.Shell &&
    typeof nw.Shell.openPath === "function"
  ) {
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
async function deleteSaveFile(gameKey, fileName) {
  const storage = await runtimeSaveStorage(gameKey);
  const result = storage
    ? await send(gameKey, `save.${storage}.delete`, { name: fileName })
    : saveFiles().deleteSave(gameKey, fileName);
  guiLog("save file deleted", { gameKey, name: result.name });
  return result;
}

// Read an image as a data URL. The page needs this instead of a plain file://
// <img src> because the icon set is drawn onto <canvas> for slicing, and a
// file:// image taints the canvas even from a file:// page.
function readImageDataUrl(file, capBytes) {
  const limit = capBytes || 24 * 1024 * 1024;
  const size = fs.statSync(file).size;
  if (size > limit) return null;
  const ext = path.extname(file).toLowerCase();
  const mime =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".gif"
          ? "image/gif"
          : ext === ".bmp"
            ? "image/bmp"
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

// RGSS1 (XP) icons are one file per icon (Graphics/Icons/<name>.png), and the
// catalog exposes icon_name instead of a sheet index. Encrypted games keep the
// icons inside the packed archive, so fall back to extracting the entry — v1
// (rgssad) included.
function iconFileImage(root, name) {
  // Icon names never legitimately contain path characters or dots; stripping
  // them keeps the lookup inside Graphics/Icons/.
  const safe = String(name || "").replace(/[\\/:*?"<>|.]/g, "");
  if (!safe) return null;
  // Stock XP ships PNGs, custom engines (RGD) also load jpg & co — the FS is
  // case-insensitive on Windows, so lowercase patterns cover .PNG too.
  // Essentials games keep item icons per-file under Graphics/Items/<id>.png.
  for (const dir of ["Icons", "Items"]) {
    for (const ext of [".png", ".jpg", ".jpeg", ".webp", ".bmp"]) {
      const file = path.join(root, "Graphics", dir, safe + ext);
      if (fs.existsSync(file)) return readImageDataUrl(file);
    }
  }
  const { rgssArchive } = state.modules || {};
  if (rgssArchive) {
    for (const rel of ["Game.rgss3a", "Game.rgss2a", "Game.rgssad"]) {
      const archive = path.join(root, rel);
      if (!fs.existsSync(archive)) continue;
      for (const ext of [".png", ".PNG"]) {
        try {
          const bytes = rgssArchive.extractEntry(
            archive,
            `Graphics\\Icons\\${safe}${ext}`
          );
          return (
            "data:image/png;base64," + Buffer.from(bytes).toString("base64")
          );
        } catch (_) {}
      }
    }
  }
  return null;
}

// The shared icon sheet items/weapons/armors/skills/states index into.
// MV/MZ: www/img/system/IconSet.png (32px cells) — shells that flatten the
// package (nb-evalnwbin) drop the www level, so img/system/... at the root is
// checked too. RGSS2/3 (VX/Ace): the same sheet concept at
// Graphics/System/IconSet.png (24px cells) — encrypted games keep it inside
// the packed archive, so fall back to extracting the entry.
// RGSS1 (XP) uses one file per icon (Graphics/Icons/<name>.png) and does not
// expose icon_index through the bridge catalog, so no sheet applies there.
function iconSetImage(root) {
  for (const rel of [
    path.join("www", "img", "system", "IconSet.png"),
    path.join("img", "system", "IconSet.png")
  ]) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) return readImageDataUrl(file);
  }
  const rgssFile = path.join(root, "Graphics", "System", "IconSet.png");
  if (fs.existsSync(rgssFile)) return readImageDataUrl(rgssFile);
  const { rgssArchive } = state.modules || {};
  if (rgssArchive) {
    for (const rel of ["Game.rgss3a", "Game.rgss2a"]) {
      const archive = path.join(root, rel);
      if (!fs.existsSync(archive)) continue;
      try {
        const bytes = rgssArchive.extractEntry(
          archive,
          "Graphics\\System\\IconSet.png"
        );
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
  return path.join(
    state.projectRoot,
    "runtime",
    "locks",
    `${sanitizeKey(gameKey)}.json`
  );
}

// One sanitiser for all per-game file names (locks, strategy overrides): the
// canonical implementation lives in core/strategy-overrides.mjs so the two
// persistence idioms can never drift apart.
function sanitizeKey(gameKey) {
  return state.modules.overrides.sanitizeKey(gameKey);
}

function saveLocks(gameKey, locks) {
  const file = lockPath(gameKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      { gameKey, savedAt: new Date().toISOString(), locks },
      null,
      2
    ),
    "utf8"
  );
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
  checkForUpdate,
  log: pageLog,
  listLibrary,
  addManualRoot,
  removeManualRoot,
  listSessions,
  plan,
  setRouteChoice,
  clearRouteChoice,
  listRouteChoices,
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
  openExternal,
  deleteSaveFile,
  gameIcon,
  iconSetImage,
  iconFileImage,
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
