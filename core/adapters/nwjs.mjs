// nwjs 家族引擎适配器: RPG Maker MV/MZ on NW.js — including the protected
// shells (nb-shell, nb-evalnwbin, enigma-nb, grover-boot), the sealed launcher
// and the bundled-engine variant. The adapter owns the family's four-piece
// interface (see CONTEXT.md 「引擎适配器」):
//
//   detect        — fingerprint contribution for the scanner
//   plan          — launch routes from the catalogue, or null for other
//                   families' scans
//   payload       — the bridge extension evaluated inside the game's V8 VM
//   capabilities  — the family's trainer capabilities, as data
//
// The fingerprint functions moved here verbatim from core/scanner.mjs and the
// route logic from core/launch-plan.mjs; both call sites are orchestrators now.

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync
} from "node:fs";
import path from "node:path";
import { hasGroverModuleMonitor } from "../grover-compat.mjs";
import {
  candidate,
  blocked,
  finishPlan,
  preflightOf
} from "../launch-routes.mjs";

const RPG_MAKER_CORE_FILES = {
  mv: "rpg_core.js",
  mz: "rmmz_core.js"
};

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

// The protection level maps THIS family's flags to a severity. It lives with
// the adapter because the flag semantics are family knowledge — the scanner
// just stores the number.
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

