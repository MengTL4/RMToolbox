// Exercise the host-facing interface with the real RGSS, CDP and file-session
// adapters. Temporary JSONL files and an in-process CDP peer stand in for games.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { BridgeSessions, SessionRegistry } from "../core/bridge-sessions.mjs";
import { BridgeServer } from "../core/ws-server.mjs";
import { RgssSession } from "../core/rgss-launcher.mjs";
import { TauriSession } from "../core/tauri-cdp.mjs";

const root = mkdtempSync(path.join(tmpdir(), "rmch-sessions-"));
const registry = new SessionRegistry();
const server = new BridgeServer({ port: 0, token: "test", stateDir: path.join(root, "state") });
const sessions = new BridgeSessions({ server, registry });
const opened = [], closed = [], states = [], changed = [];
sessions.on("session-open", (key) => opened.push(key));
sessions.on("session-closed", (key) => closed.push(key));
sessions.on("state", (key, state) => states.push([key, state]));
sessions.on("changed", (key) => changed.push(key));
const adapters = [];
let fileHeartbeat = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  await server.start();
  const rgss = new RgssSession({ dir: root, gameKey: "ruby" });
  adapters.push(rgss);
  registry.register("rgss", rgss);
  registry.register("rgss", rgss);
  assert.deepEqual(opened, ["ruby"], "same session registers once");
  assert.equal(sessions.list()[0].alive, false, "not ready until hello");
  appendFileSync(rgss.resPath, JSON.stringify({ t: "hello", version: "test", engine: "RGSS3" }) + "\n");
  rgss.poll();
  assert.equal(sessions.list()[0].alive, true);
  assert.deepEqual(changed, ["ruby"]);

  const result = sessions.send("ruby", "ping", { name: "中文" });
  const cmd = JSON.parse(readFileSync(rgss.cmdPath, "utf8").trim());
  assert.deepEqual(cmd.args, { name: "中文" });
  const reply = Buffer.from(JSON.stringify({ t: "result", id: cmd.id, ok: true, payload: "图标🐉" }) + "\n");
  const split = reply.indexOf(Buffer.from("图")) + 1;
  appendFileSync(rgss.resPath, reply.subarray(0, split));
  rgss.poll();
  appendFileSync(rgss.resPath, reply.subarray(split));
  rgss.poll();
  assert.equal(await result, "图标🐉", "RGSS command survives a split UTF-8 response");

  const tauri = new TauriSession({ gameKey: "webview", pid: process.pid, cdpPort: 0, saveDir: root });
  adapters.push(tauri);
  tauri.cdp = {
    close() {},
    async evaluate(expression) {
      return vm.runInNewContext(expression, { window: { __rmchDispatch(text) {
        const command = JSON.parse(text);
        queueMicrotask(() => tauri.handleBridgeMessage(JSON.stringify({ t: "result", id: command.id, ok: true, payload: command.args })));
      } } });
    }
  };
  registry.register("tauri", tauri);
  assert.equal(sessions.list().find((s) => s.gameKey === "webview").alive, false);
  tauri.handleBridgeMessage(JSON.stringify({ t: "hello", bridgeVersion: "test", engine: "MZ" }));
  assert.equal(sessions.list().find((s) => s.gameKey === "webview").alive, true);
  assert.deepEqual(await sessions.send("webview", "ping", { n: 3 }), { n: 3 });
  writeFileSync(path.join(root, "file1.rmmzsave"), "fixture");
  const saves = await sessions.send("webview", "save.list");
  assert.equal(saves.entries[0].name, "file1.rmmzsave", "CDP local save-list behavior survives");

  // A stale session must not remove or notify on behalf of its replacement.
  const replacementDir = path.join(root, "replacement");
  mkdirSync(replacementDir);
  const replacement = new RgssSession({ dir: replacementDir, gameKey: "ruby" });
  adapters.push(replacement);
  registry.register("rgss", replacement);
  const oldPending = assert.rejects(rgss.send("ping"), /not connected|disconnected/);
  rgss.close();
  await oldPending;
  assert.strictEqual(registry.get("rgss", "ruby"), replacement);
  assert.deepEqual(closed, [], "old close cannot close its replacement");
  rgss.emit("state", { old: true });
  replacement.emit("state", { current: true });
  assert.deepEqual(states, [["ruby", { current: true }]]);
  const pending = assert.rejects(sessions.send("ruby", "ping"), /disconnected/);
  replacement.close();
  replacement.close();
  await pending;
  assert.deepEqual(closed, ["ruby"]);
  assert.equal(sessions.list().some((s) => s.gameKey === "ruby"), false);

  // File sessions still belong to BridgeServer; the manager discovers and
  // dispatches through the same interface without external registration.
  const fileDir = path.join(server.stateDir, "file");
  mkdirSync(fileDir, { recursive: true });
  // The bridge creates events.jsonl while emitting hello, before state.json;
  // mirror that ordering so from-end adoption starts at a stable offset.
  writeFileSync(path.join(fileDir, "events.jsonl"), "");
  writeFileSync(path.join(fileDir, "state.json"), JSON.stringify({ engine: "MV", bridgeVersion: "test" }));
  fileHeartbeat = setInterval(() => {
    try { writeFileSync(path.join(fileDir, "state.json"), JSON.stringify({ engine: "MV", bridgeVersion: "test" })); } catch (_) {}
  }, 500);
  server.scanFileSessions();
  assert.equal(sessions.list().find((s) => s.gameKey === "file").alive, true);
  const fileResult = sessions.send("file", "ping");
  const fileCmd = JSON.parse(readFileSync(path.join(fileDir, "commands.jsonl"), "utf8").trim());
  appendFileSync(path.join(fileDir, "events.jsonl"), JSON.stringify({ commandId: `file:${fileCmd.commandId}`, ok: true, payload: { pong: true } }) + "\n");
  assert.deepEqual(await fileResult, { pong: true });
  clearInterval(fileHeartbeat);
  fileHeartbeat = null;

  const cdpPending = assert.rejects(sessions.send("webview", "waiting"), /disconnected/);
  tauri.close();
  await cdpPending;
  assert.equal(registry.get("tauri", "webview"), null);
  sessions.dispose();
  sessions.dispose();
  assert.equal(registry.listenerCount("state"), 0);
  assert.equal(server.listenerCount("state"), 0);
  await sleep(10);
} finally {
  if (fileHeartbeat) clearInterval(fileHeartbeat);
  sessions.dispose();
  for (const adapter of adapters) adapter.close();
  await server.stop();
  rmSync(root, { recursive: true, force: true });
}
console.log("test-bridge-sessions: real adapters, readiness, routing, replacement and teardown passed");
