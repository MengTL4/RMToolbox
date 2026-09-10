// Diagnose why the RGSS bridge stops answering after a new-game / save-load
// transition (seen on BLACK SOULS / RGSS3).
//
// Method: run the transition ONE step at a time and ask the bridge whether it is
// still alive after each step. A single combined eval (what the acceptance test
// does) can only tell you "it died somewhere in here"; stepping isolates the
// instruction that kills it.
//
// Liveness is checked two ways:
//   - the results file's mtime: the bridge only appends when it answers, so a
//     stale file means the game's scene-update hook stopped pumping
//   - ping, which has a 15s timeout, so it is only worth sending when the file
//     still looks alive
//
// Usage: node tools/diagnose-rgss-transition.mjs <gameRoot> [--no-load]
import path from "node:path";
import { statSync, existsSync } from "node:fs";
import { launchRgssGame } from "../core/rgss-launcher.mjs";

const gameRoot = path.resolve(process.argv[2] || "");
if (!process.argv[2]) {
  console.error("usage: node tools/diagnose-rgss-transition.mjs <gameRoot>");
  process.exit(2);
}
const projectRoot = path.resolve(import.meta.dirname, "..");
const gameKey = path
  .basename(gameRoot)
  .replace(/[^a-z0-9_-]+/gi, "_")
  .slice(0, 60);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let handle;
let step = 0;

function log(...parts) {
  console.log(parts.join(" "));
}

// The bridge appends its answers here; a frozen mtime means no pumping.
function resultStat() {
  const file = path.join(
    projectRoot,
    "runtime",
    "rgss-attach",
    gameKey,
    "rmch-res.jsonl"
  );
  if (!existsSync(file)) return null;
  try {
    const s = statSync(file);
    return { size: s.size, ageMs: Date.now() - s.mtimeMs };
  } catch {
    return null;
  }
}

async function alive(session) {
  const before = resultStat();
  const sent = await session
    .send("ping", {})
    .then(() => "ok")
    .catch((e) => `fail:${e.message}`);
  const after = resultStat();
  return { sent, before, after };
}

// Each step is a single engine action, kept small on purpose.
const STEPS = [
  ["new Game_Actors", "$game_actors = Game_Actors.new; 'ok'"],
  ["new Game_Party", "$game_party = Game_Party.new; 'ok'"],
  ["new Game_Troop", "$game_troop = Game_Troop.new; 'ok'"],
  ["new Game_Map", "$game_map = Game_Map.new; 'ok'"],
  ["new Game_Player", "$game_player = Game_Player.new; 'ok'"],
  ["party.setup_starting_members", "$game_party.setup_starting_members; 'ok'"],
  [
    "map.setup(start_map_id)",
    "$game_map.setup($data_system.start_map_id); 'ok'"
  ],
  [
    "player.moveto + refresh",
    "$game_player.moveto($data_system.start_x, $data_system.start_y); $game_player.refresh; 'ok'"
  ],
  ["map.autoplay", "$game_map.autoplay; 'ok'"],
  ["map.update", "$game_map.update; 'ok'"],
  ["$scene = Scene_Map.new", "$scene = Scene_Map.new; 'ok'"],
  ["SceneManager.goto(Scene_Map)", "SceneManager.goto(Scene_Map); 'ok'"]
];

try {
  log(`game    : ${gameRoot}`);
  handle = await launchRgssGame({ gameRoot, projectRoot, gameKey });
  const { session } = handle;
  log(`bridge  : connected (${session.hello?.engine || "?"})`);

  // Auto-confirm, exactly as the acceptance tests do, so intro messages do not
  // starve the pump.
  await session.send("console.eval", {
    code:
      "module ::Input; class << self; unless method_defined?(:rmch_ac_trig); " +
      "m = method_defined?(:triggered?) ? :triggered? : (method_defined?(:trigger?) ? :trigger? : nil); " +
      "if m; alias_method :rmch_ac_trig, m; define_method(m) do |s|; " +
      "ok = (s == :C || (defined?(Input::C) && s == Input::C)) && $game_message && $game_message.visible; " +
      "if ok; true; else; rmch_ac_trig(s); end; end; end; end; end; end; 'ac-on'"
  });

  log("");
  log(
    "step | action                          | eval        | ping     | res-file"
  );
  log(
    "-----+---------------------------------+-------------+----------+---------"
  );

  for (const [label, code] of STEPS) {
    step += 1;
    const evalResult = await session
      .send("console.eval", { code })
      .then((r) => String(r.result ?? "").slice(0, 11) || "ok")
      .catch((e) => `FAIL:${e.message}`.slice(0, 11));
    const live = await alive(session);
    const file = live.after
      ? `size=${live.after.size} age=${live.after.ageMs}ms`
      : "missing";
    log(
      `${String(step).padStart(4)} | ${label.padEnd(31)} | ${evalResult.padEnd(11)} | ${live.sent.padEnd(8)} | ${file}`
    );
    if (live.sent !== "ok") {
      log("");
      log(`>>> bridge stopped answering after step ${step}: ${label}`);
      break;
    }
  }

  // If it survived everything, confirm the save/load round trip too.
  if (process.argv.includes("--no-load") === false) {
    log("");
    log("--- save/load round trip ---");
    await session
      .send("gold.set", { value: 654321 })
      .catch((e) => log(`  gold.set: ${e.message}`));
    const saved = await session
      .send("save.save", { id: 3 })
      .catch((e) => `fail:${e.message}`);
    log(`  save.save -> ${JSON.stringify(saved)}`);
    await session.send("gold.set", { value: 1 }).catch(() => {});
    const loaded = await session
      .send("save.load", { id: 3 })
      .catch((e) => `fail:${e.message}`);
    log(`  save.load -> ${JSON.stringify(loaded)}`);
    const after = await session
      .send("party.info", {})
      .then((p) => `gold=${p.gold}`)
      .catch((e) => `FAIL:${e.message}`);
    log(`  party.info -> ${after}`);
  }
} catch (error) {
  log(`unexpected error: ${error.message}`);
} finally {
  // Leave the save slot as we found it.
  try {
    if (handle) {
      const dir = path.join(projectRoot, "runtime", "rgss-attach", gameKey);
      log(`\nartifacts: ${existsSync(dir) ? dir : "(cleaned)"}`);
    }
  } catch {}
  if (handle) handle.stop();
  process.exit(0);
}