// Fingerprint contribution for the scanner. This family is the scanner's
// fall-through once RM2K/RGSS/EVB/Tauri are ruled out, so detect ALWAYS
// returns a contribution — with engine null when nothing NW-specific matched
// (the scanner keeps its "unknown" default then).
function detect({ root, manifest }) {
  const flags = [];
  const addFlag = (flag) => {
    if (!flags.includes(flag)) flags.push(flag);
  };

  const layout = detectLayout(root);
  const wwwDir = layout === "www" ? path.join(root, "www") : root;
  const jsDir =
    layout === "www" ? path.join(wwwDir, "js") : path.join(root, "js");
  const jsFiles = listJsDir(root, layout);

  const engine = detectEngineFromJs(jsFiles);
  const sealed = !engine && detectSealedLauncher(root);
  const nbShell = !engine && !sealed && detectNbShell(root);
  const nbEvalNwBin = !engine && !sealed && !nbShell && detectNbEvalNwBin(root);
  const enigmaNb =
    !engine &&
    !sealed &&
    !nbShell &&
    !nbEvalNwBin &&
    detectEnigmaNb(root, manifest);
  const bundled =
    !engine && !sealed && !nbShell && !nbEvalNwBin && !enigmaNb
      ? detectBundledEngine(
          firstExisting([
            path.join(wwwDir, "index.html"),
            path.join(root, "index.html")
          ]),
          wwwDir
        )
      : null;

  const contribution = {
    layout,
    engine: null,
    container: null,
    flags,
    paths: null,
    manifestInfo: null,
    title: null,
    bundled: null
  };

  if (engine) {
    contribution.engine = engine;
  } else if (sealed) {
    contribution.engine = { id: "MZ", bytecode: false, confidence: "medium" };
    contribution.container = "nwjs-sealed";
    addFlag("sealed-launcher");
  } else if (nbShell) {
    contribution.engine = { id: "MZ", bytecode: false, confidence: "low" };
    contribution.container = "nb-shell";
    addFlag("nb-shell-protected");
  } else if (nbEvalNwBin) {
    // MV or MZ is undecidable from the outside (data/ is all ciphertext); the
    // bridge reports Utils.RPGMAKER_NAME in its hello once the game boots.
    contribution.engine = { id: "MV/MZ", bytecode: false, confidence: "low" };
    contribution.container = "nb-evalnwbin";
    addFlag("nb-evalnwbin-shell");
  } else if (enigmaNb) {
    // MV or MZ is undecidable from the outside (everything is inside the box);
    // the bridge reports Utils.RPGMAKER_NAME in its hello once the game boots.
    contribution.engine = { id: "MV/MZ", bytecode: false, confidence: "low" };
    contribution.container = "enigma-nb";
    addFlag("enigma-nb-shell");
  } else if (bundled) {
    contribution.engine = {
      id: bundled.id,
      bytecode: bundled.bytecode,
      confidence: bundled.confidence
    };
    contribution.container = "nwjs-bundled";
    addFlag("bundled-engine");
    // The launcher needs to know WHICH script carries the engine: the shadow
    // copy gets the manager-publish patch, everything else is linked as-is.
    contribution.bundled = {
      scriptRel: path
        .relative(root, bundled.scriptFile)
        .split(path.sep)
        .join("/")
    };
    try {
      const indexPath = firstExisting([
        path.join(wwwDir, "index.html"),
        path.join(root, "index.html")
      ]);
      const html = indexPath ? readFileSync(indexPath, "utf8") : "";
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      if (titleMatch && titleMatch[1].trim())
        contribution.title = titleMatch[1].trim();
    } catch (_) {}
  } else if (manifest || existsSync(path.join(root, "Game.exe"))) {
    contribution.engine = {
      id: "unknown-nwjs",
      bytecode: false,
      confidence: "low"
    };
  }

  contribution.paths = {
    exe: resolveNwExe(root, manifest),
    wwwDir,
    jsDir,
    dataDir: firstExisting([
      path.join(wwwDir, "data"),
      path.join(root, "data")
    ]),
    saveDir: firstExisting([
      path.join(wwwDir, "save"),
      path.join(root, "save")
    ]),
    pluginsFile: firstExisting([path.join(jsDir, "plugins.js")]),
    indexHtml: firstExisting([
      path.join(wwwDir, "index.html"),
      path.join(root, "index.html")
    ])
  };
  // This family always knows whether a save dir was found; other families may
  // leave saveDirKnown unset (the scanner then leaves the field absent).
  contribution.saveDirKnown = !!contribution.paths.saveDir;

  if (manifest) {
    contribution.manifestInfo = {
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
      contribution.title = title;
    if (contribution.container === "nwjs-sealed" && manifest.name)
      contribution.title = manifest.name;
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

  if (contribution.engine && contribution.engine.bytecode)
    addFlag("bytecode-js");
  if (
    jsFiles.some((name) => /^plugins\.jsc$/i.test(name)) ||
    (contribution.paths.pluginsFile === null &&
      jsFiles.some((name) => /\.jsc$/i.test(name)))
  ) {
    addFlag("bytecode-plugins");
  }

  const dataEncryption = detectDataEncryption(root, layout);
  if (dataEncryption) addFlag(`data-encrypted:${dataEncryption}`);

  // Obfuscated / replaced index.html: plaintext games normally reference their
  // core scripts from index.html; guard pages hide them behind loaders.
  if (
    contribution.paths.indexHtml &&
    !(contribution.engine && contribution.engine.bytecode)
  ) {
    try {
      const html = readFileSync(contribution.paths.indexHtml, "utf8");
      const coreRef = /rpg_core\.js|rmmz_core\.js/.test(html);
      if (!coreRef) addFlag("index-obfuscated");
    } catch (_) {}
  }

  contribution.protectionLevel = computeProtectionLevel(flags);
  return contribution;
}

// --- plan -------------------------------------------------------------------

function hasFlag(scan, flag) {
  return (
    Array.isArray(scan && scan.protection && scan.protection.flags) &&
    scan.protection.flags.includes(flag)
  );
}

// Does this scan describe a member of the nwjs family? Mirrors the planner's
// historical reach: the NW containers and shells, the MV/MZ engine ids, the
// grover flag, and the manifest/exe fall-through — while never touching the
// rgss / evb / tauri families or RM2K (their planners still live in
// launch-plan.mjs until their own adapters exist).
function claims(scan) {
  const container = String((scan && scan.container) || "");
  const engine = String((scan && scan.engine && scan.engine.id) || "");
  if (container === "evb" || container === "tauri" || container === "rgss")
    return false;
  if (/^RGSS/i.test(engine) || engine === "RM2K") return false;
  if (
    container === "nwjs" ||
    /^nwjs-/i.test(container) ||
    container === "nb-shell" ||
    container === "nb-evalnwbin" ||
    container === "enigma-nb"
  )
    return true;
  if (
    engine === "unknown-nwjs" ||
    engine === "MV" ||
    engine === "MZ" ||
    engine === "MV/MZ"
  )
    return true;
  if (container) return false;
  if (hasFlag(scan, "grover-boot")) return true;
  return !!(scan && (scan.manifest || (scan.paths && scan.paths.exe)));
}

// The family's route decision, verbatim from the old planner: the nb-shell
// refusal, the sealed/bundled single-route plans, and the standard branch
// (nb-evalnwbin / enigma-nb / grover / plain NW.js). Returns null when the
// scan is not this family's.
function plan(scan = {}, { requested = "auto" } = {}) {
  if (!claims(scan)) return null;
  const route = requested || "auto";
  const container = String(scan.container || "");
  const grover = hasFlag(scan, "grover-boot");
  const bgScript = !!(scan.manifest && scan.manifest.bgScript);
  const hasExe = !!(scan.paths && scan.paths.exe);

  if (container === "nb-shell") {
    return finishPlan({
      version: 1,
      family: "unsupported-shell",
      requested: route,
      preferred: null,
      selected: null,
      candidates: [],
      blocked: [
        blocked("shadow", "nb-shell 会校验启动文件并检测 DLL 注入"),
        blocked("extension", "nb-shell 拒绝启动参数")
      ],
      error: "nb-shell protected game: 没有存活的工具箱启动路线"
    });
  }

  if (container === "nwjs-sealed" || container === "nwjs-bundled") {
    const special =
      container === "nwjs-sealed"
        ? candidate("extension-cdp-seed")
        : candidate("shadow-engine-publish");
    const engine = String((scan.engine && scan.engine.id) || "");
    return finishPlan({
      version: 1,
      family: "special",
      requested: route,
      preferred: special.id,
      selected: special.id,
      candidates: [special],
      blocked: [
        blocked("shadow", "该游戏使用专用容器路线，不能套用普通影子目录"),
        blocked("dll", "该游戏使用专用容器路线，不能套用普通 MV/MZ DLL 路线"),
        blocked("extension", "该游戏使用专用容器路线，不能套用普通扩展启动")
      ],
      override:
        route !== "auto"
          ? `请求的 ${route} 不适用于 ${container || engine}，已使用专用路线 ${special.id}`
          : null
    });
  }

  const candidates = [];
  const blockedRoutes = [];

  if (container === "nb-evalnwbin") {
    candidates.push(
      candidate("dll", "NB evalNWBin 拒绝启动参数，只接受裸启动后 DLL 注入")
    );
    blockedRoutes.push(
      blocked("shadow", "该壳会因启动参数退出"),
      blocked("extension", "该壳会因启动参数退出")
    );
  } else if (container === "enigma-nb") {
    candidates.push(
      candidate("dll", "Enigma-NB 对任何启动参数敏感，采用裸启动后 DLL 注入")
    );
    blockedRoutes.push(
      blocked("shadow", "Enigma-NB 会因启动参数退出"),
      blocked("extension", "Enigma-NB 会因启动参数退出")
    );
  } else if (grover) {
    candidates.push(
      candidate("dll", "Grover 启动链需要裸启动并等待保护检查结束后注入")
    );
    // Keep an explicit shadow request visible even when a sparse scan/test
    // fixture omitted the manifest.  The launcher will perform the final
    // bg-script preflight and report its precise error; silently converting
    // that explicit request to DLL would hide the user's choice.
    candidates.push(
      candidate(
        "shadow",
        bgScript
          ? "该游戏有可补丁的 bg-script，影子目录可作为显式备用路线"
          : "影子路线已被显式请求，但启动前仍需发现 bg-script"
      )
    );
    if (!bgScript)
      blockedRoutes.push(
        blocked("shadow-preflight", preflightOf(scan, "shadow").reason)
      );
    blockedRoutes.push(
      blocked("extension", "Grover 对带启动参数的扩展启动不稳定")
    );
  } else {
    if (bgScript) {
      candidates.push(candidate("shadow"));
    } else {
      blockedRoutes.push(blocked("shadow", preflightOf(scan, "shadow").reason));
    }
    candidates.push(candidate("extension"));
    candidates.push(
      candidate("dll", "标准 NW.js 可裸启动后向 renderer 投递 native bridge")
    );
  }

  // A static scan cannot prove the executable is runnable. Keep the route in
  // the plan so the launcher can report the missing preflight item instead of
  // silently selecting a different transport.
  if (!hasExe) {
    blockedRoutes.push(
      blocked(
        "preflight",
        "扫描结果没有确定的游戏 EXE，启动前必须先解决入口歧义"
      )
    );
  }

  const preferred = (candidates[0] && candidates[0].id) || null;
  let selected = preferred;
  let override = null;
  if (route !== "auto") {
    const requestedCandidate = candidates.find((entry) => entry.id === route);
    if (requestedCandidate) {
      selected = requestedCandidate.id;
    } else if (
      (container === "nb-evalnwbin" || container === "enigma-nb" || grover) &&
      route !== "dll" &&
      preferred === "dll"
    ) {
      // Preserve the old public behaviour: a generic/extension request on a
      // shell is translated to its only safe route, with the override made
      // visible in the plan instead of being an unexplained dispatch.
      selected = preferred;
      override = `请求的 ${route} 被保护壳拒绝，已改用 ${preferred}`;
    } else {
      selected = null;
    }
  }

  const result = {
    version: 1,
    family: grover
      ? "grover-nwjs"
      : container === "nb-evalnwbin"
        ? "nb-evalnwbin"
        : container === "enigma-nb"
          ? "enigma-nb"
          : "standard-nwjs",
    requested: route,
    preferred,
    selected,
    candidates,
    blocked: blockedRoutes,
    override,
    readiness: {
      required: ["process", "bridge-hello", "runtime-ready"],
      fallbackOnlyBefore: "bridge-hello"
    }
  };
  if (!selected) {
    result.error = `请求的启动路线 ${route} 不适用于此游戏；可用路线：${candidates.map((entry) => entry.id).join(", ") || "无"}`;
  }
  return finishPlan(result);
}

// --- payload & capabilities ---------------------------------------------------

// The family payload is the NW.js bridge extension: content.js evals
// page-bridge.js inside the game's own V8 isolate.
const payload = Object.freeze({
  kind: "nwjs-extension",
  dir: "runtime/bridge",
  entry: "page-bridge.js",
  language: "js"
});

// Trainer capabilities, grounded in the bridge command surface
// (runtime/bridge/src/parts/*-commands-*.js): variable/switch/selfSwitch/gold/
// item/actor/party/save/map/event/battle/scene/console/lock/asset namespaces.
const capabilities = Object.freeze([
  "variables",
  "switches",
  "self-switches",
  "gold",
  "items",
  "actors",
  "party",
  "saves",
  "map",
  "events",
  "battle",
  "scene",
  "console",
  "locks",
  "assets"
]);

export const nwjsAdapter = Object.freeze({
  id: "nwjs",
  label: "RPG Maker MV/MZ（NW.js）",
  detect,
  plan,
  payload,
  capabilities
});
