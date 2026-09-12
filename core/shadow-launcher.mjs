// Strategy B: shadow-directory launcher for games with a bg-script startup
// chain (e.g. Nightmare without return). Pattern validated by nwr_modkit:
//
//   runtime/shadow-apps/<gameKey>/
//     - hard links to NW runtime files (Game.exe, *.dll, *.pak, ...)
//     - junctions for big directories (www, locales, swiftshader, ...)
//     - copy of package.json
//     - patched bg-script = Prelude (spoof cwd/execPath/nw.App.manifest back
//       to the real game root so protection passes) + original script +
//       Suffix (on /index.html pages, eval page-bridge.js in page context)
//
// The original game files are never modified. A private --user-data-dir keeps
// the game's own profile untouched. The save/ directory is always junctioned
// back to the real game root, so the shadow reads the player's real saves and
// writes back to them (no divergent shadow-side saves). When the bg-script
// lives in a subdirectory (e.g. "bg_script/boot.js"), that path is carved out
// of the linked tree and recreated inside the shadow — writing the patched
// script through a junction would overwrite the game's real startup file.
//
// Games whose entire startup chain is an ancestry-verified kill-switch shell
// (scanner flag "grover-boot") keep their own chain but get two implants: a
// working `wmic` (the shell's probe fails closed on Windows 11, where
// Microsoft removed wmic.exe) and in-process kill-path guards — see
// buildGroverBootstrap for the strategy, the measured findings, and the open
// blocker.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, // 别换成 fs 的递归拷贝 API：GUI 内嵌 Node 是 16.1，那个要 16.7 才有
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  rmSync,
  symlinkSync,
  linkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { buildBridge } from "./bridge-bundler.mjs";
import { buildModuleReportCompatibility } from "./grover-compat.mjs";
import { removeShadowEntry } from "./shadow-files.mjs";

const SHADOW_ROOT = path.join("runtime", "shadow-apps");
const PROFILE_ROOT = path.join("runtime", "shadow-profiles");
const pendingShadowLaunches = new Set();

async function runningShadowProcess(executable) {
  if (process.platform !== "win32") return null;
  const quoted = executable.replace(/'/g, "''");
  const script = `$target = '${quoted}'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target } | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress`;
  const processes = await new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        timeout: 15000,
        encoding: "utf8"
      },
      (error, stdout) => {
        if (error) {
          const failure = new Error(
            `无法检查运行副本是否已启动：${error.message}`
          );
          failure.code = "PROCESS_QUERY_FAILED";
          reject(failure);
          return;
        }
        try {
          const value = String(stdout).trim();
          const parsed = value ? JSON.parse(value) : [];
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (error) {
          error.code = "PROCESS_QUERY_FAILED";
          reject(error);
        }
      }
    );
  });
  const pids = new Set(processes.map((entry) => entry.ProcessId));
  return (
    processes.find((entry) => !pids.has(entry.ParentProcessId)) ||
    processes[0] ||
    null
  );
}

async function withIdleShadow(options, launch) {
  const executable = path.resolve(
    options.projectRoot,
    SHADOW_ROOT,
    options.gameKey,
    shadowExecutableRelative(options.scan)
  );
  const key =
    process.platform === "win32" ? executable.toLowerCase() : executable;
  if (pendingShadowLaunches.has(key)) {
    const error = new Error("运行副本正在启动，请等待本次接入完成。");
    error.code = "GAME_ALREADY_RUNNING";
    throw error;
  }
  pendingShadowLaunches.add(key);
  try {
    // Do this before touching ANY file or profile. An existing game may still
    // have DLLs mapped even when its bridge is disconnected or the GUI restarted.
    const running = await runningShadowProcess(executable);
    if (running) {
      const error = new Error(
        `运行副本已经在运行（PID ${running.ProcessId}）。请返回游戏窗口；如需重新启动，请先关闭该游戏。`
      );
      error.code = "GAME_ALREADY_RUNNING";
      throw error;
    }
    return await launch(options);
  } finally {
    pendingShadowLaunches.delete(key);
  }
}

// Top-level entries never linked into the shadow app.
const SKIP_FILES = new Set(["debug.log", "error.log", "crash.log"]);

