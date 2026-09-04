// Interactive probe for the Essentials/mkxp-z family: launch, connect, then
// exercise save listing/loading and money/party reads against a real save.
//
//   node tools/_probe-essentials.mjs <gameRoot>
import path from "node:path";
import { launchRgssGame } from "../core/rgss-launcher.mjs";
import { detectRgss } from "../core/rgss.mjs";

const gameRoot = process.argv[2];
const projectRoot = path.resolve(import.meta.dirname, "..");
const resolved = path.resolve(gameRoot);
const gameKey = path.basename(resolved).replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60);

const handle = await launchRgssGame({ gameRoot: resolved, projectRoot, gameKey });
const { session } = handle;
console.log(`bridge: connected (${session.hello?.engine || "?"})`);

async function trySend(type, args = {}) {
  try {
    const payload = await session.send(type, args, 30000);
    let text = JSON.stringify(payload);
    if (text.length > 220) text = text.slice(0, 220) + "...";
    console.log(`  ${type.padEnd(18)} ok   ${text}`);
    return payload;
  } catch (error) {
    console.log(`  ${type.padEnd(18)} FAIL ${error.message}`);
    return null;
  }
}

await trySend("save.list");
const list = await trySend("save.list", {});
if (list && Array.isArray(list.saves) && list.saves.length) {
  console.log("  saves:", list.saves.map((s) => `${s.id}:${s.name || s.file || "?"}`).join(" | "));
}
// Load slot 1 and re-probe the stateful commands.
const loaded = await trySend("save.load", { id: 1 });
if (loaded && loaded.loaded) {
  await trySend("gold.get");
  await trySend("party.info");
  await trySend("item.list");
  await trySend("variable.list", { offset: 1, limit: 20 });
  await trySend("switch.list", { offset: 1, limit: 20 });
}

console.log("state:", JSON.stringify(session.state));
handle.stop();
console.log("probe done");
process.exit(0);
