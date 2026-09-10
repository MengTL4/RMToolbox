// Full flow: load at title (scene must actually switch), then transfer maps.
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
console.log("connected");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (code) =>
  session
    .send("debug.eval", { code }, 20000)
    .then((p) => console.log(">>", code.slice(0, 90), "\n  ", p.result))
    .catch((e) => console.log(">>", code.slice(0, 90), "\n   FAIL", e.message));
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

await ev(
  '$__main_calls = 0; Scene_Map.prepend(Module.new do; def main; $__main_calls += 1; super; end; end); "armed"'
);
await session
  .send("save.load", { id: 1 }, 30000)
  .then(() => console.log("loaded"));
await sleep(5000);
await ev("[$__main_calls, $scene.class.to_s, $game_map.map_id].inspect");
shot("ess-load-map.png");
await session
  .send("map.transfer", { mapId: 2, x: 10, y: 10 }, 20000)
  .then((p) => console.log("transfer ack", JSON.stringify(p)));
await sleep(3500);
await ev(
  "[$game_map.map_id, $game_player.x, $game_player.y, $scene.class.to_s].inspect"
);
shot("ess-after-transfer.png");

handle.stop();
process.exit(0);
