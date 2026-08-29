// Live-test the RGSS trainer hook pack (runtime/rgss-bridge/bridge.rb) against
// a real game: options round-trip, hook installation, value locks, vitals
// locks, and a forced in-battle check of invincible / oneHitKill / rates /
// battle commands. Everything after the title screen is driven through
// console.eval using the engine's own new-game and battle-entry paths.
//
//   node tools/test-rgss-hooks.mjs <gameRoot>
//
// Exits non-zero on the first failed check group. Safe to run on the sample
// games: the bridge only ever touches the shadow copy.

import path from "node:path";
import { launchRgssGame } from "../core/rgss-launcher.mjs";
import { detectRgss } from "../core/rgss.mjs";

const gameRoot = process.argv[2];
if (!gameRoot) {
  console.error("usage: node tools/test-rgss-hooks.mjs <gameRoot>");
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

// Victory flows in some games park inside wait_for_message until the player
// confirms; the bridge pump is starved for the whole wait (it hooks the
// scene's per-frame update, which inner wait loops never reach). An
// auto-confirm shim on the input query lets those waits dismiss themselves.
// The confirm is gated on $game_message.visible: an unconditional C press
// also reaches command-window ok-handlers, which crash on nil state once the
// battle is already over (hs: Scene_Battle#command_attack on nil subject).
// Gates, in scan order:
//  1. $game_message.visible — something actually needs dismissing.
//  2. while the message is visible, ANY active && open selectable window
//     that would consume the injected C is disarmed (w.deactivate) and the
//     in-flight query answered "not pressed"; next frame the scan is clean
//     and the C reaches the message wait. "Consumes" = call_ok_handler would
//     fire: a :ok handler for data windows, or the current-symbol handler
//     for Window_Command subclasses. BLACK SOULS 2's ATB sat in actor
//     command input when the victory message appeared; Window_ActorCommand
//     has no :ok handler (its handlers are keyed :attack/:skill/...), so an
//     :ok-only test missed it — the injected C ran command_attack on the
//     dead troop and the enemy-selection blink script crashed on
//     nil.sprite_effect_type=. Windows that would NOT consume the C (no
//     matching handler — e.g. Homework Salesman's Window_BattleVictory,
//     active by design with no :ok handler) must NOT block: the C is what
//     their wait loop polls.
//  3. message NOT visible (pre-victory ATB stall: AP gain pauses while a
//     selection window is open, so the battle never reaches the victory
//     check): a crash-risk window (has :ok handler AND invalid selection —
//     Window_BattleEnemy with all enemies dead; stock on_enemy_ok crashes on
//     nil.index) gets B injected instead — cancel handlers merely close the
//     window and are safe on nil state (BLACK SOULS 1 needed this). Don't
//     deactivate here: the cancel handler is what unwedges the ATB flow.
// Window_Selectable only processes input when open? && active, so hidden
// leftovers from an already-answered prompt must NOT block the injection.
// The handler ivar name differs: stock scripts use @handlers, BLACK SOULS'
// patched base scripts use @handler (singular). And a window whose data was
// never refreshed RAISES on #item (nil @data) — count that as "invalid
// selection" too, but only after the :ok-handler check short-circuits
// (hs's victory window also raises on #item and must stay pressable).
// The method name varies: stock Ace feeds symbols to triggered?, XP/VX feed
// Input::C, and custom runtimes (e.g. TRGSSX / BLACK SOULS' patched base
// scripts) rename the method to trigger?.
// The scene scan rescues everything: XP has no SceneManager (uses $scene),
// and per-call cost is irrelevant for a test-only shim.
const AC_ON = "module ::Input; class << self; unless method_defined?(:rmch_ac_trig); " +
  "m = method_defined?(:triggered?) ? :triggered? : (method_defined?(:trigger?) ? :trigger? : nil); " +
  "if m; $rmch_ac_method = m; alias_method :rmch_ac_trig, m; " +
  "define_method(m) do |s|; " +
  "isC = (s == :C || (defined?(Input::C) && s == Input::C)); isB = (s == :B || (defined?(Input::B) && s == Input::B)); " +
  "ok = isC && $game_message && $game_message.visible; cancel = false; " +
  "if ok || isB; begin; sc = (SceneManager.scene rescue nil) || $scene; if sc; sc.instance_variables.each do |iv|; " +
  "w = (sc.instance_variable_get(iv) rescue nil); " +
  "if w.is_a?(Window_Selectable) && !w.is_a?(Window_Message) && w.active && w.open?; " +
  "hh = (w.instance_variable_get(:@handlers) rescue nil) || (w.instance_variable_get(:@handler) rescue nil); " +
  "cs = (w.respond_to?(:current_symbol) ? (w.current_symbol rescue nil) : nil); " +
  "if hh && (hh[:ok] || (cs && hh[cs])); " +
  "if $game_message && $game_message.visible; w.deactivate; ok = false; " +
  "elsif (w.item.nil? rescue true); ok = false; cancel = true if hh[:cancel]; end; break; end; " +
  "end; end; end; rescue; end; end; " +
  "if ok; true; elsif cancel && isB; true; else; rmch_ac_trig(s); end; end; " +
  "end; end; end; end; 'ac-on=' + $rmch_ac_method.to_s";
const AC_OFF = "module ::Input; class << self; if method_defined?(:rmch_ac_trig) && $rmch_ac_method; " +
  "alias_method $rmch_ac_method, :rmch_ac_trig; remove_method :rmch_ac_trig; $rmch_ac_method = nil; " +
  "end; end; end; 'ac-off'";

try {
  // --- title screen: options + hooks + locks, no save needed -------------------
  const got = await send("trainer.options.get");
  check("options.get defaults", got.options && got.options.invincible === false && got.options.expRate === 1,
    `expRate=${got.options && got.options.expRate}`);

  // The GUI sends nested {"options": {...}}; the bridge flattens it.
  const set = await send("trainer.options.set", { options: { invincible: true, expRate: 2.5, moveSpeedAdd: 1, gameSpeedMulti: 3 } });
  check("options.set nested", set.options.invincible === true && set.options.expRate === 2.5 && set.options.gameSpeedMulti === 3,
    JSON.stringify({ inv: set.options.invincible, exp: set.options.expRate, spd: set.options.gameSpeedMulti }));
  // Back to defaults so the later rate checks compute against a rate of 1.
  await send("trainer.options.set", { options: { invincible: false, expRate: 1, goldRate: 1, moveSpeedAdd: 0, gameSpeedMulti: 1 } });

  const hooksInfo = await send("trainer.hooks.info");
  const hooks = hooksInfo.hookTargets || [];
  const expected = gen === "RGSS3"
    ? ["Game_BattlerBase.hp=", "Game_Troop.exp_total", "Game_Player.dash?"]
    : gen === "RGSS2"
      ? ["Game_Battler.hp=", "Game_Troop.exp_total", "Game_Battler.calc_mp_cost"]
      : ["Game_Battler.hp=", "Game_Enemy.exp", "Game_Battler.skill_can_use?"];
  const missing = expected.filter((name) => !hooks.includes(name));
  check("hooks installed", missing.length === 0, `${hooks.length} hooks${missing.length ? ", missing " + missing.join(",") : ""}`);

  await send("lock.set", { kind: "gold", value: 1234 });
  let list = await send("lock.list");
  check("lock.set gold", list.locks.gold === 1234, `gold=${list.locks.gold}`);

  await send("lock.replace", { locks: { item: { 2: 88 }, switch: { 5: true }, variable: { 7: -3 }, gold: 777 } });
  list = await send("lock.list");
  check("lock.replace nested",
    list.locks.gold === 777 && list.locks.item["2"] === 88 &&
    list.locks.switch["5"] === true && list.locks.variable["7"] === -3,
    JSON.stringify(list.locks));
  await send("lock.clear", {});
  list = await send("lock.list");
  check("lock.clear all", list.locks.gold === null && Object.keys(list.locks.item).length === 0, "");

  let battle = await send("battle.info");
  check("battle.info (title)", battle.inBattle === false && battle.enemies.length === 0, "");
  const escapeError = await send("battle.escape", {}).then(() => "", (e) => e.message);
  check("battle.escape refuses", /not in battle/.test(escapeError), escapeError);

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
    // Some games start with an empty party and add members via intro events;
    // mirror that with an explicit add_actor so the vitals/battle checks have
    // someone to work with.
    await evalRb("$game_party.add_actor(1) if $game_party.members.empty? && $data_actors[1]; 'add'").catch(() => null);
    party = await poll(async () => {
      const p = await send("party.info", {}).catch(() => null);
      return p && p.members && p.members.length ? p : null;
    }, 4000);
  }
  check("new game started", !!party, party ? `${party.members.length} members, gold ${party.gold}` : "no party");
  if (!party) throw new Error("cannot continue without a running game");

  // The auto-confirm shim goes in early: new-game intros (message windows,
  // name entry) are often input-gated, and while a message waits for input
  // the bridge pump is starved. The shim flushes them as they appear.
  await evalRb(AC_ON);

  const actorRef = gen === "RGSS1" ? "$game_party.actors[0]" : "$game_party.members[0]";

  // --- vitals lock (锁血): deliberate write below the floor gets clamped ---------
  const mhp = party.members[0].mhp || 100;
  // The bridge clamps numeric options to ±9999 (bridge.rb set_options, same
  // ranges as the MV/MZ panel), so on games whose mhp exceeds that (BLACK
  // SOULS II's limit-break scripts push it to ~270k) the effective lock
  // target is 9999, not mhp-1.
  const lockVal = Math.min(Math.max(1, mhp - 1), 9999);
  await send("trainer.options.set", { options: { lockHp: true, lockHpVal: lockVal } });
  await evalRb(`a = ${actorRef}; a.hp = 1; a.hp`);
  await sleep(400); // the per-frame tick also enforces it
  const hpNow = Number(await evalRb(`${actorRef}.hp`));
  check("lockHp clamps write", hpNow === lockVal || (mhp < lockVal && hpNow === mhp), `hp=${hpNow}, want ${lockVal}`);
  await send("trainer.options.set", { options: { lockHp: false, lockHpVal: 0 } });

  // --- value lock (数据锁定): the game spends gold, the lock puts it back --------
  await send("lock.set", { kind: "gold", value: 4321 });
  await evalRb("$game_party.gain_gold(-999); 'spent'");
  await sleep(400); // one frame is enough, give it a few
  const goldNow = (await send("party.info")).gold;
  check("gold lock re-asserts", goldNow === 4321, `gold=${goldNow}`);
  await send("lock.clear", {});

  // --- world options -------------------------------------------------------------
  await send("trainer.options.set", { options: { throughWalls: true, noEncounter: true } });
  await sleep(300);
  const through = await evalRb("$game_player.instance_variable_get(:@through)");
  const noEnc = await evalRb("$game_system.encounter_disabled");
  check("throughWalls forces @through", String(through) === "true", `@through=${through}`);
  check("noEncounter forces flag", String(noEnc) === "true", `encounter_disabled=${noEnc}`);
  await send("trainer.options.set", { options: { throughWalls: false, noEncounter: false } });
  await sleep(300);
  const throughOff = await evalRb("$game_player.instance_variable_get(:@through)");
  const encOff = await evalRb("$game_system.encounter_disabled");
  check("options off restore", String(throughOff) !== "true" && String(encOff) !== "true",
    `@through=${throughOff}, enc=${encOff}`);

  // --- battle: force an encounter through the engine's own trigger ---------------
  // The full entry path matters: it saves the map BGM that victory processing
  // replays afterwards (a bare BattleManager.setup skips that and the game's
  // own victory flow then crashes on replay).
  // Prefer a 2+ member troop whose first enemy yields exp: killing member 0
  // then does not trigger the victory flow, leaving the bridge responsive for
  // the mid-battle checks. The killEnemies check below ends the battle anyway.
  const troopId = Number(await evalRb(gen === "RGSS1"
    // XP reads the rate-hooked Game_Enemy#exp off a scratch instance, so the
    // check below verifies the live wrapper rather than raw database data.
    ? "solo = 0; multi = 0; (1...$data_troops.size).each do |i| t = $data_troops[i]; next unless t && t.members && t.members.length > 0; " +
      "gain = 0; begin; ge = Game_Enemy.new; ge.id = t.members[0].enemy_id; gain = ge.exp; rescue; gain = 0; end; " +
      "next unless gain > 0; solo = i if solo == 0; multi = i if multi == 0 && t.members.length > 1; end; " +
      "multi > 0 ? multi : (solo > 0 ? solo : 1)"
    : "solo = 0; multi = 0; (1...$data_troops.size).each do |i| t = $data_troops[i]; next unless t && t.members && t.members.length > 0; " +
      "e0 = $data_enemies[t.members[0].enemy_id]; next unless e0 && e0.exp > 0; " +
      "solo = i if solo == 0; multi = i if multi == 0 && t.members.length > 1; end; " +
      "multi > 0 ? multi : (solo > 0 ? solo : 1)"));
  if (gen === "RGSS3") {
    // A real playthrough always has some BGM playing (the title's); victory
    // processing replays whatever was saved, so seed one if the map has none.
    // Games with custom battle systems may route through their own transition
    // scene (e.g. Scene_BattleTransition) that also does the BGM bookkeeping.
    await evalRb(`$data_system.title_bgm.play if RPG::BGM.last.nil?; ` +
      `BattleManager.setup(${troopId}, true, true); BattleManager.on_encounter; ` +
      `BattleManager.save_bgm_and_bgs; BattleManager.play_battle_bgm; ` +
      `$game_temp.entering_battle = true if $game_temp.respond_to?(:entering_battle=); ` +
      `if defined?(Scene_BattleTransition); SceneManager.call(Scene_BattleTransition); ` +
      `else; SceneManager.call(Scene_Battle); end; 'battle'`);
  } else if (gen === "RGSS2") {
    await evalRb(`$game_troop.setup(${troopId}); $game_troop.can_escape = true; ` +
      "$game_temp.battle_proc = nil; $game_temp.next_scene = 'battle'; 'battle'");
  } else {
    // XP: assign the battle scene directly. The engine's own trigger
    // ($game_temp.battle_calling) is gated by Scene_Map#update on "no message
    // window showing", which a restarting intro autorun can block forever.
    // Scene_Battle#main reads battle_troop_id itself.
    await evalRb(`$game_temp.battle_troop_id = ${troopId}; $game_temp.battle_can_escape = true; ` +
      "$game_temp.battle_can_lose = true; $game_temp.battle_proc = nil; $scene = Scene_Battle.new; 'battle'");
  }
  battle = await poll(async () => {
    const b = await send("battle.info", {}).catch(() => null);
    return b && b.inBattle ? b : null;
  }, 10000);
  check("battle entered", !!battle && battle.enemies.length > 0,
    battle ? `troop=${troopId}, enemies=${battle.enemies.map((e) => `${e.name} ${e.hp}/${e.mhp}`).join(" | ")}` : "no battle");
  if (!battle || !battle.enemies.length) throw new Error("cannot continue without a battle");
  // Stop the confirm spam while the battle sits at command input: with the
  // shim on the party auto-fights and the battle can end mid-check.
  await evalRb(AC_OFF);

  // invincible: direct HP loss is refused while in battle
  await send("trainer.options.set", { options: { invincible: true } });
  const hpBefore = Number(await evalRb(`${actorRef}.hp`));
  await evalRb(`${actorRef}.hp = ${actorRef}.hp - 5; 'hit'`);
  const hpAfter = Number(await evalRb(`${actorRef}.hp`));
  check("invincible blocks damage", hpAfter >= hpBefore, `hp ${hpBefore} -> ${hpAfter}`);

  // oneHitKill: resolving any actor action against the enemy kills it.
  // (exp_total/gold_total sum dead members only, so the rate check runs
  // right after this, once enemy 0 is dead.)
  await send("trainer.options.set", { options: { oneHitKill: true } });
  const enemy0Ref = (gen === "RGSS1" ? "$game_troop.enemies[0]" : "$game_troop.members[0]") + ".hp";
  try {
    // Re-arm the auto-confirm shim inside the same eval as the lethal hit.
    // Killing the last enemy kicks off the victory flow on the very next
    // frame; its message windows park waiting for input and starve the
    // bridge pump before a separate AC_ON eval could ever arrive (BLACK
    // SOULS II wedged exactly here: judge_win_loss -> process_victory ->
    // gain_gold -> wait_for_message).
    if (gen === "RGSS3") {
      await evalRb(`$game_troop.members[0].item_apply($game_party.members[0], $data_items[1]); ${AC_ON}; 'applied'`);
    } else if (gen === "RGSS2") {
      await evalRb(`$game_troop.members[0].attack_effect($game_party.members[0]); ${AC_ON}; 'applied'`);
    } else {
      await evalRb(`$game_troop.enemies[0].attack_effect($game_party.actors[0]); ${AC_ON}; 'applied'`);
    }
    await sleep(300);
    const e0hp = Number(await evalRb(enemy0Ref));
    check("oneHitKill fells enemy", e0hp === 0, `enemy0 hp=${e0hp}`);
  } catch (error) {
    // A dead bridge here means the victory flow crashed the game loop.
    const alive = await send("ping", {}).then(() => true, () => false);
    check("oneHitKill fells enemy", false, `${error.message}; bridge alive=${alive}`);
    if (!alive) throw new Error("bridge died in battle");
  }

  // exp rate: wrapper scales the reward source, read off the live battle troop
  const expExpr = gen === "RGSS1" ? "$game_troop.enemies[0].exp" : "$game_troop.exp_total";
  const expBase = Number(await evalRb(expExpr));
  await send("trainer.options.set", { options: { expRate: 2, goldRate: 2 } });
  const expScaled = Number(await evalRb(expExpr));
  check("expRate scales", expBase > 0 ? expScaled === expBase * 2 : expScaled === 0,
    `troop=${troopId} exp ${expBase} -> ${expScaled}${expBase === 0 ? " (troop yields 0, hook inert)" : ""}`);
  await send("trainer.options.set", { options: { expRate: 1, goldRate: 1 } });

  // battle.enemy.setHp on a second enemy if present, then killEnemies.
  // killEnemies ends the battle: the victory flow's message waits need the
  // auto-confirm shim again (it stays on for the second battle's entry).
  await evalRb(AC_ON);
  if (battle.enemies.length > 1) {
    const setHp = await send("battle.enemy.setHp", { index: 1, value: 5 });
    check("battle.enemy.setHp", setHp.hp === 5, `hp=${setHp.hp}`);
  }
  const killed = await send("battle.killEnemies");
  check("battle.killEnemies", killed.remaining === 0, `killed=${killed.killed} remaining=${killed.remaining}`);

  // leave the battle; the auto-confirm shim dismisses any input-gated victory
  // message, and the force-end evals below stay as a fallback
  const left = await poll(async () => {
    const b = await send("battle.info", {}).catch(() => null);
    return b && b.inBattle === false ? b : null;
  }, 6000);
  if (!left || left.inBattle !== false) {
    if (gen === "RGSS3") await evalRb("BattleManager.process_abort; 'forced'").catch(() => {});
    else await evalRb("$scene.battle_end(0) if $scene.respond_to?(:battle_end); 'forced'").catch(() => {});
    const after = await poll(async () => {
      const b = await send("battle.info", {}).catch(() => null);
      return b && b.inBattle === false ? b : null;
    }, 4000);
    check("battle ends", !!after && after.inBattle === false, after ? "" : "still in battle");
  } else {
    check("battle ends", true, "victory flow");
  }
  // escape path on a fresh battle (keeps the kill/victory path above separate);
  // the shim stays on — the second battle's start message needs it too
  if (gen === "RGSS3") {
    await evalRb(`BattleManager.setup(${troopId}, true, true); BattleManager.on_encounter; ` +
      `BattleManager.save_bgm_and_bgs; BattleManager.play_battle_bgm; ` +
      `$game_temp.entering_battle = true if $game_temp.respond_to?(:entering_battle=); ` +
      `if defined?(Scene_BattleTransition); SceneManager.call(Scene_BattleTransition); ` +
      `else; SceneManager.call(Scene_Battle); end; 'battle'`);
  } else if (gen === "RGSS2") {
    await evalRb(`$game_troop.setup(${troopId}); $game_troop.can_escape = true; ` +
      "$game_temp.battle_proc = nil; $game_temp.next_scene = 'battle'; 'battle'");
  } else {
    // XP: assign the battle scene directly. The engine's own trigger
    // ($game_temp.battle_calling) is gated by Scene_Map#update on "no message
    // window showing", which a restarting intro autorun can block forever.
    // Scene_Battle#main reads battle_troop_id itself.
    await evalRb(`$game_temp.battle_troop_id = ${troopId}; $game_temp.battle_can_escape = true; ` +
      "$game_temp.battle_can_lose = true; $game_temp.battle_proc = nil; $scene = Scene_Battle.new; 'battle'");
  }
  const battle2 = await poll(async () => {
    const b = await send("battle.info", {}).catch(() => null);
    return b && b.inBattle ? b : null;
  }, 10000);
  if (battle2 && battle2.inBattle) {
    const esc = await send("battle.escape");
    const out = await poll(async () => {
      const b = await send("battle.info", {}).catch(() => null);
      return b && b.inBattle === false ? b : null;
    }, 5000);
    check("battle.escape", !!out && out.inBattle === false, `method=${esc.method}`);
  } else {
    check("battle.escape", false, "second battle never started");
  }
  await evalRb(AC_OFF).catch(() => {});

  const state = session.state;
  check("state push carries options", !!(state && state.options && typeof state.options.invincible !== "undefined"),
    state && state.options ? `invincible=${state.options.invincible}` : "no state");
} catch (error) {
  failures += 1;
  console.error(`  unexpected error: ${error.message}`);
} finally {
  await send("trainer.options.set", { options: { invincible: false, oneHitKill: false, lockHp: false } }).catch(() => {});
  handle.stop();
}

console.log(failures ? `rgss-hooks: FAIL (${failures} checks)` : "rgss-hooks: PASS");
process.exit(failures ? 1 : 0);