function jsString(value) {
  return JSON.stringify(value);
}

function linkOrCopyFile(source, dest) {
  removeShadowEntry(dest);
  try {
    linkSync(source, dest);
  } catch (_) {
    copyFileSync(source, dest);
  }
}

function junctionDir(source, dest) {
  removeShadowEntry(dest);
  symlinkSync(source, dest, "junction");
}

// Recovery packs live outside the game and are keyed by the exact runtime
// binary, never just its version or the game's name. A repair cannot write
// through the shadow's old locales junction or mix Chromium resource versions.
function shadowLocalesSource(projectRoot, gameRoot) {
  const locales = path.join(gameRoot, "locales");
  const binary = path.join(gameRoot, "nw.dll");
  if (existsSync(path.join(locales, "en-US.pak")) || !existsSync(binary))
    return null;
  const digest = createHash("sha256")
    .update(readFileSync(binary))
    .digest("hex");
  const recovered = path.join(
    projectRoot,
    "runtime",
    "nwjs-locales",
    digest,
    "locales"
  );
  if (existsSync(path.join(recovered, "en-US.pak"))) return recovered;
  const error = new Error(
    "游戏缺少 locales/en-US.pak 语言资源，无法启动。请修复游戏文件，或为运行副本准备匹配该 NW.js 运行时的语言资源。"
  );
  error.code = "ENOENT";
  throw error;
}

async function spawnShadowProcess({
  gameExe,
  appDir,
  args,
  env,
  projectRoot,
  gameKey
}) {
  const logPath = path.join(
    projectRoot,
    "runtime",
    "bridge-state",
    gameKey,
    "launch.log"
  );
  mkdirSync(path.dirname(logPath), { recursive: true });
  const log = openSync(logPath, "w");
  let child;
  try {
    child = spawn(gameExe, args, {
      cwd: appDir,
      detached: true,
      stdio: ["ignore", "ignore", log],
      env,
      // Old NW.js uses SW_SHOWDEFAULT; SW_HIDE would hide the game window.
      windowsHide: false
    });
  } finally {
    closeSync(log);
  }
  // A PID only means CreateProcess succeeded. Catch startup crashes (including
  // missing Chromium resources) before returning a successful launch summary.
  await new Promise((resolve, reject) => {
    let timer;
    const finish = (error) => {
      clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => {
      const error = new Error(
        `游戏进程在启动后立即退出（${signal || code}），尚未建立连接。启动日志：${logPath}`
      );
      error.code = "GAME_EXITED";
      finish(error);
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("spawn", () => {
      timer = setTimeout(() => finish(), 1000);
    });
  });
  child.unref();
  return { appDir, gameExe, pid: child.pid, launchLog: logPath };
}

// Flat-copy save files from srcDir into dstDir; newer mtime wins, missing
// files are copied. Used to pull stranded shadow-side saves back into the
// real game root before the save dir becomes a junction.
function mergeSaveFiles(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const src = path.join(srcDir, entry);
    const stat = lstatSync(src);
    if (!stat.isFile()) continue;
    const dst = path.join(dstDir, entry);
    const dstStat = lstatSync(dst, { throwIfNoEntry: false });
    if (!dstStat || stat.mtimeMs > dstStat.mtimeMs) copyFileSync(src, dst);
  }
}

function shadowExecutableRelative(scan) {
  const source =
    (scan.paths && scan.paths.exe) || path.join(scan.root, "Game.exe");
  const relative = path.relative(scan.root, source);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `shadow executable must be inside the game root: ${source}`
    );
  }
  return relative;
}

function buildPrelude(gameRoot, executableRelative) {
  return `;${buildModuleReportCompatibility()}
;(function () {
  try {
    var fs = require("fs");
    var path = require("path");
    var gameRoot = ${jsString(gameRoot)};
    process.cwd = function () { return gameRoot; };
    try {
      Object.defineProperty(process, "execPath", {
        configurable: true,
        get: function () { return path.join(gameRoot, ${jsString(executableRelative)}); }
      });
    } catch (_) {}
    try {
      var manifestPath = path.join(gameRoot, "package.json");
      if (typeof nw !== "undefined" && nw.App && fs.existsSync(manifestPath)) {
        var manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        Object.defineProperty(nw.App, "manifest", {
          configurable: true,
          get: function () { return manifest; }
        });
      }
    } catch (_) {}
  } catch (_) {}
}());
`;
}

