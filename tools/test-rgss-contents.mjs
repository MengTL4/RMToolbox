// Live-test the RGSS save-contents tree (runtime/rgss-bridge/bridge.rb
// save.contents.get / save.contents.apply + core/rgss-savecode.mjs) against a
// real game: dump the live contents as tagged JSON, edit values in the tree,
// apply, and verify the engine picked them up — including a Marshal
// round-trip through save.save / save.load afterwards.
//
//   node tools/test-rgss-contents.mjs <gameRoot>
//
// Exits non-zero on the first failed check group. Uses save slot 3 like the
// saves test and removes it again at the end.

import path from "node:path";
import { existsSync, unlinkSync, rmSync as fsRmSync } from "node:fs";
import { launchRgssGame } from "../core/rgss-launcher.mjs";
import { detectRgss } from "../core/rgss.mjs";

const gameRoot = process.argv[2];
if (!gameRoot) {
  console.error("usage: node tools/test-rgss-contents.mjs <gameRoot>");
  process.exit(2);
}

const projectRoot = process.env.RMCH_PROJECT || path.resolve(import.meta.dirname, "..");
const resolved = path.resolve(gameRoot);
const gameKey = path.basename(resolved).replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60);

const detect = detectRgss(resolved);
if (!detect) {
  console.error(`not an RGSS game: ${resolved}`);
  process.exit(2);
}
const gen = detect.engine; // RGSS1 / RGSS2 / RGSS3
console.log(`game    : ${detect.title} (${gen})`);

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`  ${label.padEnd(30)} ${ok ? "ok" : "FAIL"} ${detail}`);
  if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let handle;
try {
  handle = await launchRgssGame({ gameRoot: resolved, projectRoot, gameKey });
} catch (error) {
  console.error(`launch failed: ${error.message}`);
  process.exit(1);
}
const { session } = handle;
console.log(`bridge  : connected (${session.hello?.engine || "?"})`);

const send = (type, args) => session.send(type, args || {});
const evalRb = async (code) => (await send("console.eval", { code })).result;

async function poll(fn, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(stepMs);
  }
  return last;
}

// Same auto-confirm shim as the saves/hooks tests: intro messages starve the
// bridge pump otherwise.
const AC_ON = "module ::Input; class << self; unless method_defined?(:rmch_ac_trig); " +
  "m = method_defined?(:triggered?) ? :triggered? : (method_defined?(:trigger?) ? :trigger? : nil); " +
  "if m; $rmch_ac_method = m; alias_method :rmch_ac_trig, m; " +
  "define_method(m) do |s|; ok = (s == :C || (defined?(Input::C) && s == Input::C)) && $game_message && $game_message.visible; " +
  "if ok; true; else; rmch_ac_trig(s); end; end; " +
  "end; end; end; end; 'ac-on=' + $rmch_ac_method.to_s";

const SLOT_RE = /^save(\d+)\.(rxdata|rvdata|rvdata2)$/i;
const SLOT = 3;
const GOLD = 654321;
const NAME_UTF8 = "改名ABC测试";
const NAME_BYTES = [...Buffer.from(NAME_UTF8, "utf8")];
let createdFile = null;

// Collect "@id" nodes so "@ref" placeholders can be resolved back to the
// shared node (party members and Game_Actors#@data alias the same Game_Actor).
function indexTreeIds(root) {
  const map = new Map();
  const walk = (n, depth) => {
    if (!n || typeof n !== "object" || depth > 200) return;
    if (Array.isArray(n)) {
      n.forEach((v) => walk(v, depth + 1));
      return;
    }
    if (typeof n["@id"] === "number") map.set(n["@id"], n);
    if (Array.isArray(n["@arr"])) n["@arr"].forEach((v) => walk(v, depth + 1));
    if (Array.isArray(n["@hash"])) {
      n["@hash"].forEach((p) => { if (Array.isArray(p)) p.forEach((v) => walk(v, depth + 1)); });
    }
    if (n["@iv"] && typeof n["@iv"] === "object" && !Array.isArray(n["@iv"])) {
      Object.values(n["@iv"]).forEach((v) => walk(v, depth + 1));
    }
    if (Object.keys(n).every((k) => !k.startsWith("@"))) {
      Object.values(n).forEach((v) => walk(v, depth + 1));
    }
  };
  walk(root, 0);
  return map;
}

function resolveRef(node, ids) {
  return node && typeof node["@ref"] === "number" ? ids.get(node["@ref"]) : node;
}

