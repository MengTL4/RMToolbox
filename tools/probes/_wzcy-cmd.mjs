// Send one command to the live bridge over the file channel and print the
// result. Serverless: the bridge polls commands.jsonl itself. Usage:
//   node tools/_wzcy-cmd.mjs <type> [jsonArgs]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const stateDir = path.join(
  "E:\\project\\RMToolbox",
  "runtime",
  "bridge-state",
  "_V1.2.2_B电脑端"
);
const commandsPath = path.join(stateDir, "commands.jsonl");
const eventsPath = path.join(stateDir, "events.jsonl");
const type = process.argv[2];
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
if (!type) {
  console.error("usage: _wzcy-cmd.mjs <type> [jsonArgs]");
  process.exit(2);
}

const id = `m${Date.now()}`;
const before = existsSync(eventsPath)
  ? readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean).length
  : 0;
writeFileSync(
  commandsPath,
  JSON.stringify({ commandId: id, ts: Date.now(), type, args }) + "\n",
  { flag: "a" }
);
const deadline = Date.now() + 8000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 250));
  if (!existsSync(eventsPath)) continue;
  const lines = readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean);
  for (let i = Math.max(before, 0); i < lines.length; i += 1) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.commandId === `file:${id}`) {
        console.log(JSON.stringify(e, null, 0).slice(0, 2000));
        process.exit(e.ok ? 0 : 1);
      }
    } catch (_) {}
  }
}
console.log("TIMEOUT");
process.exit(1);