function buildSuffix({ bridgePath, logPath, gameKey }) {
  return `;
;(function () {
  function writeLog(message) {
    try {
      var fs = require("fs");
      var path = require("path");
      var logPath = ${jsString(logPath)};
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, "[" + new Date().toISOString() + "] " + message + String.fromCharCode(10), "utf8");
    } catch (_) {}
  }

  try {
    var href = String(location && location.href || "");
    writeLog("entered href=" + href + " cwd=" + process.cwd());
    if (href.indexOf("/index.html") === -1) return;
    if (href.indexOf("_generated_background_page.html") !== -1) return;
    if (window.__rmchBridge) return;

    var fs = require("fs");
    var source = fs.readFileSync(${jsString(bridgePath)}, "utf8");
    (0, eval)(source + "\\n//# sourceURL=rmch-page-bridge.js");
    writeLog("bridge eval attempted hasBridge=" + !!window.__rmchBridge);
  } catch (error) {
    writeLog("bridge eval failed " + String(error && error.stack || error));
  }
}());
`;
}

// Links one entry of the game root into the shadow app. Directories are
// junctioned wholesale and files hard-linked — except on the path to the
// bg-script (relSkip, "/" separated, null when off that path): those
// directories are recreated and their children linked one by one, so the
// patched bg-script can be written into the shadow WITHOUT writing through
// a junction into the real game directory (which would silently overwrite
// the game's original startup file).
function linkShadowEntry(source, dest, relSkip) {
  // The game's source directory may itself be a junction. Follow it when
  // deciding how to carve the shadow, while inspecting dest without following.
  const stat = statSync(source);
  if (stat.isDirectory()) {
    if (!relSkip) {
      junctionDir(source, dest);
      return;
    }
    const slash = relSkip.indexOf("/");
    const head = slash === -1 ? relSkip : relSkip.slice(0, slash);
    const rest = slash === -1 ? null : relSkip.slice(slash + 1);
    // A junction left by an older build would make the patched-bg write land in
    // the real game tree — a real directory is required here, never a link.
    const existing = lstatSync(dest, { throwIfNoEntry: false });
    if (existing && existing.isSymbolicLink()) removeShadowEntry(dest);
    mkdirSync(dest, { recursive: true });
    for (const child of readdirSync(source)) {
      const childSource = path.join(source, child);
      const childDest = path.join(dest, child);
      if (child === head) {
        if (rest !== null) linkShadowEntry(childSource, childDest, rest);
        // rest === null → child IS the bg-script file; the patched copy is
        // written after the linking pass, so leave it out here.
      } else {
        linkShadowEntry(childSource, childDest, null);
      }
    }
    return;
  }
  if (relSkip) return; // carved-out file (shouldn't happen: relSkip only names dirs above)
  linkOrCopyFile(source, dest);
}

