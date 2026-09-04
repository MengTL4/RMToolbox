// Verify the Essentials debug menu can be surfaced at runtime: load a save,
// eval $DEBUG = true, open pbDebugMenu for real, drive it with synthetic
// Input presses (cancel = close), and report. Never saves.
//
//   node tools/_probe-ess-debug.mjs <gameRoot> [loadSlot]
import path from "node:path";
import { launchRgssGame } from "../core/rgss-launcher.mjs";

const gameRoot = process.argv[2];
const loadSlot = Number(process.argv[3] || 1);
const projectRoot = path.resolve(import.meta.dirname, "..");
const resolved = path.resolve(gameRoot);
const gameKey = path.basename(resolved).replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60);

const handle = await launchRgssGame({ gameRoot: resolved, projectRoot, gameKey });
const { session } = handle;
console.log(`bridge: connected (${session.hello?.engine || "?"})`);

const evalRb = async (code) => (await session.send("console.eval", { code }, 30000)).result;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await session.send("save.load", { id: loadSlot }, 30000);
await sleep(4000); // Scene_Map settle

// Page through the anti-resale announcement (5 Enter pages) so it is gone
// before the debug menu opens: force every Input.trigger? true, then restore.
await evalRb(
  "class << Input; alias_method :rmch_dbg_orig_trig, :trigger? unless method_defined?(:rmch_dbg_orig_trig); " +
  "define_method(:trigger?) do |*a|; true; end; end; 'page-on'").then((r) => console.log("page-on:", r));
await sleep(3500);
await evalRb(
  "class << Input; if method_defined?(:rmch_dbg_orig_trig); alias_method :trigger?, :rmch_dbg_orig_trig; " +
  "remove_method :rmch_dbg_orig_trig; end; end; 'page-off'").then((r) => console.log("page-off:", r));
await sleep(500);

console.log("$DEBUG before:", await evalRb("$DEBUG.inspect"));
await evalRb("$DEBUG = true; 'set'");
console.log("$DEBUG after :", await evalRb("$DEBUG.inspect"));

// The debug menu scene runs inside this eval call; the bridge pump stays
// alive through it (Graphics.update hook), so further evals still run while
// the menu is on screen.
const menuPromise = session.send("console.eval", { code: "pbDebugMenu; 'menu-closed'" }, 120000).then(
  (r) => `menu closed cleanly: ${JSON.stringify(r.result)}`,
  (e) => `menu raised: ${e.message}`);

await sleep(8000); // menu is on screen now — long window for the screenshot
console.log("menu scene check:", await evalRb("$scene ? $scene.class.to_s : 'nil'").catch(() => "?"));

// Press cancel (Input::B) until the menu unwinds.
await evalRb(
  "class << Input; alias_method :rmch_dbg_trigger, :trigger? unless method_defined?(:rmch_dbg_trigger); " +
  "define_method(:trigger?) do |s|; true if s == Input::B; end; end; 'cancel-on'").catch(() => null);
const verdict = await Promise.race([menuPromise, sleep(15000).then(() => "menu still open after 15s")]);
console.log(verdict);

handle.stop();
process.exit(0);
