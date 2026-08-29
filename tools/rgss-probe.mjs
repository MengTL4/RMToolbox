// Smoke-test the RGSS bridge end to end: prepare a shadow copy, inject, launch
// the real game, wait for the Ruby bridge to connect, then run a few commands.
//
//   node tools/rgss-probe.mjs <gameRoot>
//
// Prints what the bridge reports and exits non-zero on failure. Commands use
// the same vocabulary the GUI speaks (see runtime/bridge/src/parts).

import path from "node:path";
import { launchRgssGame } from "../core/rgss-launcher.mjs";
import { detectRgss } from "../core/rgss.mjs";

const gameRoot = process.argv[2];
if (!gameRoot) {
  console.error("usage: node tools/rgss-probe.mjs <gameRoot>");
  process.exit(2);
}

const projectRoot = process.env.RMCH_PROJECT || path.resolve(import.meta.dirname, "..");
const resolved = path.resolve(gameRoot);
const gameKey = path.basename(resolved).replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60);

const detect = detectRgss(resolved);
if (!detect) {
  console.error(`not an RGSS game: ${resolved}`);
  process.exit(2);
}

console.log(`game    : ${detect.title}`);
console.log(`engine  : ${detect.engine} (${detect.library})`);
console.log(`archive : ${detect.hasArchive ? path.basename(detect.archivePath) : "none (loose Data/)"}`);
console.log(`scripts : ${detect.scriptsRel}`);
if (detect.rtp.length) console.log(`rtp     : ${detect.rtp.join(", ")}`);

let handle;
try {
  handle = await launchRgssGame({ gameRoot: resolved, projectRoot, gameKey });
} catch (error) {
  console.error(`launch failed: ${error.message}`);
  process.exit(1);
}

const { session } = handle;
console.log(`bridge  : connected (${session.hello?.engine || "unknown"})`);

const commands = [
  ["ping", {}],
  ["catalog.query", { kind: "item" }],
  ["catalog.query", { kind: "actor" }],
  ["item.list", {}],
  ["party.info", {}],
  ["variable.list", { offset: 1, limit: 500 }],
  ["switch.list", { offset: 1, limit: 500 }],
  ["map.list", {}]
];

let failures = 0;
for (const [type, args] of commands) {
  try {
    const payload = await session.send(type, args);
    const summary = summarise(type, payload);
    console.log(`  ${type.padEnd(14)} ok   ${summary}`);
  } catch (error) {
    // On the title screen there is no save yet, so party/variable/map commands
    // legitimately refuse. That is not a bridge failure.
    if (/no save loaded|no player yet|unavailable/i.test(error.message)) {
      console.log(`  ${type.padEnd(14)} n/a  ${error.message}`);
    } else {
      failures += 1;
      console.log(`  ${type.padEnd(14)} FAIL ${error.message}`);
    }
  }
}

// The live state push should have arrived at least once by now (the bridge
// sends one right after hello).
if (session.state) {
  console.log(`  state push     ok   gold=${session.state.gold} engine=${session.state.engine?.maker || "?"}`);
} else {
  failures += 1;
  console.log("  state push     FAIL no state frame received");
}

function summarise(type, payload) {
  if (type === "catalog.query") {
    const rows = payload.entries || [];
    const first = rows.find((row) => row && row.name);
    return `total=${payload.total}, first=${first ? `${first.id}:${first.name}` : "-"}`;
  }
  if (type === "party.info") {
    const rows = payload.members || [];
    return rows.length
      ? rows.map((a) => `${a.name} Lv${a.level} HP${a.hp}/${a.mhp}`).join(" | ")
      : "empty (title screen?)";
  }
  if (type === "ping") {
    return `gold=${payload.gold} engine=${payload.engine?.maker || "?"}`;
  }
  if (type === "variable.list" || type === "switch.list") {
    return `total=${payload.total}, rows=${(payload.entries || []).length}`;
  }
  if (type === "item.list") return `${(payload.entries || []).length} stacks`;
  if (type === "map.list") return `total=${payload.total}`;
  return JSON.stringify(payload).slice(0, 120);
}

handle.stop();
console.log(failures ? `rgss-probe: FAIL (${failures} commands)` : "rgss-probe: PASS");
process.exit(failures ? 1 : 0);