// Save rescue, link construction and private patch copies form one operation.
// Callers only supply the game-specific source transformation.
function buildShadowApp({ projectRoot, scan, gameKey, scriptRel, patch }) {
  const executableRelative = shadowExecutableRelative(scan);
  const parts = String(scriptRel)
    .split(/[\\/]+/)
    .filter((part) => part && part !== ".");
  if (
    path.isAbsolute(scriptRel) ||
    /^[A-Za-z]:/.test(scriptRel) ||
    parts.includes("..") ||
    !parts.length
  ) {
    throw new Error(`invalid shadow patch path: ${scriptRel}`);
  }
  const script = parts.join("/");
  const sourcePath = path.join(scan.root, ...parts);
  if (!existsSync(sourcePath))
    throw new Error(`shadow patch source not found: ${sourcePath}`);
  // A missing patch anchor must fail before rebuilding the directory tree.
  const patched = patch(readFileSync(sourcePath, "utf8"));
  const recoveredLocales = shadowLocalesSource(projectRoot, scan.root);
  const shadowBase = path.resolve(projectRoot, SHADOW_ROOT);
  const appDir = path.resolve(shadowBase, gameKey);
  const relative = path.relative(shadowBase, appDir);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`invalid shadow game key: ${gameKey}`);
  }
  const appStat = lstatSync(appDir, { throwIfNoEntry: false });
  if (appStat && appStat.isSymbolicLink())
    throw new Error(`shadow root must be a real directory: ${appDir}`);
  mkdirSync(appDir, { recursive: true });

  const isWwwLayout = scan.layout
    ? scan.layout === "www"
    : existsSync(path.join(scan.root, "www"));
  const saveRel = isWwwLayout ? path.join("www", "save") : "save";
  const realSaveDir = path.join(scan.root, saveRel);
  const shadowSaveDir = path.join(appDir, saveRel);
  const shadowStat = lstatSync(shadowSaveDir, { throwIfNoEntry: false });
  if (shadowStat && !shadowStat.isSymbolicLink() && shadowStat.isDirectory()) {
    // A www junction can make this path resolve into the real game. Only
    // rescue/remove an independent directory physically inside this shadow.
    const owned = path.relative(
      realpathSync(appDir),
      realpathSync(shadowSaveDir)
    );
    if (
      owned &&
      owned !== ".." &&
      !owned.startsWith(".." + path.sep) &&
      !path.isAbsolute(owned)
    ) {
      mergeSaveFiles(shadowSaveDir, realSaveDir);
      removeShadowEntry(shadowSaveDir);
    }
  }
  // Also needed for www layouts when the patch path carves www into a real
  // directory: create save before linking so future writes still go through.
  mkdirSync(realSaveDir, { recursive: true });

  for (const entry of readdirSync(scan.root)) {
    if (
      entry === "package.json" ||
      SKIP_FILES.has(entry.toLowerCase()) ||
      entry === script
    )
      continue;
    const relSkip = script.startsWith(entry + "/")
      ? script.slice(entry.length + 1)
      : null;
    linkShadowEntry(
      entry === "locales" && recoveredLocales
        ? recoveredLocales
        : path.join(scan.root, entry),
      path.join(appDir, entry),
      relSkip
    );
  }
  if (recoveredLocales && !existsSync(path.join(scan.root, "locales")))
    junctionDir(recoveredLocales, path.join(appDir, "locales"));
  const manifestPath = path.join(appDir, "package.json");
  removeShadowEntry(manifestPath);
  copyFileSync(path.join(scan.root, "package.json"), manifestPath);

  const patchedPath = path.join(appDir, ...parts);
  // The parent is private after the carve-out. Unlink the leaf too: an older
  // build may have left a hardlink to the original script at this location.
  removeShadowEntry(patchedPath);
  mkdirSync(path.dirname(patchedPath), { recursive: true });
  writeFileSync(patchedPath, patched, "utf8");
  const gameExe = path.join(appDir, executableRelative);
  if (!existsSync(gameExe))
    throw new Error(`shadow executable missing: ${gameExe}`);
  return { appDir, gameExe, patchedPath };
}

