// What scene is actually at the title, and does disposing it break the loop?
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
    .then((p) => console.log(">>", code.slice(0, 110), "\n  ", p.result))
    .catch((e) =>
      console.log(">>", code.slice(0, 110), "\n   FAIL", e.message)
    );

await sleep(1000);
await ev("$scene.class.to_s");
await ev("$scene.instance_variables.inspect");
await ev(
  '($scene.instance_variable_get(:@eventscene).class.to_s rescue "none")'
);
// dispose it directly and watch what happens
await ev(
  'es = $scene.instance_variable_get(:@eventscene); (es.dispose rescue "ERR #{$!.class}"); es.disposed?.inspect rescue "?"'
);
await sleep(2000);
await ev("$scene.class.to_s");

handle.stop();
process.exit(0);
