// Load-only watch: does the game survive save.load with the Graphics.update pump?
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
  console.log("[event]", JSON.stringify(m).slice(0, 300))
);
session.on("close", () => {
  console.log("[close] session closed");
});
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

await session
  .send("save.load", { id: 1 }, 30000)
  .then(() => console.log("loaded"));
for (let i = 0; i < 5; i++) {
  await sleep(3000);
  await ev(
    '["scene="+$scene.class.to_s, "map="+($game_map ? $game_map.map_id : "nil").to_s, "announce="+($custom_sprite ? "yes" : "no")].inspect'
  );
}
shot("ess-watch.png");

handle.stop();
process.exit(0);
