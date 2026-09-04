// One-off: drive commands to a live RGSS bridge over the shadow file channel.
// Usage: node tools/_probe-shadow-cmd.mjs <shadowDir> <type> [argsJSON]
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { RgssSession } from "../core/rgss-launcher.mjs";

const [dir, type, rawArgs] = process.argv.slice(2);
if (!dir || !type) {
  console.error("usage: node tools/_probe-shadow-cmd.mjs <shadowDir> <type> [argsJSON]");
  process.exit(1);
}
const args = rawArgs ? JSON.parse(rawArgs) : {};

const session = new RgssSession({ dir, gameKey: "probe" });
// Attaching mid-game: skip everything already in the response file. Ids restart
// at 1 per session, so a stale result from an earlier probe would otherwise
// resolve our pending command with the wrong payload.
const resPath = path.join(dir, "rmch-res.jsonl");
if (existsSync(resPath)) session.resOffset = statSync(resPath).size;
try {
  const payload = await session.send(type, args, 20000);
  console.log(JSON.stringify({ ok: true, payload }, null, 2).slice(0, 3000));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error && error.message || error) }));
} finally {
  session.close();
}
process.exit(0);
