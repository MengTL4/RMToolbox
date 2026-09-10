// Is Scene_Map#update actually running the base implementation?
import path from "node:path";
import { launchRgssGame } from "../core/rgss-launcher.mjs";

const gameRoot = path.resolve(process.argv[2]);
const projectRoot = path.resolve(import.meta.dirname, "..");
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

await session
  .send("save.load", { id: 1 }, 30000)
  .then(() => console.log("loaded"));
await sleep(4000);
await ev("Scene_Map.instance_method(:update).source_location.inspect");
await ev(
  '$scene.instance_variable_get(:@rmch_update_wrapper) ? "wrapped" : "not-wrapped"'
);
await ev("$scene.method(:update).source_location.inspect");
// count frames over 2s to prove update runs
await ev('$__uc0 = Graphics.frame_count; "mark"');
await sleep(2000);
await ev("(Graphics.frame_count - $__uc0).to_s");
await ev(
  'pbMapInterpreter.running? ? "interpreter running" : "interpreter idle"'
);

handle.stop();
process.exit(0);
