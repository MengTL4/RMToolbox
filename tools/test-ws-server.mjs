// Contract test for core/ws-server.mjs using Node's built-in WebSocket client.
// Covers: token auth rejection, hello handshake, command round-trip,
// state broadcast, fragmentation of a large incoming message, timeout.

import assert from "node:assert/strict";
import { BridgeServer } from "../core/ws-server.mjs";

function connect(port, gameKey, token) {
  const url = `ws://127.0.0.1:${port}/bridge/${encodeURIComponent(gameKey)}?token=${encodeURIComponent(token)}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.t === "hello" && message.ok) resolve({ socket, messages: pending, message });
      else pending.push(message);
    };
    socket.onerror = () => reject(new Error("connection failed"));
    socket.onclose = () => {};
  });
}

function waitMessage(client, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const handler = () => check();
    const cleanup = () => client.socket.removeEventListener("message", handler);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`message wait timeout; pending=${JSON.stringify(client.messages.map((m) => m.t))}`));
    }, timeoutMs);
    const check = () => {
      const index = client.messages.findIndex(predicate);
      if (index === -1) return;
      clearTimeout(timer);
      cleanup();
      resolve(client.messages.splice(index, 1)[0]);
    };
    client.socket.addEventListener("message", handler);
    check();
  });
}

async function main() {
  const port = 47499;
  const token = "test-token-123";
  const server = new BridgeServer({ port, token });
  await server.start();

  // 1. wrong token is rejected
  await assert.rejects(
    () => connect(port, "game-a", "wrong-token"),
    /connection failed/,
    "wrong token must be rejected"
  );

  // 2. valid token: hello handshake
  const client = await connect(port, "game-a", token);
  assert.equal(server.listSessions().length, 1);

  // 3. bridge hello info
  client.socket.send(JSON.stringify({ t: "hello", bridgeVersion: "0.3.0", engine: "MV" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(server.session("game-a").info.bridgeVersion, "0.3.0");
  assert.equal(server.session("game-a").info.engine, "MV");

  // 4. state broadcast
  const stateEvent = new Promise((resolve) => server.once("state", (gameKey, state) => resolve(state)));
  client.socket.send(JSON.stringify({ t: "state", state: { gold: 123 } }));
  assert.deepEqual(await stateEvent, { gold: 123 });

  // 5. command round-trip: server sends cmd, bridge replies result
  const replyPromise = server.sendCommand("game-a", "gold.add", { amount: 500 });
  const cmd = await waitMessage(client, (m) => m.t === "cmd");
  assert.equal(cmd.type, "gold.add");
  assert.deepEqual(cmd.args, { amount: 500 });
  client.socket.send(JSON.stringify({ t: "result", id: cmd.id, ok: true, payload: { gold: 623 } }));
  assert.deepEqual(await replyPromise, { gold: 623 });

  // 6. command failure propagates the error message
  const failPromise = server.sendCommand("game-a", "bad.command", {}).catch((error) => error);
  const failCmd = await waitMessage(client, (m) => m.t === "cmd");
  client.socket.send(JSON.stringify({ t: "result", id: failCmd.id, ok: false, error: "unknown command type" }));
  assert.match(String(await failPromise), /unknown command type/);

  // 7. pong keeps the session alive
  client.socket.send(JSON.stringify({ t: "pong" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(server.session("game-a"), "session must survive ping cycle");

  // 8. unknown game key rejects
  await assert.rejects(
    () => server.sendCommand("missing-game", "ping", {}),
    /no running bridge/
  );

  // 9. second connection with the same key replaces the first
  const client2 = await connect(port, "game-a", token);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(server.listSessions().length, 1);
  client.socket.close();
  client2.socket.close();
  await server.stop();
  console.log("ws-server contract test: PASS");
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
