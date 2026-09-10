// RMCH game scanner: identify RPG Maker engine family, layout and protection level
// for a local single-player game directory. Pure Node, zero dependencies.

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync
} from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { detectRgss } from "./rgss.mjs";
import { detectEvb } from "./evb-unpack.mjs";
import { probeTauriShell } from "./tauri-cdp.mjs";
import { hasGroverModuleMonitor } from "./grover-compat.mjs";

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
  if (
    existsSync(path.join(root, "js")) &&
    existsSync(path.join(root, "index.html"))
  )
    return "root";
  return "root";
}

function listJsDir(root, layout) {
  const dir =
    layout === "www" ? path.join(root, "www", "js") : path.join(root, "js");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir);
  } catch (_) {
    return [];
  }
}

function detectEngineFromJs(jsFiles) {
  const names = new Set(jsFiles.map((name) => name.toLowerCase()));
  if (names.has(RPG_MAKER_CORE_FILES.mz))
    return { id: "MZ", bytecode: false, confidence: "high" };
  if (names.has(RPG_MAKER_CORE_FILES.mv))
    return { id: "MV", bytecode: false, confidence: "high" };
  const hasBundleLoader = names.has("bundle-loader.js");
  const hasJscPak = jsFiles.some(
    (name) => /\.jsc\.pak$/i.test(name) || /\.jsc$/i.test(name)
  );
  if (hasBundleLoader || hasJscPak) {
    return { id: "MV/MZ", bytecode: true, confidence: "low" };
  }
  return null;
}

// Sealed-launcher MZ games (停不下来的轮回 family): the MZ engine ships as one
// obfuscated IIFE in game.js, executed by a Vite launcher page after an md5
// check against game.md5. No rmmz_core.js / plugins.js exists, so the plain JS
// scan calls it unknown — this fingerprint catches the family: the launcher's
// game.* container files plus an MZ runtime fingerprint (the stock MZ library
// set in js/libs, or MZ-format saves on disk).
function detectSealedLauncher(root) {
  for (const marker of ["game.js", "game.data", "game.version", "game.md5"]) {
    if (!existsSync(path.join(root, marker))) return false;
  }
  const libsDir = path.join(root, "js", "libs");
  try {
    if (
      readdirSync(libsDir).some((name) =>
        /^(pixi|effekseer|vorbisdecoder)/i.test(name)
      )
    )
      return true;
  } catch (_) {}
  const saveDir = path.join(root, "save");
  try {
    if (readdirSync(saveDir).some((name) => /\.rmmzsave$/i.test(name)))
      return true;
  } catch (_) {}
  return false;
}

// NB-shell protected games (重装机兵-宿敌 family): the whole engine ships
// encrypted inside nb_data/ and is booted by a Themida-packed native addon
// (nbtool.node) that index.html requires for bootEncryptedBin(). Measured on
// 宿敌 v3.5.3 (see ACCEPTANCE v0.6.3): the shell hash-verifies its boot files
// (package.json, index.html), rejects ANY extra launch flag, kills processes
// whose ancestry contains node.exe, detects CreateRemoteThread DLL injection
// within seconds, and requires its parent process to stay alive. Every
// injection vector the toolbox has is fatal to it — detection exists so the
// toolbox can refuse cleanly instead of getting the user's game killed.
function detectNbShell(root) {
  if (!existsSync(path.join(root, "nb_data", "nbtool.node"))) return false;
  const indexHtml = firstExisting([
    path.join(root, "index.html"),
    path.join(root, "www", "index.html")
  ]);
  if (!indexHtml) return false;
  try {
    return /bootEncryptedBin/.test(readFileSync(indexHtml, "utf8"));
  } catch (_) {
    return false;
  }
}

// Bundled-engine games (命运II离线版 / Metal Max II Restored family): the whole
// RPG Maker runtime is packed into one combined classic script wrapped in a
// single `(function(){...}.call(this))` closure, so NOTHING engine-named —
// no $data*, no $game*, no managers — ever reaches window (measured on
// 命运II离线版: even $dataItems is undefined on window; the bridge's catalog
// tap is what carried the data tabs). Detect by the engine fingerprint inside
// the scripts index.html loads; the launcher then runs the game from a shadow
// copy whose engine script carries a manager/global-publish patch
// (core/shadow-launcher.mjs, setupBundledShadowApp).
function detectBundledEngine(indexHtmlPath, wwwDir) {
  if (!indexHtmlPath) return null;
  let html;
  try {
    html = readFileSync(indexHtmlPath, "utf8");
  } catch (_) {
    return null;
  }
  const marker = /RPGMAKER_NAME\s*[:=]\s*"(MV|MZ)"/;
  const scripts = [];
  const srcRe = /<script[^>]+src\s*=\s*"([^"]+\.js)"/gi;
  let match;
  while ((match = srcRe.exec(html)) && scripts.length < 12) {
    const file = path.join(wwwDir, match[1]);
    if (existsSync(file)) scripts.push(file);
  }
  for (const file of scripts) {
    try {
      const text = readFileSync(file, "utf8");
      const found = text.match(marker);
      if (found)
        return {
          id: found[1],
          bytecode: false,
          confidence: "medium",
          scriptFile: file
        };
    } catch (_) {}
  }
  return null;
}

