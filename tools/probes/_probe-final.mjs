// Final verification: load at title, dismiss the announcement modal by briefly
// forcing Input.trigger?, then map.transfer and confirm the new map.
import path from "node:path";
import { execSync } from "node:child_process";
import { launchRgssGame } from "../../core/rgss-launcher.mjs";

const gameRoot = path.resolve(process.argv[2]);
const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const gameKey = path
  .basename(gameRoot)
  .replace(/[^a-z0-9_-]+/gi, "_")
  .slice(0, 60);
const handle = await launchRgssGame({ gameRoot, projectRoot, gameKey });
const { session } = handle;
session.on("event", (m) =>
  console.log("[event]", JSON.stringify(m).slice(0, 200))
);
console.log("connected");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (code, t = 20000) =>
  session
    .send("debug.eval", { code }, t)
    .then((p) => console.log(">>", code.slice(0, 100), "\n  ", p.result))
    .catch((e) =>
      console.log(">>", code.slice(0, 100), "\n   FAIL", e.message)
    );
const shot = (name) => {
  try {
    execSync(
      `python tools/winshot.py "宝可梦赤途" "${path.resolve("runtime/screenshots/" + name)}"`,
      { stdio: "inherit" }
    );
  } catch (e) {
    console.log("winshot failed:", e.message);
  }
};

await session
  .send("save.load", { id: 1 }, 30000)
  .then(() => console.log("loaded"));
await sleep(4000);
await ev(
  '["scene="+$scene.class.to_s, "map="+($game_map ? $game_map.map_id : "nil").to_s, "announce="+($custom_sprite ? "yes" : "no")].inspect'
);
shot("ess-final-modal.png");

// Force Input.trigger? to true for a moment: flips through the 5 announcement pages.
await ev(
  'class << Input; alias_method :rmch_tmp_trig, :trigger?; def trigger?(*a); true; end; end; "forced"'
);
await sleep(2000);
await ev(
  'class << Input; alias_method :trigger?, :rmch_tmp_trig; remove_method :rmch_tmp_trig rescue nil; end; "restored"'
);
await sleep(1500);
await ev(
  '["scene="+$scene.class.to_s, "map="+($game_map ? $game_map.map_id : "nil").to_s, "pos="+($game_player ? "#{$game_player.x},#{$game_player.y}" : "nil").to_s].inspect'
);
shot("ess-final-map.png");

await session
  .send("map.transfer", { mapId: 2, x: 10, y: 10 }, 20000)
  .then((p) => console.log("transfer ack", JSON.stringify(p)));
await sleep(4000);
await ev(
  '["scene="+$scene.class.to_s, "map="+($game_map ? $game_map.map_id : "nil").to_s, "pos="+($game_player ? "#{$game_player.x},#{$game_player.y}" : "nil").to_s].inspect'
);
shot("ess-final-transfer.png");

handle.stop();
process.exit(0);
