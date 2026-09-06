// FileSession adoption test: the bridge server owning runtime/bridge-state
// must adopt a live file channel (fresh state.json) exactly once, route
// commands over commands.jsonl/events.jsonl, and drop the session when the
// bridge stops rewriting state.json. A fake bridge (this test appending to
// files) stands in for the game — the same contract attachNwFile relies on.
import assert from "node:assert/strict";
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BridgeServer } from "../core/ws-server.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(80);
  }
}

function writeState(dir, gameKey) {
  writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({ gameKey, bridgeVersion: "9.9.9-test", engine: "RMMZ", saveDir: null })
  );
}

async function main() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rmch-file-session-test-"));
  const server = new BridgeServer({ port: 0, token: "t", stateDir: path.join(tempRoot, "bridge-state") });
  const opened = [];
  const closed = [];
  server.on("session-open", (gameKey) => opened.push(gameKey));
  server.on("session-closed", (gameKey) => closed.push(gameKey));
  await server.start();
  try {
    const stateDir = server.stateDir;

    // A stale channel (dead bridge's leftovers) must NOT be adopted.
    const staleDir = path.join(stateDir, "stale-game");
    mkdirSync(staleDir, { recursive: true });
    writeState(staleDir, "stale-game");
    const old = new Date(Date.now() - 60000);
    utimesSync(path.join(staleDir, "state.json"), old, old);
    await sleep(2000);
    assert.equal(server.session("stale-game"), null, "stale channel not adopted");

    // A live channel (state.json freshly rewritten) IS adopted, exactly once.
    const dir = path.join(stateDir, "fake-game");
    mkdirSync(dir, { recursive: true });
    writeState(dir, "fake-game");
    writeFileSync(path.join(dir, "events.jsonl"), '{"t":"hello","bridgeVersion":"9.9.9-test"}\n');
    const heartbeat = setInterval(() => {
      try { writeState(dir, "fake-game"); } catch (_) {}
    }, 500);
    const session = await waitFor(() => server.session("fake-game"), "adoption of fresh channel");
    assert.deepEqual(opened, ["fake-game"], "one session-open event");
    const described = server.listSessions().find((entry) => entry.gameKey === "fake-game");
    assert.equal(described.alive, true, "fresh session is alive");
    assert.equal(described.transport, "file", "transport tag");
    assert.equal(described.bridgeVersion, "9.9.9-test", "bridge version from state.json");
    await sleep(2000); // several scan ticks
    assert.deepEqual(opened, ["fake-game"], "no duplicate adoption while fresh");

    // Commands ride commands.jsonl out and events.jsonl back ("file:" prefix).
    const pending = server.sendCommand("fake-game", "ping", { n: 1 });
    const commandPath = path.join(dir, "commands.jsonl");
    await waitFor(() => existsSync(commandPath) && readFileSync(commandPath, "utf8").trim(), "command line");
    const command = JSON.parse(readFileSync(commandPath, "utf8").trim().split("\n")[0]);
    assert.equal(command.type, "ping");
    assert.deepEqual(command.args, { n: 1 });
    assert.match(command.commandId, /^f\d+$/);
    appendFileSync(
      path.join(dir, "events.jsonl"),
      JSON.stringify({ ts: Date.now(), commandId: `file:${command.commandId}`, type: "ping", ok: true, payload: { pong: true } }) + "\n"
    );
    assert.deepEqual(await pending, { pong: true }, "command result resolves with payload");

    // Bridge dies (state.json stops being rewritten) → session dropped.
    clearInterval(heartbeat);
    await waitFor(() => closed.includes("fake-game"), "stale drop", 10000);
    assert.equal(server.session("fake-game"), null, "session removed after staleness");

    console.log("test-file-session: all assertions passed");
  } finally {
    await server.stop();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
