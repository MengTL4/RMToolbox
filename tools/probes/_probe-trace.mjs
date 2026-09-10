// Trace: does the intro scene keep updating after a bridge load?
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
console.log("connected");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (code) =>
  session
    .send("debug.eval", { code }, 20000)
    .then((p) => console.log(">>", code.slice(0, 110), "\n  ", p.result))
    .catch((e) =>
      console.log(">>", code.slice(0, 110), "\n   FAIL", e.message)
    );

await ev(`$__intro = 0; $__mapmain = 0
IntroEventScene.prepend(Module.new do
  define_method(:update) { |*a| $__intro += 1; super(*a) }
end)
Scene_Map.prepend(Module.new do
  def main; $__mapmain += 1; super; end
  def update; $__mapupd = ($__mapupd || 0) + 1; super; end
end)
"armed"`);
await sleep(500);
await ev("[$__intro, $__mapmain].inspect");
await session
  .send("save.load", { id: 1 }, 30000)
  .then(() => console.log("loaded"));
await sleep(3000);
await ev("[$__intro, $__mapmain, ($__mapupd || 0), $scene.class.to_s].inspect");
await sleep(2000);
await ev("[$__intro, $__mapmain, ($__mapupd || 0)].inspect");
await ev(
  '($scene.instance_variable_get(:@eventscene).disposed?.inspect rescue "no-es")'
);

handle.stop();
process.exit(0);
