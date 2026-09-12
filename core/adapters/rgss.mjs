// rgss 家族引擎适配器: RPG Maker XP/VX/VXAce (RGSS1/2/3), the mkxp / mkxp-z
// variant, and EVB single-file shells (which unpack to an rgss tree and then
// continue down the same rgss-script route). The family owns its fingerprints
// (detect), its route decision (plan), its Ruby bridge payload and its
// capability set. Version differences inside the family are probed at
// runtime by the bridge (GENERATION / rgss1? in bridge.rb) and reflected in
// capabilitiesFor below — there is no per-version adapter.
//
// The detection logic moved here from core/scanner.mjs and the route decision
// from core/launch-plan.mjs; both call sites orchestrate now. detect() keeps
// the legacy field-level semantics exactly (including where saveDirKnown is
// left unset), restructured into the contribution shape.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { detectRgss } from "../rgss.mjs";
import { detectEvb } from "../evb-unpack.mjs";
import { candidate, blocked, finishPlan } from "../launch-routes.mjs";

const RGSS_DLL_RE = /^rgss\d*[a-z]*\.dll$/i;

function firstExisting(paths) {
  for (const candidate of paths) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

// Fingerprint contribution for the scanner, or null when the directory is
// not this family's. Two shapes:
//   rgss  — detectRgss match (stock or mkxp variant), or the on-disk DLL as
//           a fallback hint (the DLL may live in the RTP, so Game.ini via
//           detectRgss wins; the DLL only fires when Game.ini is absent).
//   evb   — an Enigma Virtual Box single-file pack: one big exe carrying
//           .enigma1/.enigma2 PE sections; the real game is the embedded
//           rgss tree. Only probed when there is no package.json — the PE
//           read is cheap but pointless once an engine was identified.
function detect({ root, manifest, rootFiles }) {
  let rgss = null;
  try {
    rgss = detectRgss(root);
  } catch (_) {}
  const rgssDll = rgss
    ? null
    : rootFiles.find((name) => RGSS_DLL_RE.test(name));
  if (rgss || rgssDll) {
    // mkxp variants keep their own exe name; stock games resolve Game.exe /
    // Game-JP.exe.
    const exe =
      rgss && rgss.mkxp
        ? rgss.exe
        : firstExisting([
            path.join(root, "Game.exe"),
            path.join(root, "Game-JP.exe")
          ]);
    // Saves sit next to Game.exe (vanilla layout) or in a SaveData/
    // subdirectory (custom save systems). Only report a dir that exists.
    let saveDir;
    if (rgss) {
      const saveDataDir = path.join(root, "SaveData");
      if (existsSync(saveDataDir) && statSync(saveDataDir).isDirectory()) {
        saveDir = saveDataDir;
      } else if (
        rootFiles.some((name) =>
          /^save\d+\.(rxdata|rvdata|rvdata2)$/i.test(name)
        )
      ) {
        saveDir = root;
      }
    }
    return {
      engine: {
        id: rgss ? rgss.engine : "RGSS",
        bytecode: false,
        confidence: rgss ? "high" : "medium"
      },
      flags: rgss && rgss.mkxp ? ["mkxp"] : [],
      paths: { exe, ...(saveDir ? { saveDir } : {}) },
      title: rgss ? rgss.title : null,
      rgss: rgss
        ? {
            scriptsRel: rgss.scriptsRel,
            hasArchive: rgss.hasArchive,
            rtp: rgss.rtp,
            library: rgss.library
          }
        : null,
      saveDirKnown: rgss ? !!saveDir : undefined,
      protectionLevel: 0
    };
  }

  if (!manifest) {
    for (const name of rootFiles) {
      if (!/\.exe$/i.test(name)) continue;
      const exePath = path.join(root, name);
      const evb = detectEvb(exePath);
      if (!evb) continue;
      const saveDir = path.join(root, "save");
      const hasSaveDir = existsSync(saveDir) && statSync(saveDir).isDirectory();
      return {
        engine: { id: "RGSS", bytecode: false, confidence: "medium" },
        container: "evb",
        evb: { exeName: name, exePath, arch: evb.arch },
        flags: ["evb-packed"],
        title: name.replace(/\.exe$/i, ""),
        paths: { exe: exePath, ...(hasSaveDir ? { saveDir } : {}) },
        // Legacy semantics: saveDirKnown is only ever set when a save dir was
        // found; otherwise the field stays absent from the scan result.
        saveDirKnown: hasSaveDir ? true : undefined,
        protectionLevel: 0
      };
    }
  }
  return null;
}

// --- plan -------------------------------------------------------------------

function claims(scan) {
  const container = String((scan && scan.container) || "");
  const engine = String((scan && scan.engine && scan.engine.id) || "");
  if (container === "rgss" || container === "evb") return true;
  return /^RGSS/i.test(engine);
}

// The family's route decision, verbatim from the old planner's specialPlan:
// one dedicated route (EVB shells unpack first, everything else is the plain
// rgss script injection), the three generic NW routes blocked with the same
// wording. Returns null when the scan is not this family's.
function plan(scan = {}, { requested = "auto" } = {}) {
  if (!claims(scan)) return null;
  const route = requested || "auto";
  const container = String(scan.container || "");
  const engine = String((scan.engine && scan.engine.id) || "");
  const special =
    container === "evb"
      ? candidate("evb-unpack-rgss-script")
      : candidate("rgss-script");
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

// --- payload & capabilities ---------------------------------------------------

// The family payload is the Ruby bridge spliced into the Scripts archive
// (or eval'd via rgss-inject on attach), running inside the game's own RGSS
// interpreter.
const payload = Object.freeze({
  kind: "rgss-ruby-bridge",
  dir: "runtime/rgss-bridge",
  entry: "bridge.rb",
  language: "ruby"
});

// Trainer capabilities, grounded in the bridge's command dispatcher
// (runtime/rgss-bridge/bridge.rb): variable/switch/selfSwitch/gold/item/
// actor/party/save/map/event/battle/scene/console/lock/trainer/catalog.
const FAMILY_CAPABILITIES = Object.freeze([
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
  "trainer",
  "catalog"
]);

// XP (RGSS1) predates self-switches — they were introduced in VX.
const RGSS1_CAPABILITIES = Object.freeze(
  FAMILY_CAPABILITIES.filter((cap) => cap !== "self-switches")
);

// The plain "RGSS" engine id means the version is undecided until the bridge
// probes it at runtime, so it keeps the family maximum (the bridge guards
// $game_self_switches itself on XP).
function capabilitiesFor(scan) {
  const engine = String((scan && scan.engine && scan.engine.id) || "");
  return engine === "RGSS1" ? RGSS1_CAPABILITIES : FAMILY_CAPABILITIES;
}

export const rgssAdapter = Object.freeze({
  id: "rgss",
  label: "RPG Maker XP/VX/VXAce（RGSS，含 MKXP 变体）",
  detect,
  plan,
  payload,
  capabilities: FAMILY_CAPABILITIES,
  capabilitiesFor
});