// NB-shell evalNWBin variant (万族穿越-源启崛起 family): same nb_data/ layout
// as the Themida variant above, but the engine is a V8 bytecode blob (hashed,
// extensionless) loaded via nw.Window.get().evalNWBin() from an OBFUSCATED
// index.html — the string "evalNWBin"/"bootEncryptedBin" never appears in
// plaintext, so detection keys on the layout instead: a hashed-name native
// addon (md5-style .node, NOT nbtool.node) plus a hashed extensionless blob.
// Measured on v1.2.2 (see ACCEPTANCE v0.6.7): no Themida, no boot-file hash
// check, no LoadLibrary reaction — but ANY extra launch flag dies at boot and
// ANY in-page WebSocket construct hangs the renderer, so the toolbox uses
// plain spawn + DLL attach + the bridge's JSONL file channel for this variant.
function detectNbEvalNwBin(root) {
  const nbDir = path.join(root, "nb_data");
  if (!existsSync(path.join(nbDir, "nbtool.node"))) {
    let entries;
    try {
      entries = readdirSync(nbDir);
    } catch (_) {
      return false;
    }
    const hashedNode = entries.some((name) =>
      /^[0-9a-f]{32}\.node$/i.test(name)
    );
    const hashedBlob = entries.some((name) => /^[0-9a-f]{32}$/i.test(name));
    if (hashedNode && hashedBlob) return true;
  }
  return false;
}

// Enigma-NB variant (三国修仙传 family): same nb_data/ hashed-resource layout
// as the other NB shells, but the EXE itself is an Enigma Protector box
// (~460MB file box embedded, engine JS inside). Measured on 三国修仙传 V1.91:
// ANY command-line flag (debug port / user-data-dir / load-extension) makes
// the box exit 0 within 10–25s, so "launch" is a flag-free spawn + DLL attach.
// Fingerprint: nb_data/ full of md5-named extensionless files (no nbtool.node,
// no hashed .node — those are the other two NB families) PLUS an exe whose
// tail carries the Enigma taggant (TAGG + "Enigma Protector" cert string) and
// whose PE sections are mostly unnamed and RWX.
function hasEnigmaTaggant(exePath) {
  let fd;
  try {
    fd = openSync(exePath, "r");
  } catch (_) {
    return false;
  }
  try {
    const head = Buffer.alloc(4096);
    if (readSync(fd, head, 0, 4096, 0) < 4096) return false;
    if (head.toString("latin1", 0, 2) !== "MZ") return false;
    const pe = head.readUInt32LE(0x3c);
    if (head.toString("latin1", pe, pe + 4) !== "PE\0\0") return false;
    const numSec = head.readUInt16LE(pe + 6);
    const optSize = head.readUInt16LE(pe + 20);
    let off = pe + 24 + optSize;
    if (numSec < 5 || off + numSec * 40 > 4096) return false;
    let unnamedRwx = 0;
    for (let i = 0; i < numSec; i += 1) {
      const name = head
        .toString("latin1", off + i * 40, off + i * 40 + 8)
        .replace(/\0+$/, "");
      const chars = head.readUInt32LE(off + i * 40 + 36);
      const rwx =
        chars & 0x80000000 && chars & 0x40000000 && chars & 0x20000000;
      if (!name && rwx) unnamedRwx += 1;
    }
    if (unnamedRwx < 3) return false;
    // The taggant is a PKCS#7 blob appended near EOF: "TAGG\0" plus the
    // "Enigma Protector CA" certificate string. 16MB covers boxes whose
    // embedded file box ends well before the signature.
    const size = statSync(exePath).size;
    const tailLen = Math.min(size, 16 * 1024 * 1024);
    const tail = Buffer.alloc(tailLen);
    if (readSync(fd, tail, 0, tailLen, size - tailLen) < tailLen) return false;
    return (
      tail.includes(Buffer.from("TAGG")) &&
      tail.includes(Buffer.from("Enigma Protector"))
    );
  } catch (_) {
    return false;
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } catch (_) {}
  }
}