// Grover bootstrap (scanner flag "grover-boot", 傲世修仙录完结定制版 family).
// That family's whole startup chain — obfuscated bg-script `loading`, nwjc
// bg_script, loader page www/loading.html — is one ancestry-verified kill
// switch: it execs `wmic` from its cwd to walk the parent chain, and on
// Windows 11 wmic.exe no longer exists, so the check fails CLOSED — the shell
// writes 崩溃日志.log and quits/crashes the process tree ~15s after boot, even
// for a stock double-clicked launch.
//
// Strategy, from live reverse-engineering (runtime/_scratch/GROVER-FINDINGS.md):
//  1. Run the shell's OWN chain in the shadow (patched bg-script = prelude +
//     guards bootstrap + original `loading`), but hand the ancestry probe a
//     working `wmic`: runtime/bin/wmic.exe is copied next to Game.exe and the
//     game's PATH is prepended with the shadow dir at launch. The shim answers
//     the ParentProcessId/Name queries in real wmic's exact byte format
//     (CRCRLF lines, "Node=<hostname>" preamble), roots a dead launcher-stub
//     chain at a live explorer.exe, and always reports real image names — the
//     shell cross-checks known pids (PID 4 must answer "system") and spins
//     forever when a check returns an empty string.
//  2. Neutralize the kill paths from inside: the bootstrap registers a window
//     "loaded" listener BEFORE the original chain's own (our code runs first
//     in the bg-script file), and on every page load installs toString-safe
//     getter guards over nw.App.{quit,crashBrowser,crashRenderer,
//     closeAllWindows} + process.{exit,abort,crash,reallyExit,kill} + window
//     close, then evals the page bridge. The guards must be in place before
//     bg_script arms its 1.2s/15s kill timers in that context.
//  3. Keep the shadow manifest byte-identical to the game's: Some.js (the
//     payload's DRM plugin) validates the app manifest and core files.
//
// KNOWN LIMITATION (2026-09-06, reconfirmed 2026-09-13): with the shim the
// chain reaches the payload (loading.html → index.html, engine + all plugins
// load), but the boot still stalls in the shell's post-verification state
// machine on this machine; see GROVER-FINDINGS.md for the precise open
// questions. 2026-09-13 measurement: a launch through THIS guarded chain
// installs the guards and never reaches a scene (bridge up, mapId null, empty
// party) — the user-visible black window; the same games through the ordinary
// chain reach a map. core/launcher.mjs therefore drops the grover flag for
// every shadow launch and this strategy is diagnosis-only. Do not re-wire a
// launch route onto it without solving the freeze first.
function buildGroverBootstrap({ bridgePath, logPath }) {
  // Page-side guard source, eval'd into every page load. Our bootstrap
  // registers its "loaded" listener before the original chain's own (our code
  // runs first in the bg-script file), so the guards are in place before
  // bg_script arms its kill timers in that context. All wrappers are
  // toString-masked as natives: the shell's self-defend compares function
  // sources, and visible tampering feeds its anti-tamper checks.
  const pageGuards = `;(function () {
  if (window.__rmchGroverGuards) return;
  window.__rmchGroverGuards = 1;
  var LOGP = ${jsString(logPath)};
  function wlog(m) {
    try { require("fs").appendFileSync(LOGP, "[" + new Date().toISOString() + "] " + m + "\\n", "utf8"); } catch (_) {}
  }
  function nt(f) {
    try {
      var nat = function () { return "function () { [native code] }"; };
      Object.defineProperty(f, "toString", { configurable: true, value: nat });
    } catch (_) {}
    return f;
  }
  function block(obj, prop, label) {
    try {
      var d = Object.getOwnPropertyDescriptor(obj, prop);
      if (!d || !d.configurable) return;
      if (typeof d.value !== "function") return;
      var blocker = nt(function () {
        wlog("BLOCKED " + label);
        return undefined;
      });
      Object.defineProperty(obj, prop, {
        configurable: true,
        get: function () { return blocker; },
        set: function () {}
      });
    } catch (e) {}
  }
  try {
    var App = (window.nw && nw.App) || {};
    ["quit", "crashBrowser", "crashRenderer", "closeAllWindows"].forEach(function (p) { block(App, p, "nw.App." + p); });
    ["exit", "abort", "crash", "reallyExit", "kill"].forEach(function (p) { block(process, p, "process." + p); });
    try { block(window, "close", "window.close"); } catch (_) {}
    try { var W = window.nw && nw.Window.get(); if (W) block(W, "close", "nw.Window.close"); } catch (_) {}
  } catch (e) {}
} ());
`;
  return `;(function () {
  var LOG = ${jsString(logPath)};
  function log(m) {
    try {
      require("fs").mkdirSync(require("path").dirname(LOG), { recursive: true });
      require("fs").appendFileSync(LOG, "[" + new Date().toISOString() + "] " + m + "\\n", "utf8");
    } catch (_) {}
  }
  try {
    log("grover boot href=" + String(location && location.href));
    var bridgeSrc = require("fs").readFileSync(${jsString(bridgePath)}, "utf8");
    var win = nw.Window.get();
    win.on("loaded", function () {
      try { win.eval(null, ${jsString(pageGuards)}); } catch (_) {}
      try {
        win.eval(null, bridgeSrc + "\\n//# sourceURL=rmch-page-bridge.js");
        log("bridge evaled, page href=" + String(win.window && win.window.location && win.window.location.href));
      } catch (e) { log("bridge eval failed " + e); }
    });
    try { win.show(); } catch (_) {}
  } catch (e) { log("grover bootstrap failed " + (e && e.stack || e)); }
}());
`;
}

