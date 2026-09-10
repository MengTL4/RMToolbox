// During the announcement modal: is the pump alive at all?
import path from "node:path";
import { launchRgssGame } from "../../core/rgss-launcher.mjs";

const gameRoot = path.resolve(process.argv[2]);
const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const gameKey = path
  .basename(gameRoot)
  .replace(/[^a-z0-9_-]+/gi, "_")
  .slice(0, 60);
const handle = await launchRgssGame({ gameRoot, projectRoot, gameKey });
const { session } = handle;
let states = 0;
session.on("state", () => {
  states += 1;
});
session.on("event", (m) =>
  console.log("[event]", JSON.stringify(m).slice(0, 200))
);
console.log("connected");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await session
  .send("save.load", { id: 1 }, 30000)
  .then(() => console.log("loaded"));
await sleep(4000);
console.log("state pushes so far:", states);
const before = states;
await sleep(3000);
console.log("state pushes in last 3s:", states - before);
await session
  .send("debug.eval", { code: "1+1" }, 8000)
  .then((p) => console.log("eval 1+1 =>", p.result))
  .catch((e) => console.log("eval FAIL", e.message));
console.log("state pushes total:", states);

handle.stop();
process.exit(0);
