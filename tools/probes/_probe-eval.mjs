// Launch an RGSS game and run Ruby evals against the live bridge.
//
//   node tools/_probe-eval.mjs <gameRoot> <expr1> [expr2 ...]
import path from "node:path";
import { launchRgssGame } from "../../core/rgss-launcher.mjs";

const gameRoot = process.argv[2];
const exprs = process.argv.slice(3);
const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const resolved = path.resolve(gameRoot);
const gameKey = path
  .basename(resolved)
  .replace(/[^a-z0-9_-]+/gi, "_")
  .slice(0, 60);

const handle = await launchRgssGame({
  gameRoot: resolved,
  projectRoot,
  gameKey
});
const { session } = handle;
console.log(`bridge: connected (${session.hello?.engine || "?"})`);

for (const code of exprs) {
  try {
    const payload = await session.send("debug.eval", { code }, 30000);
    console.log(`>> ${code}\n   ${payload.result}  (${payload.class})`);
  } catch (error) {
    console.log(`>> ${code}\n   FAIL ${error.message}`);
  }
}

handle.stop();
process.exit(0);
