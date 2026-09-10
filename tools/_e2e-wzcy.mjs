// End-to-end real-machine verification for the nb-evalnwbin sealed game
// (万族穿越-源启崛起 V1.2.2_B). Drives the exact GUI launch path
// (launchNwInjectGame) and asserts: game survives, boot db capture lands,
// catalog-cache.json is written, and the data-page commands answer with real
// content over the file channel. Exits 1 on any failed check.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scanGame } from "../core/scanner.mjs";
import { launchNwInjectGame } from "../core/attach.mjs";

const projectRoot = "E:\\project\\RMToolbox";
const gameRoot = "D:\\Downloads\\RPG\\_V1.2.2_B电脑端";
const stateDir = path.join(
  projectRoot,
  "runtime",
  "bridge-state",
  "_V1.2.2_B电脑端"
);
const cachePath = path.join(stateDir, "catalog-cache.json");
const commandsPath = path.join(stateDir, "commands.jsonl");
const eventsPath = path.join(stateDir, "events.jsonl");
const t0 = Date.now();
const elog = (msg, extra) =>
  console.log(
    `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}${extra ? " " + extra : ""}`
  );
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  elog(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const guiCheck = execSync(
  "powershell -NoProfile -Command \"if (Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'RMToolbox' }) { 'RUNNING' } else { 'NONE' }\""
)
  .toString()
  .trim();
if (guiCheck === "RUNNING") {
  console.error("GUI is running — close it first (port/channel contention)");
  process.exit(2);
}

// Fresh start: wipe the channel and the cache so the boot capture must prove
// itself from zero.
for (const f of [
  "commands.jsonl",
  "events.jsonl",
  "state.json",
  "catalog-cache.json"
]) {
  rmSync(path.join(stateDir, f), { force: true });
}

const scan = scanGame(gameRoot);
elog(
  "scan",
  `container=${scan.container} exe=${path.basename(scan.paths.exe || "")} key=${scan.gameKey}`
);
if (scan.container !== "nb-evalnwbin")
  throw new Error("unexpected container: " + scan.container);

const summary = await launchNwInjectGame({ scan, projectRoot, port: 47412 });
elog(
  "launch returned",
  `strategy=${summary.strategy} pid=${summary.pid} injected=${(summary.injected || []).join("/")}`
);

check("catalog-cache exists", existsSync(cachePath));
if (existsSync(cachePath)) {
  const cache = JSON.parse(readFileSync(cachePath, "utf8"));
  const kinds = Object.keys(cache.tables || {});
  check("cache kinds >= 10", kinds.length >= 10, kinds.join(","));
  check("cache has system", !!cache.tables.system);
  check(
    "cache item non-empty",
    Array.isArray(cache.tables.item) && cache.tables.item.length > 1,
    `len=${cache.tables.item && cache.tables.item.length}`
  );
  check(
    "cache mapInfo non-empty",
    Array.isArray(cache.tables.mapInfo) && cache.tables.mapInfo.length > 1,
    `len=${cache.tables.mapInfo && cache.tables.mapInfo.length}`
  );
}

let cmdN = 0;
async function cmd(type, args) {
  cmdN += 1;
  const id = `e2e${cmdN}`;
  const before = existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean).length
    : 0;
  writeFileSync(
    commandsPath,
    JSON.stringify({ commandId: id, ts: Date.now(), type, args: args || {} }) +
      "\n",
    { flag: "a" }
  );
  const deadline = Date.now() + 8000;
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

const cat = await cmd("catalog.query", { kind: "item", limit: 20000 });
check(
  "catalog.query item total>0",
  !!(cat.ok && cat.payload && cat.payload.total > 0),
  `total=${cat.payload && cat.payload.total}${cat.error ? " err=" + cat.error : ""}`
);
if (cat.ok && cat.payload && cat.payload.total > 0) {
  const named = cat.payload.entries.filter((e) => e.name).length;
  check("item names present", named > 0, `${named}/${cat.payload.total} named`);
  elog(
    "sample items",
    cat.payload.entries
      .slice(0, 5)
      .map((e) => `${e.id}:${e.name}`)
      .join(" | ")
  );
}
for (const kind of ["weapon", "armor", "actor", "commonEvent"]) {
  const r = await cmd("catalog.query", { kind, limit: 20000 });
  check(
    `catalog.query ${kind} total>0`,
    !!(r.ok && r.payload && r.payload.total > 0),
    `total=${r.payload && r.payload.total}`
  );
}
// This game ships System.json with ALL 1101 switch names empty (the dev put
// the semantics in variable names instead — verified against the captured
// cache: 0/1101 named switches, 230/901 named variables). So switches assert
// only that $dataSystem resolved (namesUnavailable=false) with live values;
// the name-bearing assertion goes through variable.list.
const sw = await cmd("switch.list", { limit: 50 });
check(
  "switch.list resolves $dataSystem",
  !!(
    sw.ok &&
    sw.payload &&
    sw.payload.namesUnavailable === false &&
    sw.payload.entries.length > 0
  ),
  sw.ok
    ? `namesUnavailable=${sw.payload.namesUnavailable} entries=${sw.payload.entries.length}`
    : sw.error
);
const vr = await cmd("variable.list", { limit: 2000 });
check(
  "variable.list with names",
  !!(
    vr.ok &&
    vr.payload &&
    vr.payload.namesUnavailable === false &&
    vr.payload.entries.some((e) => e.name)
  ),
  vr.ok ? `namesUnavailable=${vr.payload.namesUnavailable}` : vr.error
);
if (vr.ok && vr.payload) {
  const namedVar = vr.payload.entries.find((e) => e.name);
  if (namedVar) elog("sample variable", `${namedVar.id}:${namedVar.name}`);
}
const mp = await cmd("map.list", {});
check(
  "map.list total>0",
  !!(mp.ok && mp.payload && mp.payload.total > 0),
  `total=${mp.payload && mp.payload.total}`
);
const party = await cmd("party.info", {});
elog(
  "party.info at title (capture fills after the user loads a save)",
  JSON.stringify((party && party.payload) || party).slice(0, 160)
);

elog("watching game process for 90s (ancestor-blacklist rule)...");
let alive = true;
const watchDeadline = Date.now() + 90000;
while (Date.now() < watchDeadline) {
  await new Promise((r) => setTimeout(r, 5000));
  const out = execSync(
    'powershell -NoProfile -ExecutionPolicy Bypass -File "runtime/_scratch/_is-game-alive.ps1"',
    { cwd: projectRoot }
  )
    .toString()
    .trim();
  if (out !== "ALIVE") {
    alive = false;
    break;
  }
}
check("game survives 90s", alive);

const fails = results.filter((r) => !r.ok);
elog(fails.length ? `E2E FAIL (${fails.length} failed)` : "E2E ALL PASS");
process.exitCode = fails.length ? 1 : 0;
