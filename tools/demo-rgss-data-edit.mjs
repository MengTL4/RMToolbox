// Demo: live-editing the static database ($data_*) inside a running RGSS game.
// Renames item #1 and zeroes its price via console.eval, reads the catalog back.
//
//   node tools/demo-rgss-data-edit.mjs <gameRoot>

import path from "node:path";
import { launchRgssGame } from "../core/rgss-launcher.mjs";

const gameRoot = process.argv[2];
if (!gameRoot) {
  console.error("usage: node tools/demo-rgss-data-edit.mjs <gameRoot>");
  process.exit(2);
}
const projectRoot = path.resolve(import.meta.dirname, "..");
const gameKey = "demo-" + path.basename(path.resolve(gameRoot)).replace(/[^a-z0-9_-]+/gi, "_").slice(0, 50);

const handle = await launchRgssGame({ gameRoot: path.resolve(gameRoot), projectRoot, gameKey });
const { session } = handle;
console.log(`bridge connected (${session.hello?.engine})`);

const before = await session.send("catalog.query", { kind: "item", limit: 3 });
console.log("before:", before.entries.slice(0, 2).map((e) => `${e.id}:${e.name}`).join(", "));

// $data_items[1] is the live RPG::Item object; edits apply immediately and are
// gone after a restart (nothing touches the game files).
const edited = await session.send("console.eval", {
  code: '$data_items[1].name = "RMCH Potion"; $data_items[1].price = 0; "ok"'
});
console.log("console.eval:", edited.result);

const after = await session.send("catalog.query", { kind: "item", limit: 3 });
console.log("after: ", after.entries.slice(0, 2).map((e) => `${e.id}:${e.name}`).join(", "));

handle.stop();
const worked = after.entries[0] && after.entries[0].name === "RMCH Potion";
console.log(worked ? "demo: PASS (database entry edited live)" : "demo: FAIL");
process.exit(worked ? 0 : 1);