export function setupShadowApp({ projectRoot, scan, gameKey }) {
  const bgScriptName = scan.manifest && scan.manifest.bgScript;
  if (!bgScriptName)
    throw new Error("game has no bg-script; shadow strategy does not apply");
  const grover =
    scan.protection &&
    scan.protection.flags &&
    scan.protection.flags.includes("grover-boot");
  const shimSource = path.join(projectRoot, "runtime", "bin", "wmic.exe");
  if (grover && !existsSync(shimSource)) {
    throw new Error(
      `grover-boot needs the wmic shim: build it with tools/build-wmic-shim.mjs (${shimSource} missing)`
    );
  }
  const bridgePath = path.join(
    projectRoot,
    "runtime",
    "bridge",
    "page-bridge.js"
  );
  const bridgeStateDir = path.join(
    projectRoot,
    "runtime",
    "bridge-state",
    gameKey
  );
  const logPath = path.join(bridgeStateDir, "bg-bridge.log");
  const result = buildShadowApp({
    projectRoot,
    scan,
    gameKey,
    scriptRel: bgScriptName,
    patch(source) {
      return (
        buildPrelude(scan.root, shadowExecutableRelative(scan)) +
        (grover ? buildGroverBootstrap({ bridgePath, logPath }) : "") +
        source +
        buildSuffix({ bridgePath, logPath, gameKey })
      );
    }
  });
  mkdirSync(bridgeStateDir, { recursive: true });
  if (grover) {
    // grover-boot: keep the shadow manifest byte-identical to the game's —
    // the payload's DRM plugin (Some.js) validates the app manifest and core
    // files — and instead give the shell's ancestry probe a working `wmic`
    // (see buildGroverBootstrap). The shim is deployed INTO the shadow dir and
    // the game's PATH is prepended with it at launch, so cmd.exe (the shell
    // execs `wmic ...` which resolves cwd-then-PATH) finds our shim and never
    // the missing system wmic.
    const shimPath = path.join(result.appDir, "wmic.exe");
    if (lstatSync(shimPath, { throwIfNoEntry: false }))
      rmSync(shimPath, { recursive: true, force: true });
    copyFileSync(shimSource, shimPath);
  } else if (!existsSync(path.join(scan.root, "wmic.exe"))) {
    // Switching from the guarded strategy must also remove its generated
    // executable: Windows command lookup searches cwd even without PATH edits.
    const shimPath = path.join(result.appDir, "wmic.exe");
    const shim = lstatSync(shimPath, { throwIfNoEntry: false });
    if (shim && (shim.isFile() || shim.isSymbolicLink()))
      rmSync(shimPath, { force: true });
  }
  return {
    appDir: result.appDir,
    gameExe: result.gameExe,
    bgScriptPath: result.patchedPath
  };
}

// grover-boot games launch through the ordinary direct spawn below, with one
// addition: the shadow dir is prepended to the game's PATH so the shell's
// `wmic` exec resolves the deployed shim (cmd.exe searches cwd, then PATH;
// the exec's cwd is the prelude-spoofed real game root, so PATH is what makes
// the shim reachable). See buildGroverBootstrap for the full strategy and the
// known limitation.
export function launchShadowGame(options) {
  return withIdleShadow(options, launchPreparedShadowGame);
}

