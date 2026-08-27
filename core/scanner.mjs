// RMCH game scanner: identify RPG Maker engine family, layout and protection level
// for a local single-player game directory. Pure Node, zero dependencies.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const RGSS_DLL_RE = /^rgss\d*[a-z]*\.dll$/i;
const RPG_MAKER_CORE_FILES = {
  mv: "rpg_core.js",
  mz: "rmmz_core.js"
};

export function sanitizeGameKey(name) {
  const cleaned = String(name || "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "game").slice(0, 60);
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (_) {
    return null;
  }
}

function firstExisting(paths) {
  for (const candidate of paths) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

// Layout: does the game keep its payload in www/ or directly in the root?
function detectLayout(root) {
  const wwwDir = path.join(root, "www");
  if (existsSync(wwwDir) && statSync(wwwDir).isDirectory()) return "www";
  if (existsSync(path.join(root, "js")) && existsSync(path.join(root, "index.html"))) return "root";
  return "root";
}

function listJsDir(root, layout) {
  const dir = layout === "www" ? path.join(root, "www", "js") : path.join(root, "js");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir);
  } catch (_) {
    return [];
  }
}

function detectEngineFromJs(jsFiles) {
  const names = new Set(jsFiles.map((name) => name.toLowerCase()));
  if (names.has(RPG_MAKER_CORE_FILES.mz)) return { id: "MZ", bytecode: false, confidence: "high" };
  if (names.has(RPG_MAKER_CORE_FILES.mv)) return { id: "MV", bytecode: false, confidence: "high" };
  const hasBundleLoader = names.has("bundle-loader.js");
  const hasJscPak = jsFiles.some((name) => /\.jsc\.pak$/i.test(name) || /\.jsc$/i.test(name));
  if (hasBundleLoader || hasJscPak) {
    return { id: "MV/MZ", bytecode: true, confidence: "low" };
  }
  return null;
}

function looksLikeEncryptedData(dataDir) {
  try {
    const files = readdirSync(dataDir).filter((name) => /\.json$/i.test(name));
    if (!files.length) return false;
    // Sample a few .json files: RPG Maker data files always start with '['.
    for (const name of files.slice(0, 5)) {
      const buffer = readFileSync(path.join(dataDir, name));
      if (buffer.length === 0) continue;
      const first = buffer[0];
      if (first !== 0x5b && first !== 0x7b) return true; // neither '[' nor '{'
    }
    return false;
  } catch (_) {
    return false;
  }
}

function detectDataEncryption(root, layout) {
  const dataDirs = [
    layout === "www" ? path.join(root, "www", "data") : path.join(root, "data"),
    path.join(root, "www") // data.pak / manifest.enc live next to data/ in some builds
  ];
  for (const dataDir of dataDirs) {
    if (!existsSync(dataDir)) continue;
    const stat = statSync(dataDir);
    if (!stat.isDirectory()) continue;
    try {
      const files = readdirSync(dataDir);
      if (files.some((name) => /\.pak$/i.test(name))) return "data.pak";
      if (files.some((name) => /\.tclh$/i.test(name))) return "tclh";
      if (files.some((name) => /\.json$/i.test(name)) && looksLikeEncryptedData(dataDir)) return "encrypted-json";
    } catch (_) {}
  }
  return null;
}

export function scanGame(root) {
  const resolvedRoot = path.resolve(root);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    throw new Error(`game root not found or not a directory: ${resolvedRoot}`);
  }
  const folderName = path.basename(resolvedRoot);
  const manifestPath = path.join(resolvedRoot, "package.json");
  const manifest = readJsonSafe(manifestPath);

  const result = {
    root: resolvedRoot,
    folderName,
    gameKey: sanitizeGameKey(folderName),
    engine: { id: "unknown", bytecode: false, confidence: "none" },
    layout: "root",
    protection: { level: 0, flags: [] },
    paths: {},
    title: folderName,
    manifest: null
  };

  const flags = result.protection.flags;
  const addFlag = (flag) => {
    if (!flags.includes(flag)) flags.push(flag);
  };

  // --- Non-NW legacy engines -------------------------------------------------
  const rootFiles = existsSync(resolvedRoot) ? readdirSync(resolvedRoot) : [];
  if (rootFiles.some((name) => /^rpg_rt\.exe$/i.test(name))) {
    result.engine = { id: "RM2K", bytecode: false, confidence: "high" };
    result.paths.exe = path.join(resolvedRoot, "RPG_RT.exe");
    result.protection.level = 0;
    return result;
  }
  const rgssDll = rootFiles.find((name) => RGSS_DLL_RE.test(name));
  if (rgssDll) {
    result.engine = { id: "RGSS", bytecode: false, confidence: "high" };
    result.paths.exe = firstExisting([
      path.join(resolvedRoot, "Game.exe"),
      path.join(resolvedRoot, "Game-JP.exe")
    ]);
    result.protection.level = 0;
    return result;
  }

  // --- NW.js RPG Maker family ------------------------------------------------
  const layout = detectLayout(resolvedRoot);
  result.layout = layout;
  const wwwDir = layout === "www" ? path.join(resolvedRoot, "www") : resolvedRoot;
  const jsDir = layout === "www" ? path.join(wwwDir, "js") : path.join(resolvedRoot, "js");
  const jsFiles = listJsDir(resolvedRoot, layout);

  const engine = detectEngineFromJs(jsFiles);
  if (engine) {
    result.engine = engine;
  } else if (manifest || existsSync(path.join(resolvedRoot, "Game.exe"))) {
    result.engine = { id: "unknown-nwjs", bytecode: false, confidence: "low" };
  }

  result.paths = {
    exe: firstExisting([path.join(resolvedRoot, "Game.exe")]),
    wwwDir,
    jsDir,
    dataDir: firstExisting([path.join(wwwDir, "data"), path.join(resolvedRoot, "data")]),
    saveDir: firstExisting([path.join(wwwDir, "save"), path.join(resolvedRoot, "save")]),
    pluginsFile: firstExisting([path.join(jsDir, "plugins.js")]),
    indexHtml: firstExisting([path.join(wwwDir, "index.html"), path.join(resolvedRoot, "index.html")])
  };

  if (manifest) {
    result.manifest = {
      name: manifest.name || null,
      main: manifest.main || null,
      nodeMain: manifest["node-main"] || null,
      bgScript: manifest["bg-script"] || null,
      nodejs: typeof manifest.nodejs === "boolean" ? manifest.nodejs : null,
      windowTitle: manifest.window && manifest.window.title || null,
      chromiumArgs: manifest["chromium-args"] || ""
    };
    if (manifest["node-main"]) addFlag("node-main-guard");
    if (manifest["bg-script"]) addFlag("bg-script-startup");
    if (/--disable-devtools/i.test(manifest["chromium-args"] || "")) addFlag("disable-devtools");
    const title = manifest.window && manifest.window.title;
    if (title && title !== "Game" && !/^rmmz-game$/i.test(title)) result.title = title;
  }

  if (result.engine.bytecode) addFlag("bytecode-js");
  if (jsFiles.some((name) => /^plugins\.jsc$/i.test(name)) || (result.paths.pluginsFile === null && jsFiles.some((name) => /\.jsc$/i.test(name)))) {
    addFlag("bytecode-plugins");
  }

  const dataEncryption = detectDataEncryption(resolvedRoot, layout);
  if (dataEncryption) addFlag(`data-encrypted:${dataEncryption}`);

  // Obfuscated / replaced index.html: plaintext games normally reference their
  // core scripts from index.html; guard pages hide them behind loaders.
  if (result.paths.indexHtml && !result.engine.bytecode) {
    try {
      const html = readFileSync(result.paths.indexHtml, "utf8");
      const coreRef = /rpg_core\.js|rmmz_core\.js/.test(html);
      if (!coreRef) addFlag("index-obfuscated");
    } catch (_) {}
  }

  result.protection.level = computeProtectionLevel(result.protection.flags);
  result.saveDirKnown = !!result.paths.saveDir;
  return result;
}

