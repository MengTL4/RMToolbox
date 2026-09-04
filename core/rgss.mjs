// RGSS (RPG Maker XP / VX / VX Ace) support: detection, shadow build, injection.
//
// Injection strategy: the bridge is spliced into the game's Scripts archive as
// an extra entry, placed BEFORE the entry that calls rgss_main (that call never
// returns, so anything after it is dead code). The patched archive is written
// into a shadow copy of the game -- original files are never touched.

import {
  existsSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  linkSync,
  symlinkSync,
  copyFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parseScripts, insertScriptEntry, findMainEntryIndex } from "./rgss-marshal.mjs";
import { extractEntry, patchEntry } from "./rgss-archive.mjs";

export class RgssError extends Error {}

// RGSS1 (XP) -> Ruby 1.8.1, RGSS2 (VX) -> Ruby 1.8.1, RGSS3 (VX Ace) -> 1.9.2.
// The trailing letter is the DLL's region tag: stock English builds end in E,
// Japanese/custom-engine builds in J (RGSS103J — 武界风云传's engine).
const LIBRARY_PATTERNS = [
  { version: "RGSS3", dll: /^rgss30\d+[ej]?\.dll$/i, scripts: "Scripts.rvdata2", archive: "Game.rgss3a", ruby19: true },
  { version: "RGSS2", dll: /^rgss20\d+[ej]?\.dll$/i, scripts: "Scripts.rvdata", archive: "Game.rgss2a", ruby19: false },
  { version: "RGSS1", dll: /^rgss10\d+[ej]?\.dll$/i, scripts: "Scripts.rxdata", archive: "Game.rgssad", ruby19: false }
];

export function parseIni(text) {
  const result = {};
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    result[section ? `${section}.${key}` : key] = value;
  }
  return result;
}

/**
 * Inspect a game directory for an RGSS engine.
 * Returns null when it is not an RGSS game.
 */
export function detectRgss(gameRoot) {
  const iniPath = path.join(gameRoot, "Game.ini");
  if (!existsSync(iniPath)) return null;
  const ini = parseIni(readFileSync(iniPath, "utf8"));
  const library = ini["Game.Library"] || "";
  const dll = path.basename(library.replace(/\\/g, "/"));

  const match = LIBRARY_PATTERNS.find((entry) => entry.dll.test(dll));
  if (!match) return null;

  const scriptsRel = (ini["Game.Scripts"] || `Data\\${match.scripts}`).replace(/\\/g, "/");
  const archivePath = path.join(gameRoot, match.archive);
  const hasArchive = existsSync(archivePath);
  const looseScripts = path.join(gameRoot, scriptsRel);

  if (!hasArchive && !existsSync(looseScripts)) {
    throw new RgssError(
      `RGSS game has neither ${match.archive} nor ${scriptsRel}: ${gameRoot}`
    );
  }

  // mkxp-z ports keep a GBK-encoded Game.ini whose Title decodes to mojibake;
  // their mkxp.json windowTitle is proper UTF-8 and wins when present
  // （宝可梦赤途： Game.ini title is garbage, windowTitle is "宝可梦赤途…").
  let title = ini["Game.Title"] || "";
  try {
    const mkxp = JSON.parse(readFileSync(path.join(gameRoot, "mkxp.json"), "utf8"));
    if (mkxp && typeof mkxp.windowTitle === "string" && mkxp.windowTitle.trim()) {
      title = mkxp.windowTitle.trim();
    }
  } catch (_) {}

  return {
    engine: match.version,
    ruby19: match.ruby19,
    library: dll,
    title: title || path.basename(gameRoot),
    rtp: [ini["Game.RTP"] || "", ini["Game.RTP1"] || "", ini["Game.RTP2"] || "", ini["Game.RTP3"] || ""]
      .filter(Boolean),
    scriptsRel,
    hasArchive,
    archivePath: hasArchive ? archivePath : null,
    scriptsPath: hasArchive ? null : looseScripts,
    exe: path.join(gameRoot, "Game.exe")
  };
}

/**
 * Load the script archive bytes, reading through the encrypted container when
 * the game is packed.
 */