async function launchPreparedShadowGame({
  projectRoot,
  scan,
  gameKey,
  port,
  token
}) {
  const { appDir, gameExe } = setupShadowApp({ projectRoot, scan, gameKey });

  // Fresh private profile per launch (matches the validated nwr behaviour).
  const profileDir = path.join(projectRoot, PROFILE_ROOT, gameKey);
  removeShadowEntry(profileDir);
  mkdirSync(profileDir, { recursive: true });

  const grover =
    scan.protection &&
    scan.protection.flags &&
    scan.protection.flags.includes("grover-boot");
  const env = {
    ...process.env,
    RMCH_GAME_ROOT: scan.root,
    RMCH_PROJECT_ROOT: projectRoot,
    RMCH_GAME_KEY: gameKey,
    RMCH_WS_PORT: String(port),
    RMCH_WS_TOKEN: token,
    ...(grover && process.env.PATH !== undefined
      ? { PATH: appDir + path.delimiter + process.env.PATH }
      : {})
  };

  const processInfo = await spawnShadowProcess({
    gameExe,
    appDir,
    projectRoot,
    gameKey,
    env,
    args: [`--user-data-dir=${profileDir}`, "--force-color-profile=srgb"]
  });
  return { ...processInfo, profileDir };
}

// --- bundled-engine shadow (命运II离线版 / Metal Max II Restored family) --------
//
// Bundled-engine games (container "nwjs-bundled") pack the whole RPG Maker
// runtime into one combined classic script wrapped in a single
// `(function(){...}.call(this))` closure. EVERY engine name is closure-local
// in this family (measured on 命运II离线版: no $data*/$game*/manager ever
// reaches window — the bridge's catalog tap was what carried the data tabs),
// and the old NW.js builds these games ship on expose no CDP either
// (measured on NW.js 0.29 / MV 1.6.1: --remote-debugging-port ignored on the
// command line AND via chromium-args — no devtools HTTP server in this
// binary), so neither the plain extension resolvers nor the sealed-family
// heap scan can reach anything.
//
// The way in costs one appended snippet: the bundle's own tail already
// publishes a helper (window.__nbTrainerAPI) from inside that closure,
// proving the wrapper scope sees every engine name. The shadow copy of the
// engine script gets a publish snippet inserted just before the wrapper's
// closing brace — static publishes for the managers/classes, accessor getters
// for the $data*/$game* variables (their values are replaced wholesale on
// new game / save load, so a static publish would go stale immediately) —
// after which the standard extension bridge sees a completely normal MV/MZ
// game. Everything else is hardlinks + junctions; original files untouched,
// and the www junction routes www/save straight back to the real tree.

// Published under their stock names so every bridge resolver/hook works
// unmodified. eval() resolves each name in the bundle's own scope chain; a
// name the family variant lacks throws and is skipped.
const BUNDLED_PUBLISH_NAMES = [
  "Utils",
  "JsonEx",
  "Graphics",
  "Input",
  "TouchInput",
  "DataManager",
  "SceneManager",
  "BattleManager",
  "ConfigManager",
  "StorageManager",
  "ImageManager",
  "AudioManager",
  "TextManager",
  "Scene_Map",
  "Scene_Title",
  "Scene_Battle",
  "Scene_Item",
  "Scene_Skill",
  "Scene_Equip",
  "Scene_Status",
  "Scene_Menu",
  "Scene_Save",
  "Scene_Load",
  "Scene_Options",
  "Scene_Debug",
  "Scene_Shop",
  "Scene_Name",
  "Scene_GameEnd",
  "Game_BattlerBase",
  "Game_Battler",
  "Game_Actor",
  "Game_Actors",
  "Game_Party",
  "Game_Player",
  "Game_Enemy",
  "Game_Troop",
  "Game_Map",
  "Game_System",
  "Game_Screen",
  "Game_Temp",
  "Game_Switches",
  "Game_Variables",
  "Game_SelfSwitches",
  "Game_Follower",
  "Game_Followers",
  "Game_Event",
  "Game_CommonEvent",
  "Game_Interpreter",
  "Game_Action",
  "Game_Item",
  "Game_Timer",
  "Game_Message",
  "Game_Vehicle"
];

