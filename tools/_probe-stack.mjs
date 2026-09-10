// After a bridge load, capture the live stack the pump is running on.
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
    .then((p) => console.log(">>", code.slice(0, 80), "\n  ", p.result))
    .catch((e) => console.log(">>", code.slice(0, 80), "\n   FAIL", e.message));

await sleep(6500); // splash fully done, title screen settled
await session
  .send("save.load", { id: 1 }, 30000)
  .then((p) => console.log("loaded", JSON.stringify(p)));
await sleep(3000);
await ev('caller.first(22).join("\n")');
await ev(
  '$scene.class.to_s + " / " + ($scene.instance_variable_get(:@eventscene).disposed?.inspect rescue "-")'
);

handle.stop();
process.exit(0);
