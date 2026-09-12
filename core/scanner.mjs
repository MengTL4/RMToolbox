// RMCH game scanner: identify RPG Maker engine family, layout and protection level
// for a local single-player game directory. Pure Node, zero dependencies.
//
// The scanner is an orchestrator (ADR 0002): each game family's fingerprints
// live in that family's engine adapter (core/adapters/), not here. The
// families below without an adapter yet (RM2K / RGSS / EVB / Tauri) keep their
// legacy detectors inline until their own adapters land.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { detectRgss } from "./rgss.mjs";
import { detectEvb } from "./evb-unpack.mjs";
import { probeTauriShell } from "./tauri-cdp.mjs";
import { detectWithAdapters } from "./adapters/index.mjs";

const RGSS_DLL_RE = /^rgss\d*[a-z]*\.dll$/i;

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
  // RGSS: the engine DLL may live in the RTP instead of the game root, so
  // trust Game.ini's Library field (via detectRgss) and use the on-disk DLL
  // only as a fallback hint.
  let rgss = null;
  try {
    rgss = detectRgss(resolvedRoot);
  } catch (_) {}
  const rgssDll = rgss
    ? null
    : rootFiles.find((name) => RGSS_DLL_RE.test(name));
  if (rgss || rgssDll) {
    result.engine = {
      id: rgss ? rgss.engine : "RGSS",
      bytecode: false,
      confidence: rgss ? "high" : "medium"
    };
    if (rgss) {
      if (rgss.title) result.title = rgss.title;
      result.rgss = {
        scriptsRel: rgss.scriptsRel,
        hasArchive: rgss.hasArchive,
        rtp: rgss.rtp,
        library: rgss.library
      };
      // Saves sit next to Game.exe (vanilla layout) or in a SaveData/
      // subdirectory (custom save systems). Only report a dir that exists.
      if (rgss) {
        const saveDataDir = path.join(resolvedRoot, "SaveData");
        if (existsSync(saveDataDir) && statSync(saveDataDir).isDirectory()) {
          result.paths.saveDir = saveDataDir;
        } else if (
          rootFiles.some((name) =>
            /^save\d+\.(rxdata|rvdata|rvdata2)$/i.test(name)
          )
        ) {
          result.paths.saveDir = resolvedRoot;
        }
        result.saveDirKnown = !!result.paths.saveDir;
      }
    }
    result.paths.exe = firstExisting([
      path.join(resolvedRoot, "Game.exe"),
      path.join(resolvedRoot, "Game-JP.exe")
    ]);
    result.protection.level = 0;
    return result;
  }

  // --- Enigma Virtual Box single-file games ----------------------------------
  // One big exe carrying .enigma1/.enigma2 PE sections; the real game lives in
  // its embedded virtual filesystem (宝可梦赤途: a 2.9GB exe holding an mkxp-z
  // Pokemon Essentials tree). Only probed when nothing else matched — the PE
  // header read is cheap, but pointless once an engine was identified. The
  // launcher unpacks to <exe base>_unpacked and continues as plain RGSS.
  if (!manifest && result.engine.id === "unknown") {
    for (const name of rootFiles) {
      if (!/\.exe$/i.test(name)) continue;
      const exePath = path.join(resolvedRoot, name);
      const evb = detectEvb(exePath);
      if (!evb) continue;
      result.engine = { id: "RGSS", bytecode: false, confidence: "medium" };
      result.container = "evb";
      result.evb = { exeName: name, exePath, arch: evb.arch };
      addFlag("evb-packed");
      result.title = name.replace(/\.exe$/i, "");
      result.paths.exe = exePath;
      const saveDir = path.join(resolvedRoot, "save");
      if (existsSync(saveDir) && statSync(saveDir).isDirectory()) {
        result.paths.saveDir = saveDir;
        result.saveDirKnown = true;
      }
      result.protection.level = 0; // evb-packed / tauri-webview2 carry no severity weight
      return result;
    }
  }

  // --- Tauri-shelled games (WebView2) -------------------------------------------
  // No www/, no package.json, no RGSS — a single Tauri exe whose rodata carries
  // the WRY browser-args string. The YanBin "RPG Maker Builder" family ships a
  // real MV or MZ runtime this way; its arc_img/arc_audio hash-dirs are a cheap
  // signature. Case-sensitive name check on purpose: the NW.js block below uses
  // existsSync("Game.exe"), which a lowercase tauri game.exe satisfies on
  // Windows and would otherwise be mislabeled "unknown-nwjs".
  const hasArcDirs = ["arc_img", "arc_audio"].every((name) => {
    try {
      return statSync(path.join(resolvedRoot, name)).isDirectory();
    } catch (_) {
      return false;
    }
  });
  const tauriExeName = rootFiles.includes("game.exe")
    ? "game.exe"
    : hasArcDirs
      ? rootFiles.find((name) => /\.exe$/i.test(name))
      : null;
  if (!manifest && tauriExeName) {
    const exePath = path.join(resolvedRoot, tauriExeName);
    const probe = probeTauriShell(exePath, { deep: hasArcDirs });
    if (probe.isTauri) {
      result.engine = {
        id: "MV/MZ",
        bytecode: false,
        confidence: hasArcDirs ? "medium" : "low"
      };
      result.container = "tauri";
      result.tauri = { exeName: tauriExeName, patchable: !!probe.anchor };
      addFlag("tauri-webview2");
      result.paths.exe = exePath;
      const tauriSaveDir = path.join(resolvedRoot, "save");
      if (existsSync(tauriSaveDir) && statSync(tauriSaveDir).isDirectory()) {
        result.paths.saveDir = tauriSaveDir;
      }
      result.saveDirKnown = !!result.paths.saveDir;
      result.protection.level = 0; // evb-packed / tauri-webview2 carry no severity weight
      return result;
    }
  }

  // --- Adapter-mediated families ---------------------------------------------
  // Ask the registered engine adapters (core/adapters/). The nwjs adapter is
  // the fall-through: it always answers, and fills the NW-style path block
  // even when nothing NW-specific matched (engine stays "unknown" then).
  const detected = detectWithAdapters({
    root: resolvedRoot,
    manifest,
    rootFiles
  });
  if (detected) {
    if (detected.engine) result.engine = detected.engine;
    if (detected.container) result.container = detected.container;
    if (detected.layout) result.layout = detected.layout;
    if (detected.paths) result.paths = detected.paths;
    if (detected.manifestInfo) result.manifest = detected.manifestInfo;
    if (detected.title) result.title = detected.title;
    if (detected.bundled) result.bundled = detected.bundled;
    for (const flag of detected.flags || []) addFlag(flag);
    // The flag→level semantics are the family's own knowledge; the adapter
    // reports the level alongside its flags.
    result.protection.level = detected.protectionLevel ?? 0;
  }

  result.saveDirKnown = !!result.paths.saveDir;
  return result;
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
    vdfCandidates.unshift(
      path.join(steamRoot, "steamapps", "libraryfolders.vdf")
    );
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
        if (existsSync(library) && !libraries.includes(library))
          libraries.push(library);
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
        if (info.engine.id !== "unknown" && info.engine.id !== "unknown-nwjs")
          games.push(info);
      } catch (_) {}
    }
  } catch (_) {}
  return games;
}
