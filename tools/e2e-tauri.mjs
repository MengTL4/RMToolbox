// End-to-end smoke test for the Tauri-CDP path against the real
// "Demon forest" (魔物召唤森林) install: scan → launch patched exe → wait for
// the bridge hello over the CDP outbox → run a few trainer commands → stop.
// Manual verification tool, not part of `npm test` (needs the Steam game).

import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanGame } from "../core/scanner.mjs";
import { launchGame } from "../core/launcher.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gameRoot = process.argv[2] || "F:/SteamLibrary/steamapps/common/Demon forest";

const scan = scanGame(gameRoot);
console.log("scan:", JSON.stringify({
  engine: scan.engine, container: scan.container, tauri: scan.tauri,
  saveDir: scan.paths.saveDir || null, flags: scan.protection.flags
}, null, 2));
if (scan.container !== "tauri") throw new Error("expected container=tauri");

console.log("launching (patched exe copy + CDP)...");
const summary = await launchGame({ gameRoot: scan.root, projectRoot });
console.log("launched:", JSON.stringify({ strategy: summary.strategy, pid: summary.pid, cdpPort: summary.cdpPort, patchedExe: summary.patchedExe }));

const session = summary.tauriSession;
if (!session.hello) {
  console.log("waiting for bridge hello...");
  await Promise.race([
    once(session, "hello"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("hello timed out")), 30000))
  ]);
}
console.log("hello:", JSON.stringify(session.hello));

for (const [type, args] of [
  ["ping", {}],
  ["runtime.info", {}],
  ["gold.set", { value: 54321 }],
  ["save.list", {}],
  ["save.contents.get", {}]
]) {
  try {
    const result = await session.send(type, args);
    const text = JSON.stringify(result);
    console.log(`cmd ${type}:`, text.length > 400 ? text.slice(0, 400) + `... (${text.length} bytes)` : text);
  } catch (error) {
    console.log(`cmd ${type} FAILED:`, error.message);
  }
}

// give one state push a chance to arrive, then report it
await new Promise((resolve) => setTimeout(resolve, 1500));
console.log("state:", JSON.stringify(session.state && {
  gold: session.state.gold,
  map: session.state.map,
  saveDir: session.state.saveDir,
  wsConnected: session.state.wsConnected,
  lastError: session.state.lastError
}));

console.log("stopping game...");
try {
  process.kill(summary.pid);
} catch (_) {}
await Promise.race([
  once(session, "close"),
  new Promise((resolve) => setTimeout(resolve, 5000))
]);
console.log("e2e done");
process.exit(0);