// Find the Game_Actor node for actor id 1 inside a contents tree. XP stores
// Game_Actors#@data as a Hash, VX/Ace as an Array indexed from 1; either way
// the node may arrive as an @ref into the shared copy.
function actorNode(tree, ids) {
  let data = resolveRef(tree.actors, ids);
  data = data && data["@iv"] && resolveRef(data["@iv"]["@data"], ids);
  if (!data) return null;
  const arr = Array.isArray(data) ? data : data["@arr"];
  if (Array.isArray(arr)) return resolveRef(arr[1], ids) || null;
  const pairs = data["@hash"];
  if (!Array.isArray(pairs)) return null;
  const hit = pairs.find((pair) => pair[0] === 1);
  return hit ? resolveRef(hit[1], ids) : null;
}

try {
  // --- start a new game through the engine's own path ---------------------------
  const startNewGame = () => {
    if (gen === "RGSS3") {
      return evalRb("DataManager.setup_new_game; SceneManager.goto(Scene_Map); 'started'");
    } else if (gen === "RGSS2") {
      return evalRb("$game_party.setup_starting_members; $game_map.setup($data_system.start_map_id); " +
        "$game_player.moveto($data_system.start_x, $data_system.start_y); $game_player.refresh; " +
        "$game_map.autoplay; $scene = Scene_Map.new; 'started'");
    }
    return evalRb("Graphics.frame_count = 0; $game_temp = Game_Temp.new; $game_system = Game_System.new; " +
      "$game_switches = Game_Switches.new; $game_variables = Game_Variables.new; " +
      "$game_self_switches = Game_SelfSwitches.new if defined?(Game_SelfSwitches); " +
      "$game_screen = Game_Screen.new; $game_actors = Game_Actors.new; $game_party = Game_Party.new; " +
      "$game_troop = Game_Troop.new; $game_map = Game_Map.new; $game_player = Game_Player.new; " +
      "$game_party.setup_starting_members; $game_map.setup($data_system.start_map_id); " +
      "$game_player.moveto($data_system.start_x, $data_system.start_y); $game_player.refresh; " +
      "$game_map.autoplay; $game_map.update; $scene = Scene_Map.new; 'started'");
  };
  // Custom title scenes can undo a too-early scene switch, so retry the whole
  // new-game path until a party actually exists.
  let party = null;
  for (let attempt = 0; attempt < 3 && !party; attempt += 1) {
    await startNewGame().catch(() => null);
    party = await poll(async () => {
      const p = await send("party.info", {}).catch(() => null);
      return p && p.members && p.members.length ? p : null;
    }, 8000);
  }
  check("new game started", !!party, party ? `${party.members.length} members` : "no party");
  if (!party) throw new Error("cannot continue without a running game");
  await evalRb(AC_ON);

  // --- dump the live contents -----------------------------------------------------
  const got = await send("save.contents.get", {});
  check("contents.get shape", typeof got.json === "string" && got.bytes > 0 && Array.isArray(got.keys),
    `${got.bytes}B, keys=${(got.keys || []).join("/")}`);
  let tree = null;
  try {
    tree = JSON.parse(got.json);
  } catch (error) {
    check("contents json parses", false, error.message);
  }
  if (!tree) throw new Error("cannot continue without the contents tree");
  const ids = indexTreeIds(tree);
  const needKeys = ["system", "party", "map", "player"];
  check("top-level keys", needKeys.every((k) => Object.hasOwn(tree, k)), Object.keys(tree).slice(0, 14).join(","));
  const partyNode = resolveRef(tree.party, ids);
  check("party is Game_Party", !!partyNode && partyNode["@cls"] === "Game_Party",
    partyNode ? partyNode["@cls"] : "?");

  // The map carries a Table (RPG::Map#data) — proves the C-class tag works.
  const mapData = tree.map && tree.map["@iv"] && tree.map["@iv"]["@map"] &&
    tree.map["@iv"]["@map"]["@iv"] && tree.map["@iv"]["@map"]["@iv"]["@data"];
  check("map Table dumped", !!(mapData && mapData["@table"] && Array.isArray(mapData["@table"].data)),
    mapData && mapData["@table"] ? `${mapData["@table"].data.length} cells` : "no @table");

  // --- edit the tree: gold, a switch, an actor name --------------------------------
  partyNode["@iv"]["@gold"] = GOLD;
  const swNode = tree.switches && tree.switches["@iv"] && tree.switches["@iv"]["@data"];
  const swData = Array.isArray(swNode) ? swNode : (swNode && swNode["@arr"]);
  check("switches array present", Array.isArray(swData), "");
  if (Array.isArray(swData)) {
    while (swData.length <= 7) swData.push(null);
    swData[7] = true;
  }
  const actor = actorNode(tree, ids);
  check("actor 1 in tree", !!actor, actor ? actor["@cls"] : "not found");
  if (actor) actor["@iv"]["@name"] = NAME_UTF8;
  // Unknown keys must be reported back on XP/VX instead of silently dropped.
  tree.bogusKeyForTest = { "@cls": "Game_Temp", "@iv": {} };

  const applied = await send("save.contents.apply", { json: JSON.stringify(tree) });
  check("contents.apply", applied.applied === true && applied.reloaded === true, JSON.stringify(applied.skipped || []));
  if (gen === "RGSS3") {
    check("custom keys pass through", (applied.skipped || []).length === 0, "");
  } else {
    check("unknown key reported", (applied.skipped || []).includes("bogusKeyForTest"),
      (applied.skipped || []).join(","));
  }

  // --- verify the engine picked the edits up ---------------------------------------
  const afterGold = await poll(async () => {
    const p = await send("party.info", {}).catch(() => null);
    return p && p.gold === GOLD ? p : null;
  }, 8000);
  check("gold applied", !!afterGold, `gold=${afterGold ? afterGold.gold : "?"}`);
  const sw = await poll(async () => {
    const l = await send("switch.list", {}).catch(() => null);
    const hit = l && l.entries ? l.entries.find((s) => s.id === 7) : null;
    return hit && hit.value === true ? hit : null;
  }, 4000);
  check("switch 7 applied", !!sw, "");
  const nameBytes = await poll(async () => {
    const r = await evalRb("$game_actors[1].name.unpack('C*')").catch(() => null);
    return r && String(r) === "[" + NAME_BYTES.join(", ") + "]" ? r : null;
  }, 4000);
  check("utf8 name applied", !!nameBytes, nameBytes ? "" : "bytes differ");

  // --- binary string survives dump -> apply untouched ------------------------------
  await evalRb("$game_actors[1].name = \"a\\xffb\"; 'bin-set'");
  const got2 = await send("save.contents.get", {});
  const tree2 = JSON.parse(got2.json);
  const actor2 = actorNode(tree2, indexTreeIds(tree2));
  const b64 = actor2 && actor2["@iv"]["@name"];
  check("binary string tagged @b64", !!(b64 && typeof b64["@b64"] === "string"),
    b64 ? JSON.stringify(b64) : "name node missing");
  const applied2 = await send("save.contents.apply", { json: got2.json });
  check("re-apply untouched tree", applied2.applied === true, "");
  const binBytes = await poll(async () => {
    const r = await evalRb("$game_actors[1].name.unpack('C*')").catch(() => null);
    return r && String(r) === "[97, 255, 98]" ? r : null;
  }, 4000);
  check("binary name round-trips", !!binBytes, binBytes ? "" : "bytes differ");

  // --- Marshal round-trip: applied objects must survive save/load -------------------
  const list0 = await send("save.list");
  const occupied = list0.entries.some((e) => Number(SLOT_RE.exec(e.name)?.[1]) === SLOT);
  check("slot 3 free", !occupied, "");
  if (!occupied) {
    await send("gold.set", { value: GOLD });
    const saved = await send("save.save", { id: SLOT });
    check("save.save after apply", saved.saved === true, "");
    const entry = (await send("save.list")).entries.find((e) => Number(SLOT_RE.exec(e.name)?.[1]) === SLOT);
    if (entry) {
      const realPath = path.join(list0.dir, entry.name);
      if (existsSync(realPath)) createdFile = realPath;
    }
    await send("gold.set", { value: 1 });
    const loaded = await send("save.load", { id: SLOT });
    check("save.load", loaded.loaded === true, "");
    const restored = await poll(async () => {
      const p = await send("party.info", {}).catch(() => null);
      return p && p.gold === GOLD ? p : null;
    }, 8000);
    check("applied objects survive marshal", !!restored, `gold=${restored ? restored.gold : "?"}`);
  }

  const alive = await send("ping", {}).then(() => true, () => false);
  check("bridge alive at end", alive, "");
} catch (error) {
  failures += 1;
  console.error(`  unexpected error: ${error.message}`);
} finally {
  handle.stop();
  if (createdFile) {
    try { unlinkSync(createdFile); } catch (_) {}
    // Same residue rule as the saves test: the shadow copy would otherwise be
    // rescued back into the real directory by the next launch.
    try {
      fsRmSync(path.join(projectRoot, "runtime", "rgss-shadow", gameKey), { recursive: true, force: true });
    } catch (_) {}
  }
}

console.log(failures ? `rgss-contents: FAIL (${failures} checks)` : "rgss-contents: PASS");
process.exit(failures ? 1 : 0);
