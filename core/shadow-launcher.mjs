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

import { spawn } from "node:child_process";
import {
  copyFileSync, // 别换成 fs 的递归拷贝 API：GUI 内嵌 Node 是 16.1，那个要 16.7 才有
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { buildBridge } from "./bridge-bundler.mjs";

const SHADOW_ROOT = path.join("runtime", "shadow-apps");
const PROFILE_ROOT = path.join("runtime", "shadow-profiles");

// Top-level entries never linked into the shadow app.
const SKIP_FILES = new Set(["debug.log", "error.log", "crash.log"]);

function jsString(value) {
  return JSON.stringify(value);
}

function linkOrCopyFile(source, dest) {
  // recursive rm: dest can be a stale junction from an older shadow layout,
  // and plain rmSync on a junction throws EISDIR on the GUI's Node 16.1.
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  try {
    linkSync(source, dest);
  } catch (_) {
    copyFileSync(source, dest);
  }
}

function junctionDir(source, dest) {
  // Node 16.1 (the GUI's embedded runtime) cannot plain-rm a junction —
  // rmSync(link, {force:true}) throws ERR_FS_EISDIR. recursive rm unlinks the
  // junction itself without following it (verified: target contents survive),
  // and equally handles real dirs left by the bg-script carve-out below.
  if (lstatSync(dest, { throwIfNoEntry: false })) rmSync(dest, { recursive: true, force: true });
  symlinkSync(source, dest, "junction");
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

function buildPrelude(gameRoot) {
  return `;(function () {
  try {
    var fs = require("fs");
    var path = require("path");
    var gameRoot = ${jsString(gameRoot)};
    process.cwd = function () { return gameRoot; };
    try {
      Object.defineProperty(process, "execPath", {
        configurable: true,
        get: function () { return path.join(gameRoot, "Game.exe"); }
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
  const stat = lstatSync(source);
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
    // (recursive rm: plain rmSync on a junction throws EISDIR on Node 16.1.)
    const existing = lstatSync(dest, { throwIfNoEntry: false });
    if (existing && existing.isSymbolicLink()) rmSync(dest, { recursive: true, force: true });
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

export function setupShadowApp({ projectRoot, scan, gameKey }) {
  const appDir = path.join(projectRoot, SHADOW_ROOT, gameKey);
  mkdirSync(appDir, { recursive: true });

  const bgScriptName = scan.manifest && scan.manifest.bgScript;
  if (!bgScriptName) throw new Error("game has no bg-script; shadow strategy does not apply");

  const originalBgScriptPath = path.join(scan.root, bgScriptName);
  if (!existsSync(originalBgScriptPath)) throw new Error(`bg-script not found: ${originalBgScriptPath}`);

  // Keep saves anchored at the real game root. For "www" layout the www
  // junction in the pass below already routes www/save to the real tree;
  // for root layout the top-level save/ entry must exist on the real side
  // before the pass so it gets junctioned instead of created fresh inside
  // the shadow (which would fork the player's saves).
  const isWwwLayout = scan.layout ? scan.layout === "www" : existsSync(path.join(scan.root, "www"));
  if (!isWwwLayout) {
    const realSaveDir = path.join(scan.root, "save");
    const shadowSaveDir = path.join(appDir, "save");
    const shadowStat = lstatSync(shadowSaveDir, { throwIfNoEntry: false });
    if (shadowStat && !shadowStat.isSymbolicLink() && shadowStat.isDirectory()) {
      // Real dir left by earlier shadow runs: merge newer files back first.
      mergeSaveFiles(shadowSaveDir, realSaveDir);
      rmSync(shadowSaveDir, { recursive: true, force: true });
    }
    mkdirSync(realSaveDir, { recursive: true });
  }

  const bgPathNorm = bgScriptName.split(/[\\/]+/).filter(Boolean).join("/");
  for (const entry of readdirSync(scan.root)) {
    if (entry === "package.json") continue;
    if (SKIP_FILES.has(entry.toLowerCase())) continue;
    if (entry === bgPathNorm) continue; // root-level bg-script: patched copy written below
    const source = path.join(scan.root, entry);
    const dest = path.join(appDir, entry);
    const relSkip = bgPathNorm.startsWith(entry + "/") ? bgPathNorm.slice(entry.length + 1) : null;
    linkShadowEntry(source, dest, relSkip);
  }
  copyFileSync(path.join(scan.root, "package.json"), path.join(appDir, "package.json"));

  // Regenerate the patched bg-script on every launch so bridge updates apply.
  const bridgePath = path.join(projectRoot, "runtime", "bridge", "page-bridge.js");
  const bridgeStateDir = path.join(projectRoot, "runtime", "bridge-state", gameKey);
  mkdirSync(bridgeStateDir, { recursive: true });
  const original = readFileSync(originalBgScriptPath, "utf8");
  const patched = buildPrelude(scan.root) + original + buildSuffix({
    bridgePath,
    logPath: path.join(bridgeStateDir, "bg-bridge.log"),
    gameKey
  });
  const patchedPath = path.join(appDir, bgScriptName);
  // bg-script may live in a subdirectory (e.g. "bg_script/boot.js"); the
  // linking pass carved its path out of the shadow, so create it fresh here.
  mkdirSync(path.dirname(patchedPath), { recursive: true });
  writeFileSync(patchedPath, patched, "utf8");

  const gameExe = path.join(appDir, "Game.exe");
  if (!existsSync(gameExe)) throw new Error(`shadow Game.exe missing: ${gameExe}`);
  return { appDir, gameExe, bgScriptPath: path.join(appDir, bgScriptName) };
}

export function launchShadowGame({ projectRoot, scan, gameKey, port, token }) {
  const { appDir, gameExe } = setupShadowApp({ projectRoot, scan, gameKey });

  // Fresh private profile per launch (matches the validated nwr behaviour).
  const profileDir = path.join(projectRoot, PROFILE_ROOT, gameKey);
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });

  const child = spawn(gameExe, [
    `--user-data-dir=${profileDir}`,
    "--force-color-profile=srgb"
  ], {
    cwd: appDir,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      RMCH_GAME_ROOT: scan.root,
      RMCH_PROJECT_ROOT: projectRoot,
      RMCH_GAME_KEY: gameKey,
      RMCH_WS_PORT: String(port),
      RMCH_WS_TOKEN: token
    },
    // No windowsHide (see launcher.mjs): SW_HIDE in STARTUPINFO makes old
    // NW.js builds create the game window invisible.
    windowsHide: false
  });
  child.unref();
  return { appDir, gameExe, profileDir, pid: child.pid };
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
  "Utils", "JsonEx",
  "DataManager", "SceneManager", "BattleManager", "ConfigManager",
  "StorageManager", "ImageManager", "AudioManager", "TextManager",
  "Scene_Map",
  "Game_BattlerBase", "Game_Battler", "Game_Actor", "Game_Actors",
  "Game_Party", "Game_Player", "Game_Enemy", "Game_Troop", "Game_Map",
  "Game_System", "Game_Screen", "Game_Temp", "Game_Switches",
  "Game_Variables", "Game_SelfSwitches", "Game_Follower", "Game_Followers",
  "Game_Event", "Game_CommonEvent", "Game_Interpreter"
];

// $data*/$game* are closure VARIABLES too (measured on 命运II离线版: nothing
// dollar-named ever reaches window — the bridge's catalog tap carried it).
// Their VALUES are replaced wholesale on new game / save load, so a static
// publish goes stale immediately: publish accessors instead, each getter
// re-reading the live closure variable via direct eval.
const BUNDLED_PUBLISH_VARS = [
  "$dataSystem", "$dataItems", "$dataWeapons", "$dataArmors", "$dataSkills",
  "$dataStates", "$dataActors", "$dataEnemies", "$dataTroops", "$dataMapInfos",
  "$dataCommonEvents", "$dataMap", "$dataClasses", "$dataAnimations",
  "$dataTilesets",
  "$gameParty", "$gameSystem", "$gameSwitches", "$gameVariables",
  "$gameSelfSwitches", "$gameActors", "$gameTroop", "$gameTemp", "$gameMap",
  "$gamePlayer", "$gameScreen", "$gameMessage"
];

function bundledPublishSnippet() {
  return ";try{var __rmchPub=" + JSON.stringify(BUNDLED_PUBLISH_NAMES) + ";"
    + "for(var __rmchI=0;__rmchI<__rmchPub.length;__rmchI++){var __rmchN=__rmchPub[__rmchI];"
    + "try{if(window[__rmchN]==null){var __rmchV=eval(__rmchN);if(__rmchV!=null)window[__rmchN]=__rmchV}}catch(e){}}"
    + "var __rmchVars=" + JSON.stringify(BUNDLED_PUBLISH_VARS) + ";"
    + "for(var __rmchJ=0;__rmchJ<__rmchVars.length;__rmchJ++){var __rmchV2=__rmchVars[__rmchJ];"
    + "try{if(window[__rmchV2]==null){(function(n){"
    + "try{eval(n);}catch(e){return;}"
    + "Object.defineProperty(window,n,{configurable:true,enumerable:true,get:function(){try{return eval(n)}catch(e){return null}}});"
    + "})(__rmchV2)}}catch(e){}}}catch(e){}\n";
}

// Patch the engine script text: insert the publish snippet INSIDE the
// bundle's closing wrapper so it can see the closure-local declarations.
// Primary anchor is the wrapper's own final `}.call(this);` (it must sit at
// the very end of the file, or the guess would land in some nested closure);
// the repacker's `__nbTrainerAPI=` tail block is the fallback anchor.
export function patchBundledEngineScript(source) {
  const snippet = bundledPublishSnippet();
  const wrapperTail = source.lastIndexOf("}.call(this)");
  if (wrapperTail !== -1 && source.length - (wrapperTail + "}.call(this);".length) < 8) {
    return source.slice(0, wrapperTail) + snippet + source.slice(wrapperTail);
  }
  const trainerAnchor = source.lastIndexOf("__nbTrainerAPI=");
  if (trainerAnchor !== -1) {
    return source.slice(0, trainerAnchor) + snippet + source.slice(trainerAnchor);
  }
  throw new Error("bundled engine script anchor not found (no trailing }.call(this); and no __nbTrainerAPI= marker)");
}

export function setupBundledShadowApp({ projectRoot, scan, gameKey }) {
  const appDir = path.join(projectRoot, SHADOW_ROOT, gameKey);
  mkdirSync(appDir, { recursive: true });
  const scriptRel = scan.bundled && scan.bundled.scriptRel;
  if (!scriptRel) throw new Error("bundled engine script not recorded in scan (scan.bundled.scriptRel)");
  const scriptRelNorm = scriptRel.split(/[\\/]+/).filter(Boolean).join("/");
  const originalScriptPath = path.join(scan.root, scriptRelNorm);
  if (!existsSync(originalScriptPath)) throw new Error(`bundled engine script not found: ${originalScriptPath}`);

  // Root-layout games save in <root>/save: make sure the real dir exists
  // BEFORE the linking pass so it is junctioned (not shadow-forked) — same
  // contract as the bg-script shadow above. www layout is covered by the
  // www junction itself.
  const isWwwLayout = scan.layout ? scan.layout === "www" : existsSync(path.join(scan.root, "www"));
  if (!isWwwLayout) {
    const realSaveDir = path.join(scan.root, "save");
    const shadowSaveDir = path.join(appDir, "save");
    const shadowStat = lstatSync(shadowSaveDir, { throwIfNoEntry: false });
    if (shadowStat && !shadowStat.isSymbolicLink() && shadowStat.isDirectory()) {
      mergeSaveFiles(shadowSaveDir, realSaveDir);
      rmSync(shadowSaveDir, { recursive: true, force: true });
    }
    mkdirSync(realSaveDir, { recursive: true });
  }

  // Link pass: the engine script's path is carved out (real directories,
  // everything else junctioned/hardlinked) so the patched copy written below
  // never lands in the real game tree.
  for (const entry of readdirSync(scan.root)) {
    if (entry === "package.json") continue;
    if (SKIP_FILES.has(entry.toLowerCase())) continue;
    if (entry === scriptRelNorm) continue; // root-level script: patched copy written below
    const source = path.join(scan.root, entry);
    const dest = path.join(appDir, entry);
    const relSkip = scriptRelNorm.startsWith(entry + "/") ? scriptRelNorm.slice(entry.length + 1) : null;
    linkShadowEntry(source, dest, relSkip);
  }
  // package.json ships unmodified (a copy, not a hardlink — never write
  // through into the real tree if a later tweak starts editing it).
  copyFileSync(path.join(scan.root, "package.json"), path.join(appDir, "package.json"));

  // Regenerate the patched engine script on every launch: the patch follows
  // bridge updates and never accumulates on the original.
  const patched = patchBundledEngineScript(readFileSync(originalScriptPath, "utf8"));
  const patchedPath = path.join(appDir, scriptRelNorm);
  mkdirSync(path.dirname(patchedPath), { recursive: true });
  writeFileSync(patchedPath, patched, "utf8");

  const gameExe = path.join(appDir, "Game.exe");
  if (!existsSync(gameExe)) throw new Error(`shadow Game.exe missing: ${gameExe}`);
  return { appDir, gameExe, patchedScript: patchedPath };
}

export function launchBundledShadowGame({ projectRoot, scan, gameKey, profileDir, extraEnv }) {
  const { appDir, gameExe } = setupBundledShadowApp({ projectRoot, scan, gameKey });
  const child = spawn(gameExe, [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${path.join(projectRoot, "runtime", "bridge")}`
  ], {
    cwd: appDir,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...extraEnv },
    // No windowsHide (see launcher.mjs): SW_HIDE in STARTUPINFO makes old
    // NW.js builds create the game window invisible.
    windowsHide: false
  });
  child.unref();
  return { appDir, gameExe, pid: child.pid };
}
