// Live-test the RGSS save-slot pack (runtime/rgss-bridge/bridge.rb save.list /
// save.save / save.load) against a real game: list shape, state.saveDir,
// save -> mutate -> load round-trip through the engine's own data layer, and
// the not-found error path. Everything after the title screen is driven
// through console.eval using the engine's own new-game path.
//
//   node tools/test-rgss-saves.mjs <gameRoot>
//
// Exits non-zero on the first failed check group. Writes one save slot in the
// REAL game directory (slot 3 by default) and removes it again at the end
// unless the file already existed before the test.

import path from "node:path";
import { existsSync, unlinkSync, rmSync as fsRmSync } from "node:fs";
import { launchRgssGame } from "../core/rgss-launcher.mjs";
import { detectRgss } from "../core/rgss.mjs";

const gameRoot = process.argv[2];
if (!gameRoot) {
  console.error("usage: node tools/test-rgss-saves.mjs <gameRoot>");
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

// console.eval code must not contain "{" or "}" (the request scanner counts
// braces), so blocks below are all do/end.

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

// New-game intros are often input-gated, and while a message waits for input
// the bridge pump is starved. The auto-confirm shim (same as the hooks test)
// flushes them as they appear.
const AC_ON = "module ::Input; class << self; unless method_defined?(:rmch_ac_trig); " +
  "m = method_defined?(:triggered?) ? :triggered? : (method_defined?(:trigger?) ? :trigger? : nil); " +
  "if m; $rmch_ac_method = m; alias_method :rmch_ac_trig, m; " +
  "define_method(m) do |s|; ok = (s == :C || (defined?(Input::C) && s == Input::C)) && $game_message && $game_message.visible; " +
  "if ok; true; else; rmch_ac_trig(s); end; end; " +
  "end; end; end; end; 'ac-on=' + $rmch_ac_method.to_s";

const SLOT_RE = /^save(\d+)\.(rxdata|rvdata|rvdata2)$/i;
const SLOT = 3;
let createdFile = null; // real-dir save file this test created, removed at the end

try {
  // --- state + list contract, before any new game -----------------------------
  const state = await poll(() => (session.state && session.state.saveDir ? session.state : null), 5000);
  check("state carries saveDir", !!state, state ? state.saveDir : "no saveDir");

  const list0 = await send("save.list");
  check("save.list shape", typeof list0.dir === "string" && Array.isArray(list0.entries),
    list0.dir || "");
  const occupied = list0.entries.some((e) => Number(SLOT_RE.exec(e.name)?.[1]) === SLOT);
  if (occupied) {
    console.log(`  slot ${SLOT} already has a save in the real directory — refusing to clobber it`);
    throw new Error("slot occupied");
  }

  // --- start a new game through the engine's own path ---------------------------
  if (gen === "RGSS3") {
    await evalRb("DataManager.setup_new_game; SceneManager.goto(Scene_Map); 'started'");
  } else if (gen === "RGSS2") {
    await evalRb("$game_party.setup_starting_members; $game_map.setup($data_system.start_map_id); " +
      "$game_player.moveto($data_system.start_x, $data_system.start_y); $game_player.refresh; " +
      "$game_map.autoplay; $scene = Scene_Map.new; 'started'");
  } else {
    await evalRb("Graphics.frame_count = 0; $game_temp = Game_Temp.new; $game_system = Game_System.new; " +
      "$game_switches = Game_Switches.new; $game_variables = Game_Variables.new; " +
      "$game_self_switches = Game_SelfSwitches.new if defined?(Game_SelfSwitches); " +
      "$game_screen = Game_Screen.new; $game_actors = Game_Actors.new; $game_party = Game_Party.new; " +
      "$game_troop = Game_Troop.new; $game_map = Game_Map.new; $game_player = Game_Player.new; " +
      "$game_party.setup_starting_members; $game_map.setup($data_system.start_map_id); " +
      "$game_player.moveto($data_system.start_x, $data_system.start_y); $game_player.refresh; " +
      "$game_map.autoplay; $game_map.update; $scene = Scene_Map.new; 'started'");
  }
  let party = await poll(async () => {
    const p = await send("party.info", {}).catch(() => null);
    return p && p.members && p.members.length ? p : null;
  }, 8000);
  if (!party) {
    await evalRb("$game_party.add_actor(1) if $game_party.members.empty? && $data_actors[1]; 'add'").catch(() => null);
    party = await poll(async () => {
      const p = await send("party.info", {}).catch(() => null);
      return p && p.members && p.members.length ? p : null;
    }, 4000);
  }
  check("new game started", !!party, party ? `${party.members.length} members, gold ${party.gold}` : "no party");
  if (!party) throw new Error("cannot continue without a running game");
  await evalRb(AC_ON);

  // --- save / mutate / load round-trip -------------------------------------------
  const GOLD_A = 54321;
  const GOLD_B = 777;
  await send("gold.set", { value: GOLD_A });
  const saved = await send("save.save", { id: SLOT });
  check("save.save", saved.saved === true && saved.id === SLOT, JSON.stringify(saved));

  const list1 = await send("save.list");
  const entry = list1.entries.find((e) => Number(SLOT_RE.exec(e.name)?.[1]) === SLOT);
  check("save.list shows slot", !!entry, entry ? `${entry.name} ${entry.size}B` : "not listed");
  if (entry) {
    const realPath = path.join(list1.dir, entry.name);
    const onDisk = existsSync(realPath);
    check("written through to real dir", onDisk, realPath);
    if (onDisk) createdFile = realPath;
  }

  // Mutate more than gold so the load really swapped the data layer.
  await send("gold.set", { value: GOLD_B });
  await send("switch.set", { id: 1, value: true });
  const midGold = (await send("party.info")).gold;
  check("mutated after save", midGold === GOLD_B, `gold=${midGold}`);

  const loaded = await send("save.load", { id: SLOT });
  check("save.load", loaded.loaded === true && loaded.id === SLOT, JSON.stringify(loaded));

  // The load switches scenes; give the game a few frames to settle, then the
  // gold and switch must be back to the saved values.
  const restored = await poll(async () => {
    const p = await send("party.info", {}).catch(() => null);
    return p && p.gold === GOLD_A ? p : null;
  }, 8000);
  check("load restores gold", !!restored, `gold=${restored ? restored.gold : "?"}`);
  const sw = await poll(async () => {
    const l = await send("switch.list", {}).catch(() => null);
    const hit = l && l.entries ? l.entries.find((s) => s.id === 1) : null;
    return hit ? hit : null;
  }, 4000);
  check("load restores switch", !!sw && sw.value === false, sw ? `switch1=${sw.value}` : "no switch list");

  // --- error path ------------------------------------------------------------------
  const missing = await send("save.load", { id: 98 }).then(() => "", (e) => e.message);
  check("load missing slot refuses", /not found/.test(missing), missing);

  const alive = await send("ping", {}).then(() => true, () => false);
  check("bridge alive after load", alive, "");
} catch (error) {
  failures += 1;
  console.error(`  unexpected error: ${error.message}`);
} finally {
  handle.stop();
  if (createdFile) {
    try { unlinkSync(createdFile); } catch (_) {}
    // The shadow copy would be rescued back into the real directory by the
    // next launch's rebuild (§4.12), so remove the whole shadow — it is
    // rebuilt from scratch anyway.
    try {
      fsRmSync(path.join(projectRoot, "runtime", "rgss-shadow", gameKey), { recursive: true, force: true });
    } catch (_) {}
  }
}

console.log(failures ? `rgss-saves: FAIL (${failures} checks)` : "rgss-saves: PASS");
process.exit(failures ? 1 : 0);
