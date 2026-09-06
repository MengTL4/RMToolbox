// Does disposing the intro EventScene actually stop its update loop?
import path from "node:path";
import { launchRgssGame } from "../core/rgss-launcher.mjs";

const gameRoot = path.resolve(process.argv[2]);
const projectRoot = path.resolve(import.meta.dirname, "..");
const gameKey = path.basename(gameRoot).replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60);
const handle = await launchRgssGame({ gameRoot, projectRoot, gameKey });
const { session } = handle;
console.log("connected");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (code) => session.send("debug.eval", { code }, 20000)
  .then((p) => console.log(">>", code.slice(0, 110), "\n  ", p.result))
  .catch((e) => console.log(">>", code.slice(0, 110), "\n   FAIL", e.message));

await ev(`$__intro = 0
IntroEventScene.prepend(Module.new do
  define_method(:update) { |*a| $__intro += 1; super(*a) }
end)
"armed"`);
await sleep(500);
await ev('$__intro.to_s');
await ev('es = $scene.instance_variable_get(:@eventscene); es.dispose; "disposed"');
await sleep(1500);
await ev('$__intro.to_s');
await sleep(1000);
await ev('[$__intro, $scene.class.to_s].inspect');

handle.stop();
process.exit(0);