function detectEnigmaNb(root, manifest) {
  const nbDir = path.join(root, "nb_data");
  let entries;
  try {
    entries = readdirSync(nbDir);
  } catch (_) {
    return false;
  }
  if (entries.includes("nbtool.node")) return false; // nb-shell family
  if (entries.some((name) => /^[0-9a-f]{32}\.node$/i.test(name))) return false; // nb-evalnwbin
  const hashed = entries.filter((name) => /^[0-9a-f]{32}$/i.test(name));
  if (hashed.length < 2) return false;
  const exe = resolveNwExe(root, manifest);
  return !!(exe && hasEnigmaTaggant(exe));
}

// The exe behind an NW.js game is not always Game.exe: sealed launchers name it
// after the manifest (停不下来的轮回.exe), and some titles ship exactly one
// other exe. Junk filter keeps installers/uninstallers out of the fallback.
function resolveNwExe(root, manifest) {
  const candidates = [path.join(root, "Game.exe")];
  const manifestName = manifest && manifest.name;
  if (manifestName && !/[\\/:*?"<>|]/.test(manifestName)) {
    candidates.push(path.join(root, `${manifestName}.exe`));
  }
  const direct = firstExisting(candidates);
  if (direct) return direct;
  let exes;
  try {
    exes = readdirSync(root).filter((name) => /\.exe$/i.test(name));
  } catch (_) {
    return null;
  }
  const junk =
    /unins|setup|install|crash|redist|vc_redist|dxsetup|dotnet|launch|update|patch/i;
  const real = exes.filter(
    (name) => !junk.test(name) && !/^notification_helper\.exe$/i.test(name)
  );
  return real.length === 1 ? path.join(root, real[0]) : null;
}

// nwjc-compiled V8 bytecode blob (NW.js source protection): every JS payload
// file starts with the magic 03 04 DE C0 instead of script text.
function isNwjcBytecode(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const head = Buffer.alloc(4);
    if (readSync(fd, head, 0, 4, 0) < 4) return false;
    return (
      head[0] === 0x03 &&
      head[1] === 0x04 &&
      head[2] === 0xde &&
      head[3] === 0xc0
    );
  } catch (_) {
    return false;
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } catch (_) {}
  }
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
      if (
        files.some((name) => /\.json$/i.test(name)) &&
        looksLikeEncryptedData(dataDir)
      )
        return "encrypted-json";
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
      result.protection.level = computeProtectionLevel(flags);
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
      result.protection.level = computeProtectionLevel(flags);
      return result;
    }
  }

  // --- NW.js RPG Maker family ------------------------------------------------
  const layout = detectLayout(resolvedRoot);
  result.layout = layout;
  const wwwDir =
    layout === "www" ? path.join(resolvedRoot, "www") : resolvedRoot;
  const jsDir =
    layout === "www" ? path.join(wwwDir, "js") : path.join(resolvedRoot, "js");
  const jsFiles = listJsDir(resolvedRoot, layout);

  const engine = detectEngineFromJs(jsFiles);
  const sealed = !engine && detectSealedLauncher(resolvedRoot);
  const nbShell = !engine && !sealed && detectNbShell(resolvedRoot);
  const nbEvalNwBin =
    !engine && !sealed && !nbShell && detectNbEvalNwBin(resolvedRoot);
  const enigmaNb =
    !engine &&
    !sealed &&
    !nbShell &&
    !nbEvalNwBin &&
    detectEnigmaNb(resolvedRoot, manifest);
  const bundled =
    !engine && !sealed && !nbShell && !nbEvalNwBin && !enigmaNb
      ? detectBundledEngine(
          firstExisting([
            path.join(wwwDir, "index.html"),
            path.join(resolvedRoot, "index.html")
          ]),
          wwwDir
        )
      : null;
  if (engine) {
    result.engine = engine;
  } else if (sealed) {
    result.engine = { id: "MZ", bytecode: false, confidence: "medium" };
    result.container = "nwjs-sealed";
    addFlag("sealed-launcher");
  } else if (nbShell) {
    result.engine = { id: "MZ", bytecode: false, confidence: "low" };
    result.container = "nb-shell";
    addFlag("nb-shell-protected");
  } else if (nbEvalNwBin) {
    // MV or MZ is undecidable from the outside (data/ is all ciphertext); the
    // bridge reports Utils.RPGMAKER_NAME in its hello once the game boots.
    result.engine = { id: "MV/MZ", bytecode: false, confidence: "low" };
    result.container = "nb-evalnwbin";
    addFlag("nb-evalnwbin-shell");
  } else if (enigmaNb) {
    // MV or MZ is undecidable from the outside (everything is inside the box);
    // the bridge reports Utils.RPGMAKER_NAME in its hello once the game boots.
    result.engine = { id: "MV/MZ", bytecode: false, confidence: "low" };
    result.container = "enigma-nb";
    addFlag("enigma-nb-shell");
  } else if (bundled) {
    result.engine = {
      id: bundled.id,
      bytecode: bundled.bytecode,
      confidence: bundled.confidence
    };
    result.container = "nwjs-bundled";
    addFlag("bundled-engine");
    // The launcher needs to know WHICH script carries the engine: the shadow
    // copy gets the manager-publish patch, everything else is linked as-is.
    result.bundled = {
      scriptRel: path
        .relative(resolvedRoot, bundled.scriptFile)
        .split(path.sep)
        .join("/")
    };
    try {
      const indexPath = firstExisting([
        path.join(wwwDir, "index.html"),
        path.join(resolvedRoot, "index.html")
      ]);
      const html = indexPath ? readFileSync(indexPath, "utf8") : "";
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      if (titleMatch && titleMatch[1].trim())
        result.title = titleMatch[1].trim();
    } catch (_) {}
  } else if (manifest || existsSync(path.join(resolvedRoot, "Game.exe"))) {
    result.engine = { id: "unknown-nwjs", bytecode: false, confidence: "low" };
  }

  result.paths = {
    exe: resolveNwExe(resolvedRoot, manifest),
    wwwDir,
    jsDir,
    dataDir: firstExisting([
      path.join(wwwDir, "data"),
      path.join(resolvedRoot, "data")
    ]),
    saveDir: firstExisting([
      path.join(wwwDir, "save"),
      path.join(resolvedRoot, "save")
    ]),
    pluginsFile: firstExisting([path.join(jsDir, "plugins.js")]),
    indexHtml: firstExisting([
      path.join(wwwDir, "index.html"),
      path.join(resolvedRoot, "index.html")
    ])
  };

  if (manifest) {
    result.manifest = {
      name: manifest.name || null,
      main: manifest.main || null,
      nodeMain: manifest["node-main"] || null,
      bgScript: manifest["bg-script"] || null,
      nodejs: typeof manifest.nodejs === "boolean" ? manifest.nodejs : null,
      windowTitle: (manifest.window && manifest.window.title) || null,
      chromiumArgs: manifest["chromium-args"] || ""
    };
    if (manifest["node-main"]) addFlag("node-main-guard");
    if (manifest["bg-script"]) addFlag("bg-script-startup");
    if (/--disable-devtools/i.test(manifest["chromium-args"] || ""))
      addFlag("disable-devtools");
    const title = manifest.window && manifest.window.title;
    if (title && title !== "Game" && !/^rmmz-game$/i.test(title))
      result.title = title;
    if (result.container === "nwjs-sealed" && manifest.name)
      result.title = manifest.name;
  }

  // Grover-shielded boot (傲世修仙录完结定制版 family): the whole www/js payload
  // ships as nwjc V8 bytecode (rpg_core.js itself is a 03 04 DE C0 blob) booted
  // by an obfuscated root bg-script chain. Measured on that family: the shell
  // verifies its ancestry by execing `wmic` and fails CLOSED when wmic is
  // missing (Windows 11 removed it), killing the process ~15s after boot even
  // on a stock double-click launch. The flag routes shadow launches through
  // the wmic-shim + guards strategy (core/shadow-launcher.mjs).
  if (
    manifest &&
    manifest["bg-script"] &&
    engine &&
    (engine.id === "MV" || engine.id === "MZ")
  ) {
    const coreName =
      engine.id === "MZ" ? RPG_MAKER_CORE_FILES.mz : RPG_MAKER_CORE_FILES.mv;
    if (isNwjcBytecode(path.join(jsDir, coreName))) {
      addFlag("grover-boot");
      if (hasGroverModuleMonitor(jsDir)) addFlag("grover-module-monitor");
    }
  }

  if (result.engine.bytecode) addFlag("bytecode-js");
  if (
    jsFiles.some((name) => /^plugins\.jsc$/i.test(name)) ||
    (result.paths.pluginsFile === null &&
      jsFiles.some((name) => /\.jsc$/i.test(name)))
  ) {
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
    if (flag === "nb-shell-protected") {
      level = Math.max(level, 4);
    } else if (flag === "enigma-nb-shell") {
      level = Math.max(level, 4);
    } else if (flag === "nb-evalnwbin-shell") {
      level = Math.max(level, 3);
    } else if (flag === "grover-boot") {
      level = Math.max(level, 3);
    } else if (flag === "node-main-guard" || flag === "bg-script-startup") {
      level = Math.max(level, 3);
    } else if (flag === "bytecode-js" || flag === "index-obfuscated") {
      level = Math.max(level, 2);
    } else if (
      flag.startsWith("data-encrypted") ||
      flag === "bytecode-plugins"
    ) {
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
