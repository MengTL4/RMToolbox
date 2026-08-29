// Standalone bridge server for testing / CLI-only usage.
// The GUI embeds the same BridgeServer class instead of running this script.
//
// When run directly (`node tools/serve.mjs --port 47412 [--project-root .]`)
// it stays alive until killed; the launcher spawns it detached so CLI `send`
// commands keep working after the launching process exits.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeServer } from "../core/ws-server.mjs";
import { getToken } from "../core/token.mjs";

export async function runStandaloneServer({ port = 47412, projectRoot } = {}) {
  const token = getToken(projectRoot);
  const server = new BridgeServer({
    port, token,
    stateDir: path.join(projectRoot, "runtime", "bridge-state")
  });
  server.on("session-open", (gameKey) => {
    console.log(`[rmch] bridge connected: ${gameKey}`);
  });
  server.on("session-closed", (gameKey) => {
    console.log(`[rmch] bridge disconnected: ${gameKey}`);
  });
  await server.start();
  console.log(`[rmch] bridge server listening on ws://127.0.0.1:${port} (token auth)`);
  return server;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const args = process.argv.slice(2);
  const readOption = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
  };
  const port = Number(readOption("port", 47412)) || 47412;
  const projectRoot = path.resolve(readOption("project-root", path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
  await runStandaloneServer({ port, projectRoot });
  process.on("SIGINT", () => process.exit(0));
}
