// Launch the Essentials game and drive real bridge commands end-to-end:
// save.list at the title screen, load a slot, then gold/party/items/maps.
//
//   node tools/_probe-ess-cmds.mjs <gameRoot> [loadSlot]
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

async function cmd(type, args = {}) {
  try {
    const payload = await session.send(type, args, 30000);
    const text = JSON.stringify(payload);
    console.log(`>> ${type} ${JSON.stringify(args)}\n   ${text.length > 600 ? text.slice(0, 600) + "…(" + text.length + " bytes)" : text}`);
    return payload;
  } catch (error) {
    console.log(`>> ${type} ${JSON.stringify(args)}\n   FAIL ${error.message}`);
    return null;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await cmd("save.list");
await cmd("map.list");
await cmd("catalog.query", { kind: "item", query: "伤药", limit: 5 });
await cmd("catalog.query", { kind: "item", limit: 3 });

console.log(`\n--- loading slot ${loadSlot} ---`);
const loaded = await cmd("save.load", { id: loadSlot });
if (loaded) {
  await sleep(4000); // let Scene_Map settle
  await cmd("ping");
  await cmd("party.info");
  await cmd("gold.set", { value: 77777 });
  await cmd("gold.add", { amount: -777 });
  await cmd("item.list");
  await cmd("item.add", { id: "POTION", amount: 3 });
  await cmd("item.set", { id: "POTION", count: 9 });
  await cmd("map.info");
  await cmd("save.save", { id: loadSlot });
  await cmd("save.list");
}

handle.stop();
process.exit(0);
