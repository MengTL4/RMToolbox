// Test: does aliasing Graphics.update actually intercept Ruby-level calls on mkxp-z?
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
    .then((p) => console.log(">>", code.slice(0, 100), "\n  ", p.result))
    .catch((e) =>
      console.log(">>", code.slice(0, 100), "\n   FAIL", e.message)
    );

await ev(
  '$gcount=0; class << Graphics; alias_method :rmch_gu, :update; def update; $gcount+=1; rmch_gu; end; end; "armed"'
);
await sleep(3000);
await ev('"$gcount=#{$gcount}"');

handle.stop();
process.exit(0);
