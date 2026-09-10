// Verify map.transfer and save.contents.get on the Essentials game.
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

async function cmd(type, args = {}, timeout = 30000) {
  try {
    const payload = await session.send(type, args, timeout);
    const text = JSON.stringify(payload);
    console.log(
      `>> ${type}\n   ${text.length > 400 ? text.slice(0, 400) + "…(" + text.length + " bytes)" : text}`
    );
    return payload;
  } catch (error) {
    console.log(`>> ${type}\n   FAIL ${error.message}`);
    return null;
  }
}

await cmd("save.load", { id: 1 });
await sleep(4000);
await cmd("map.transfer", { mapId: 2, x: 10, y: 10 });
await sleep(3000);
await cmd("map.info");
// 数据修改 tab: dump the live contents tree (large — limit output)
const contents = await cmd("save.contents.get", {}, 120000);
if (contents) console.log("   keys:", (contents.keys || []).join(","));
handle.stop();
process.exit(0);
