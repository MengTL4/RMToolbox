// RMCH game scanner: identify RPG Maker engine family, layout and protection level
// for a local single-player game directory. Pure Node, zero dependencies.
//
// The scanner is an orchestrator (ADR 0002): each game family's fingerprints
// live in that family's engine adapter (core/adapters/), not here. The
// families below without an adapter yet (RM2K / Tauri) keep their legacy
// detectors inline until their own adapters land.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { probeTauriShell } from "./tauri-cdp.mjs";
import { detectWithAdapters } from "./adapters/index.mjs";

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

  // --- Legacy detectors without an adapter yet --------------------------------
  const rootFiles = existsSync(resolvedRoot) ? readdirSync(resolvedRoot) : [];
  if (rootFiles.some((name) => /^rpg_rt\.exe$/i.test(name))) {
    result.engine = { id: "RM2K", bytecode: false, confidence: "high" };
    result.paths.exe = path.join(resolvedRoot, "RPG_RT.exe");
    result.protection.level = 0;
    return result;
  }

  // --- Tauri-shelled games (WebView2) -------------------------------------------
  // No www/, no package.json, no RGSS — a single Tauri exe whose rodata carries
  // the WRY browser-args string. The YanBin "RPG Maker Builder" family ships a
  // real MV or MZ runtime this way; its arc_img/arc_audio hash-dirs are a cheap
  // signature. This probe runs before the adapter section because the nwjs
  // adapter is the fall-through and would otherwise claim the directory: its
  // existsSync("Game.exe") is satisfied by a lowercase tauri game.exe on
  // Windows, which is why the name check here is case-sensitive on purpose.
  // Note this also means Tauri now probes before the rgss adapter (RGSS used
  // to run first): a directory cannot be both — Tauri shells wrap MV/MZ
  // runtimes and carry no RGSS markers — so the order swap is inert.
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
  // Ask the registered engine adapters (core/adapters/): rgss answers for
  // RGSS / mkxp / EVB-shell games, then the nwjs adapter as the fall-through
  // (it always answers, filling the NW-style path block even when nothing
  // NW-specific matched — engine stays "unknown" then).
  const detected = detectWithAdapters({
    root: resolvedRoot,
    manifest,
    rootFiles
  });
  if (detected) {
    // The key list is the contribution contract, not a convenience merge: an
    // adapter may only introduce scan fields by naming them here.
    for (const key of [
      "engine",
      "container",
      "layout",
      "paths",
      "title",
      "rgss",
      "evb",
      "bundled"
    ]) {
      if (detected[key] !== null && detected[key] !== undefined)
        result[key] = detected[key];
    }
    if (detected.manifestInfo) result.manifest = detected.manifestInfo;
    for (const flag of detected.flags || []) addFlag(flag);
    // The flag→level semantics are the family's own knowledge; the adapter
    // reports the level alongside its flags.
    result.protection.level = detected.protectionLevel ?? 0;
    // saveDirKnown is tri-state by legacy contract: the nwjs family always
    // answers it; rgss/evb leave it unset when no save dir was found.
    if (detected.saveDirKnown !== undefined)
      result.saveDirKnown = detected.saveDirKnown;
  }
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
