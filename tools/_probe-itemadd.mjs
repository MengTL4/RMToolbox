// Send item.add through the real command channel, then poll with pings to see
// whether the response arrives late or never.
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

// load a save first
await session
  .send("save.load", { id: 1 }, 30000)
  .then((p) => console.log("loaded", JSON.stringify(p)))
  .catch((e) => console.log("load FAIL", e.message));
await sleep(4000);

const t0 = Date.now();
session
  .send("item.add", { id: "POTION", amount: 3 }, 60000)
  .then((p) =>
    console.log(`item.add OK after ${Date.now() - t0}ms:`, JSON.stringify(p))
  )
  .catch((e) =>
    console.log(`item.add FAIL after ${Date.now() - t0}ms:`, e.message)
  );

for (let i = 0; i < 6; i++) {
  await sleep(1500);
  try {
    const p = await session.send("gold.set", { value: 1000 + i }, 8000);
    console.log(`ping-ish #${i} OK`, JSON.stringify(p));
  } catch (e) {
    console.log(`ping-ish #${i} FAIL`, e.message);
  }
}
await sleep(65000);
handle.stop();
process.exit(0);
