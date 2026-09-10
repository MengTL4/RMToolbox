// Diagnose why Scene_Map#main never runs after bridge save.load on 宝可梦赤途.
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

await ev(
  '"$DEBUG=#{$DEBUG} scene=#{$scene.class} es=#{($scene.instance_variable_get(:@eventscene).class rescue "none")}"'
);
await ev(
  '$__main_calls = 0; Scene_Map.prepend(Module.new do; def main; $__main_calls += 1; super; end; end); "armed"'
);
await session
  .send("save.load", { id: 1 }, 30000)
  .then(() => console.log("loaded"));
for (let i = 0; i < 3; i++) {
  await sleep(3000);
  await ev(
    '["scene="+$scene.class.to_s, "main="+$__main_calls.to_s, "intro="+(ObjectSpace.each_object(IntroEventScene).map{|s| s.disposed?}.inspect rescue "err"), "map="+($game_map ? $game_map.map_id : "nil").to_s].inspect'
  );
}
shot("ess-diag.png");

handle.stop();
process.exit(0);