export function readScriptsArchive(detect) {
  if (!detect.hasArchive) return readFileSync(detect.scriptsPath);
  return extractEntry(detect.archivePath, detect.scriptsRel.replace(/\//g, "\\"));
}

/**
 * Create a shadow copy of the game: directories are junctions, files are hard
 * links, except along `replaceRel` which must stay real so a write cannot pass
 * through into the original game.
 */
export function buildShadow({ gameRoot, shadowRoot, replaceRel, copyFiles = [] }) {
  if (existsSync(shadowRoot)) {
    throw new RgssError(`shadow already exists: ${shadowRoot}`);
  }
  mkdirSync(shadowRoot, { recursive: true });

  const replaceParts = replaceRel ? replaceRel.split("/") : [];
  const replaceTop = replaceParts[0] || null;

  const copySet = new Set(copyFiles.map((name) => name.toLowerCase()));

  const linkEntry = (source, dest, depth) => {
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) {
      // Junctions/symlinks already in the game root (e.g. a save dir anchored
      // to another folder) must be recreated as links: lstat reports them as
      // non-directories, so without this branch they fall through to
      // linkSync/copyFileSync, both of which fail on a directory reparse
      // point (EPERM).
      symlinkSync(readlinkSync(source), dest, "junction");
      return;
    }
    if (stat.isDirectory()) {
      // Along the path to the replaced file we need real directories.
      if (replaceTop && path.basename(source) === replaceTop && depth === 0) {
        mkdirSync(dest, { recursive: true });
        for (const child of readdirSync(source)) {
          if (replaceParts.length > 1 && child === replaceParts[1]) continue;
          if (replaceParts.length === 1 && child === replaceParts[0]) continue;
          linkEntry(path.join(source, child), path.join(dest, child), depth + 1);
        }
        return;
      }
      symlinkSync(source, dest, "junction");
      return;
    }
    // A replaced file sitting directly in the game root (Game.ini points
    // Scripts= at a top-level file) must not be linked either: injectBridge
    // rewrites the dest in place, and a hard link would write through into
    // the original game.
    if (replaceParts.length === 1 && depth === 0 && path.basename(source) === replaceParts[0]) {
      return;
    }
    if (copySet.has(path.basename(source).toLowerCase())) {
      copyFileSync(source, dest); // must be writable in place
      return;
    }
    try {
      linkSync(source, dest);
    } catch (_) {
      copyFileSync(source, dest);
    }
  };

  for (const entry of readdirSync(gameRoot)) {
    linkEntry(path.join(gameRoot, entry), path.join(shadowRoot, entry), 0);
  }
  return shadowRoot;
}

/**
 * Substitute the __RMCH_* placeholders in bridge.rb. Shared by the shadow
 * launch flow (injectBridge) and the attach flow (core/attach.mjs) so both
 * render the exact same bridge source.
 */
export function renderBridgeSource(bridgeSource, { port, token, gameKey = "", realDir = "", engine, channelDir = "" }) {
  return bridgeSource
    .replace(/__RMCH_PORT__/g, String(port))
    .replace(/__RMCH_TOKEN__/g, JSON.stringify(token))
    .replace(/__RMCH_GAMEKEY__/g, JSON.stringify(gameKey))
    .replace(/__RMCH_REALDIR__/g, JSON.stringify(realDir))
    .replace(/__RMCH_GENERATION__/g, engine)
    .replace(/__RMCH_CHANNELDIR__/g, JSON.stringify(channelDir));
}

/**
 * Splice the bridge into a script archive and write it into the shadow.
 */
export function injectBridge({ detect, shadowRoot, bridgeSource, port, token, gameKey = "", realDir = "" }) {
  const raw = readScriptsArchive(detect);
  const parsed = parseScripts(raw);
  const insertAt = findMainEntryIndex(parsed, (buf) => zlib.inflateSync(buf));

  const code = renderBridgeSource(bridgeSource, {
    port, token, gameKey, realDir, engine: detect.engine
  });

  const payload = zlib.deflateSync(Buffer.from(code, "utf8"));
  const spliced = insertScriptEntry(raw, insertAt, 9_000_001, "RMCH_Bridge", payload, {
    nameIvar: detect.ruby19,
    bodyIvar: parsed.bodyIvar
  });

  if (detect.hasArchive) {
    const archiveName = path.basename(detect.archivePath);
    const dest = path.join(shadowRoot, archiveName);
    const result = patchEntry({
      src: detect.archivePath,
      dst: dest,
      entry: detect.scriptsRel.replace(/\//g, "\\"),
      data: spliced
    });
    if (!result.verify) throw new RgssError("archive patch failed verification");
    return { mode: "archive", insertAt, archive: dest };
  }

  const dest = path.join(shadowRoot, detect.scriptsRel);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, spliced);
  return { mode: "loose", insertAt, scripts: dest };
}

/**
 * Full prepare step: detect, shadow, inject. Returns everything the launcher
 * needs to start the game.
 */
export function prepareRgssGame({ gameRoot, projectRoot, gameKey, port, token }) {
  const detect = detectRgss(gameRoot);
  if (!detect) throw new RgssError(`not an RGSS game: ${gameRoot}`);

  const shadowRoot = path.join(projectRoot, "runtime", "rgss-shadow", gameKey);
  const replaceRel = detect.hasArchive ? null : detect.scriptsRel;
  const copyFiles = detect.hasArchive ? [path.basename(detect.archivePath)] : [];

  buildShadow({ gameRoot, shadowRoot, replaceRel, copyFiles });

  const bridgeSource = readFileSync(
    path.join(projectRoot, "runtime", "rgss-bridge", "bridge.rb"),
    "utf8"
  );

  const injected = injectBridge({ detect, shadowRoot, bridgeSource, port, token, gameKey, realDir: gameRoot });

  return {
    detect,
    shadowRoot,
    injected,
    exe: path.join(shadowRoot, "Game.exe")
  };
}
