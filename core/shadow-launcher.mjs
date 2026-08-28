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
// writes back to them (no divergent shadow-side saves).

import { spawn } from "node:child_process";
import {
  cpSync,
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
  if (existsSync(dest)) rmSync(dest, { force: true });
  try {
    linkSync(source, dest);
  } catch (_) {
    cpSync(source, dest);
  }
}

function junctionDir(source, dest) {
  if (existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false })) {
    const stat = lstatSync(dest, { throwIfNoEntry: false });
    if (stat && stat.isSymbolicLink()) rmSync(dest, { force: true });
    else rmSync(dest, { recursive: true, force: true });
  }
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
    if (!dstStat || stat.mtimeMs > dstStat.mtimeMs) cpSync(src, dst);
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

  for (const entry of readdirSync(scan.root)) {
    if (entry === bgScriptName || entry === "package.json") continue;
    if (SKIP_FILES.has(entry.toLowerCase())) continue;
    const source = path.join(scan.root, entry);
    const dest = path.join(appDir, entry);
    const stat = lstatSync(source);
    if (stat.isDirectory()) {
      junctionDir(source, dest);
    } else if (stat.isFile()) {
      linkOrCopyFile(source, dest);
    }
  }
  cpSync(path.join(scan.root, "package.json"), path.join(appDir, "package.json"));

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
  writeFileSync(path.join(appDir, bgScriptName), patched, "utf8");

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
    windowsHide: true
  });
  child.unref();
  return { appDir, gameExe, profileDir, pid: child.pid };
}
