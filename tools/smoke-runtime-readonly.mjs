#!/usr/bin/env node
// Launch one idle game, exercise read-only bridge commands, and close only
// newly observed processes for this game's real/shadow paths. No save/load,
// new-game, gold/item changes, channel deletion or process-name-wide kills.
// node tools/smoke-runtime-readonly.mjs <gameRoot> [--bundle] [--attach]
// --attach re-attaches to the instance THIS run launched (no takeover families).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const gameRoot = process.argv[2];
if (!gameRoot)
  throw new Error(
    "usage: smoke-runtime-readonly.mjs <gameRoot> [--bundle] [--attach]"
  );
const bundle = process.argv.includes("--bundle")
  ? createRequire(import.meta.url)("../app/gui/gui-bundle.cjs")
  : null;
const load = (name) =>
  bundle ? bundle.mod(`core/${name}.mjs`) : import(`../core/${name}.mjs`);
const { gameRuntime } = await load("game-runtime");
const { BridgeServer } = await load("ws-server");
const { BridgeSessions, externalSessions } = await load("bridge-sessions");
const { scanGame } = await load("scanner");
const { getToken } = await load("token");
const { listProcessesByExeName } = await load("attach");
const scan = scanGame(path.resolve(gameRoot));
const normalize = (value) =>
  path.resolve(value).replace(/\\/g, "/").toLowerCase();
const roots = [
  scan.root,
  path.join(projectRoot, "runtime", "shadow-apps", scan.gameKey),
  path.join(projectRoot, "runtime", "rgss-shadow", scan.gameKey)
].map(normalize);
const originalExe = path.parse(scan.paths.exe);
const names = new Set(
  scan.container === "evb" ? ["Game.exe"] : [originalExe.base]
);
if (scan.container === "tauri")
  names.add(`${originalExe.name}.rmch-cdp${originalExe.ext}`);
if (scan.container === "evb") names.add("Game.exe");
const belongs = (p) =>
  p.ExecutablePath &&
  roots.some((root) => normalize(p.ExecutablePath).startsWith(root + "/"));
async function processes() {
  const all = [];
  for (const name of names) all.push(...(await listProcessesByExeName(name)));
  return [...new Map(all.map((p) => [p.ProcessId, p])).values()];
}
const before = await processes();
if (before.some(belongs))
  throw new Error(
    "target game is already running; close it before this launch smoke test"
  );
if (before.some((p) => !p.ExecutablePath))
  throw new Error(
    "cannot identify an existing matching process; skipping launch smoke test"
  );
const preexisting = new Set(before.map((p) => p.ProcessId));
if (
  process.argv.includes("--attach") &&
  ["tauri", "nwjs-sealed", "nwjs-bundled", "evb"].includes(scan.container)
) {
  throw new Error(
    "--attach is only for ordinary NW/RGSS or NB injection, not takeover families"
  );
}

// Compare the scanner's save directory before/after; no source file is written
// by this check. Some games can have additional custom save directories.
function saveHashes() {
  const entries = {};
  const dir = scan.paths.saveDir;
  function visit(current) {
    if (!current || !existsSync(current)) return;
    for (const name of readdirSync(current)) {
      const file = path.join(current, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile())
        entries[path.relative(dir, file)] = createHash("sha256")
          .update(readFileSync(file))
          .digest("hex");
    }
  }
  visit(dir);
  return entries;
}
const savesBefore = saveHashes();
const server = new BridgeServer({
  port: 0,
  token: getToken(projectRoot),
  stateDir: path.join(projectRoot, "runtime", "bridge-state")
});
const sessions = new BridgeSessions({ server });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {
  gameKey: scan.gameKey,
  container: scan.container || "nwjs",
  bundle: !!bundle,
  checks: []
};
let failure;
try {
  await server.start();
  const port = server.httpServer.address().port;
  console.log(JSON.stringify({ phase: "launch", gameKey: scan.gameKey, port }));
  const summary = await gameRuntime.launch({
    gameRoot: scan.root,
    projectRoot,
    port
  });
  report.strategy = summary.strategy;
  console.log(
    JSON.stringify({
      phase: "launched",
      strategy: summary.strategy,
      pid: summary.pid
    })
  );
  const deadline = Date.now() + 180000;
  while (!sessions.list().some((s) => s.gameKey === scan.gameKey && s.alive)) {
    if (Date.now() > deadline)
      throw new Error("no live bridge session within 180s");
    await sleep(500);
  }
  assert.equal(
    sessions.list().filter((s) => s.gameKey === scan.gameKey).length,
    1
  );
  report.checks.push("one live session");
  for (const [type, args] of [
    ["ping", {}],
    ["runtime.info", {}],
    ["catalog.query", { kind: "skill", limit: 20000 }]
  ]) {
    let payload = await sessions.send(scan.gameKey, type, args);
    if (type === "catalog.query") {
      // A title screen may legitimately expose an empty catalog. The smoke
      // check therefore asserts the response shape, while the command itself
      // still traverses the full transport and handler path.
      assert.ok(
        payload &&
          Number.isInteger(payload.total) &&
          Array.isArray(payload.entries),
        "catalog response shape"
      );
    }
    report.checks.push({
      type,
      ok: true,
      total: payload && payload.total,
      entries: payload && payload.entries && payload.entries.length
    });
    console.log(
      JSON.stringify({
        phase: "command",
        ...report.checks[report.checks.length - 1]
      })
    );
  }
  if (process.argv.includes("--attach")) {
    const attached = await gameRuntime.attach({
      gameRoot: scan.root,
      projectRoot,
      port
    });
    await sessions.send(scan.gameKey, "ping");
    assert.equal(
      sessions.list().filter((s) => s.gameKey === scan.gameKey).length,
      1
    );
    report.checks.push({
      type: "attach",
      strategy: attached.strategy,
      ok: true
    });
  }
} catch (error) {
  failure = error;
  report.error = error.stack || error.message;
} finally {
  try {
    for (const p of (await processes()).filter(
      (p) => belongs(p) && !preexisting.has(p.ProcessId)
    )) {
      await new Promise((resolve) =>
        execFile(
          "taskkill",
          ["/PID", String(p.ProcessId), "/T", "/F"],
          { windowsHide: true },
          resolve
        )
      );
    }
    const deadline = Date.now() + 12000;
    while (
      sessions.list().some((s) => s.gameKey === scan.gameKey && s.alive) &&
      Date.now() < deadline
    )
      await sleep(500);
    assert.equal(
      sessions.list().some((s) => s.gameKey === scan.gameKey && s.alive),
      false,
      "session removed after game closes"
    );
    report.checks.push("session closed");
    if (scan.paths.saveDir) {
      assert.deepEqual(
        saveHashes(),
        savesBefore,
        "scanner save directory unchanged"
      );
      report.checks.push("scanner save directory unchanged");
    } else {
      report.checks.push(
        "scanner has no save directory; save hash comparison unavailable"
      );
    }
  } catch (error) {
    failure = failure || error;
    report.cleanupError = error.stack || error.message;
  }
  const external = externalSessions.find(scan.gameKey);
  if (external) external.close();
  sessions.dispose();
  await server.stop();
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = failure ? 1 : 0;