// $data*/$game* are closure VARIABLES too (measured on 命运II离线版: nothing
// dollar-named ever reaches window — the bridge's catalog tap carried it).
// Their VALUES are replaced wholesale on new game / save load, so a static
// publish goes stale immediately: publish accessors instead, each getter
// re-reading the live closure variable via direct eval.
const BUNDLED_PUBLISH_VARS = [
  "$dataSystem",
  "$dataItems",
  "$dataWeapons",
  "$dataArmors",
  "$dataSkills",
  "$dataStates",
  "$dataActors",
  "$dataEnemies",
  "$dataTroops",
  "$dataMapInfos",
  "$dataCommonEvents",
  "$dataMap",
  "$dataClasses",
  "$dataAnimations",
  "$dataTilesets",
  "$gameParty",
  "$gameSystem",
  "$gameSwitches",
  "$gameVariables",
  "$gameSelfSwitches",
  "$gameActors",
  "$gameTroop",
  "$gameTemp",
  "$gameMap",
  "$gamePlayer",
  "$gameScreen",
  "$gameMessage"
];

function bundledPublishSnippet() {
  return (
    ";try{var __rmchPub=" +
    JSON.stringify(BUNDLED_PUBLISH_NAMES) +
    ";" +
    "for(var __rmchI=0;__rmchI<__rmchPub.length;__rmchI++){var __rmchN=__rmchPub[__rmchI];" +
    "try{if(window[__rmchN]==null){var __rmchV=eval(__rmchN);if(__rmchV!=null)window[__rmchN]=__rmchV}}catch(e){}}" +
    "var __rmchVars=" +
    JSON.stringify(BUNDLED_PUBLISH_VARS) +
    ";" +
    "for(var __rmchJ=0;__rmchJ<__rmchVars.length;__rmchJ++){var __rmchV2=__rmchVars[__rmchJ];" +
    "try{if(window[__rmchV2]==null){(function(n){" +
    "try{eval(n);}catch(e){return;}" +
    "Object.defineProperty(window,n,{configurable:true,enumerable:true,get:function(){try{return eval(n)}catch(e){return null}}});" +
    "})(__rmchV2)}}catch(e){}}}catch(e){}\n"
  );
}

// Patch the engine script text: insert the publish snippet INSIDE the
// bundle's closing wrapper so it can see the closure-local declarations.
// Primary anchor is the wrapper's own final `}.call(this);` (it must sit at
// the very end of the file, or the guess would land in some nested closure);
// the repacker's `__nbTrainerAPI=` tail block is the fallback anchor.
export function patchBundledEngineScript(source) {
  const snippet = bundledPublishSnippet();
  const wrapperTail = source.lastIndexOf("}.call(this)");
  if (
    wrapperTail !== -1 &&
    source.length - (wrapperTail + "}.call(this);".length) < 8
  ) {
    return source.slice(0, wrapperTail) + snippet + source.slice(wrapperTail);
  }
  const trainerAnchor = source.lastIndexOf("__nbTrainerAPI=");
  if (trainerAnchor !== -1) {
    return (
      source.slice(0, trainerAnchor) + snippet + source.slice(trainerAnchor)
    );
  }
  throw new Error(
    "bundled engine script anchor not found (no trailing }.call(this); and no __nbTrainerAPI= marker)"
  );
}

export function setupBundledShadowApp({ projectRoot, scan, gameKey }) {
  const scriptRel = scan.bundled && scan.bundled.scriptRel;
  if (!scriptRel)
    throw new Error(
      "bundled engine script not recorded in scan (scan.bundled.scriptRel)"
    );
  const result = buildShadowApp({
    projectRoot,
    scan,
    gameKey,
    scriptRel,
    patch: patchBundledEngineScript
  });
  return {
    appDir: result.appDir,
    gameExe: result.gameExe,
    patchedScript: result.patchedPath
  };
}

export function launchBundledShadowGame(options) {
  return withIdleShadow(options, launchPreparedBundledShadowGame);
}

async function launchPreparedBundledShadowGame({
  projectRoot,
  scan,
  gameKey,
  profileDir,
  extraEnv
}) {
  const { appDir, gameExe } = setupBundledShadowApp({
    projectRoot,
    scan,
    gameKey
  });
  return spawnShadowProcess({
    gameExe,
    appDir,
    projectRoot,
    gameKey,
    args: [
      `--user-data-dir=${profileDir}`,
      `--load-extension=${path.join(projectRoot, "runtime", "bridge")}`
    ],
    env: { ...process.env, ...extraEnv }
  });
}
