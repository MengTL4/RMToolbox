// End-to-end: scan the PACKED root, auto-unpack (reuse), launch via RGSS path.
import path from "node:path";
import { launchGame } from "../core/launcher.mjs";

const gameRoot = path.resolve(process.argv[2]);
const projectRoot = path.resolve(import.meta.dirname, "..");
const result = await launchGame({ gameRoot, projectRoot, build: false });
console.log("strategy:", result.strategy);
console.log("game:", result.game);
console.log("reason:", result.strategyReason);
const p = await result.rgssSession.send("debug.eval", { code: '["scene="+$scene.class.to_s, "title-ok"].inspect' }, 20000);
console.log("eval:", p.result);
result.rgssSession.close();
process.exit(0);
