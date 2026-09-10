// Probe: 再刷一把2：金色传说 — user reports the skill catalog stops at exactly
// 2000 entries. Launches the game through the real inject path and asks the
// bridge for the full skill catalog over the file channel, printing
// total vs entries.length so a clamp is visible as entries.length < total.
import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scanGame } from "../core/scanner.mjs";
import { launchNwInjectGame } from "../core/attach.mjs";

const projectRoot = "E:\\project\\RMToolbox";
const gameRoot = "F:\\SteamLibrary\\steamapps\\common\\再刷一把2：金色传说";
const stateDir = path.join(
  projectRoot,
  "runtime",
  "bridge-state",
  "再刷一把2：金色传说"
);
const commandsPath = path.join(stateDir, "commands.jsonl");
const eventsPath = path.join(stateDir, "events.jsonl");
const t0 = Date.now();
const elog = (msg) =>
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

for (const f of ["commands.jsonl", "events.jsonl", "state.json"]) {
  rmSync(path.join(stateDir, f), { force: true });
}

const scan = scanGame(gameRoot);
elog(
  `scan: engine=${scan.engine && scan.engine.id} container=${scan.container || "(none)"} key=${scan.gameKey}`
);

const summary = await launchNwInjectGame({ scan, projectRoot, port: 47413 });
elog(
  `launch: strategy=${summary.strategy} pid=${summary.pid} injected=${(summary.injected || []).join("/")}`
);

let cmdN = 0;
async function cmd(type, args, timeoutMs = 10000) {
  cmdN += 1;
  const id = `probe${cmdN}`;
  const before = existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean).length
    : 0;
  writeFileSync(
    commandsPath,
    JSON.stringify({ commandId: id, ts: Date.now(), type, args: args || {} }) +
      "\n",
    { flag: "a" }
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (!existsSync(eventsPath)) continue;
    const lines = readFileSync(eventsPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    for (let i = Math.max(before, 0); i < lines.length; i += 1) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.commandId === `file:${id}`) return e;
      } catch (_) {}
    }
  }
  return { ok: false, error: "timeout" };
}

// The database only exists once the game finishes booting; poll until the
// skill table has content (or give up after 2 minutes).
let skill = null;
const bootDeadline = Date.now() + 120000;
while (Date.now() < bootDeadline) {
  skill = await cmd("catalog.query", { kind: "skill", limit: 20000 });
  if (skill.ok && skill.payload && skill.payload.total > 0) break;
  await new Promise((r) => setTimeout(r, 3000));
}

if (skill && skill.ok && skill.payload) {
  const p = skill.payload;
  elog(`SKILL catalog: total=${p.total} entries.length=${p.entries.length}`);
  const last = p.entries[p.entries.length - 1];
  if (last) elog(`last entry: id=${last.id} name=${last.name}`);
  if (p.entries.length < p.total) {
    elog(
      `TRUNCATED: ${p.total - p.entries.length} skills missing from the response`
    );
  } else {
    elog("FULL: every skill in the table was returned");
  }
} else {
  elog(`skill catalog query failed: ${JSON.stringify(skill).slice(0, 200)}`);
}

try {
  execSync(
    'powershell -NoProfile -Command "Stop-Process -Name Game -Force -ErrorAction SilentlyContinue"'
  );
} catch (_) {}
spawn("taskkill", ["/IM", "Game.exe", "/F"], { stdio: "ignore" });
elog("done (game killed)");