function computeProtectionLevel(flags) {
  let level = 0;
  for (const flag of flags) {
    if (flag === "node-main-guard" || flag === "bg-script-startup") {
      level = Math.max(level, 3);
    } else if (flag === "bytecode-js" || flag === "index-obfuscated") {
      level = Math.max(level, 2);
    } else if (flag.startsWith("data-encrypted") || flag === "bytecode-plugins") {
      level = Math.max(level, 1);
    }
  }
  return level;
}

const STEAM_LIBRARY_VDF_LOCATIONS = [
  "C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf",
  "C:\\Program Files\\Steam\\steamapps\\libraryfolders.vdf"
];

// Steam can be installed anywhere; on Windows the install root lives in
// HKCU\Software\Valve\Steam\SteamPath. Falls back silently when absent.
function steamInstallRoot() {
  if (process.platform !== "win32") return null;
  try {
    const output = execSync(
      "reg query HKCU\\Software\\Valve\\Steam /v SteamPath",
      { encoding: "utf8", timeout: 5000, windowsHide: true }
    );
    const match = output.match(/SteamPath\s+REG_SZ\s+(\S+)/);
    if (match) return match[1];
  } catch (_) {}
  return null;
}

export function findSteamLibraries() {
  const libraries = [];
  const vdfCandidates = [...STEAM_LIBRARY_VDF_LOCATIONS];
  const steamRoot = steamInstallRoot();
  if (steamRoot) {
    vdfCandidates.unshift(path.join(steamRoot, "steamapps", "libraryfolders.vdf"));
    vdfCandidates.unshift(path.join(steamRoot, "config", "libraryfolders.vdf"));
  }
  const vdfPath = vdfCandidates.find((candidate) => existsSync(candidate));
  if (vdfPath) {
    try {
      const text = readFileSync(vdfPath, "utf8");
      const regex = /"path"\s+"([^"]+)"/g;
      let match;
      while ((match = regex.exec(text))) {
        const library = path.join(match[1], "steamapps", "common");
        if (existsSync(library) && !libraries.includes(library)) libraries.push(library);
      }
    } catch (_) {}
  }
  return libraries;
}

export function scanLibrary(commonDir) {
  const games = [];
  try {
    for (const entry of readdirSync(commonDir)) {
      const candidate = path.join(commonDir, entry);
      if (!statSync(candidate).isDirectory()) continue;
      try {
        const info = scanGame(candidate);
        if (info.engine.id !== "unknown" && info.engine.id !== "unknown-nwjs") games.push(info);
      } catch (_) {}
    }
  } catch (_) {}
  return games;
}

export function injectionStrategy(scan) {
  if (scan.engine.id === "RM2K") return { id: "easyrpg", reason: "RM2000/2003 has no script runtime; use EasyRPG player debug menu" };
  if (scan.engine.id === "RGSS") return { id: "rgss-dll", reason: "RGSS (Ruby) needs a native hook DLL" };
  if (scan.manifest && scan.manifest.nodeMain) return { id: "extension", reason: "node-main guard tolerates --load-extension; verify game does not self-close" };
  if (scan.manifest && scan.manifest.bgScript) return { id: "extension-then-shadow", reason: "bg-script startup chain may detect extensions; fall back to shadow-dir bg-script patch" };
  return { id: "extension", reason: "standard NW.js game: --load-extension into original Game.exe" };
}
