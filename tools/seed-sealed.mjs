// Detached seeder process for sealed-launcher MZ games (core/sealed-seed.mjs
// has the design notes). Spawned by core/launcher.mjs with env:
//   RMCH_SEED_CDP_PORT, RMCH_GAME_KEY, RMCH_GAME_ROOT, RMCH_PROJECT_ROOT
// Logs to runtime/bridge-state/<gameKey>/seed.log, seeds once, then stays as a
// reload watchdog until the game closes (exit 0) or the seed phase times out.
//
// Manual/testing use:
//   node tools/seed-sealed.mjs --port 9333 [--once] [--timeout 60000]

import { runSeededSeeder, seedAttempt, appendSeedLog } from "../core/sealed-seed.mjs";
import path from "node:path";

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : null;
}

const cdpPort = Number(argValue("--port") || process.env.RMCH_SEED_CDP_PORT || 0);
if (!cdpPort) {
  console.error("usage: seed-sealed.mjs --port <cdpPort> [--once] [--timeout <ms>]");
  process.exit(2);
}

const projectRoot = process.env.RMCH_PROJECT_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const gameKey = process.env.RMCH_GAME_KEY || "unknown";
const log = (message, extra) => {
  appendSeedLog(projectRoot, gameKey, message, extra);
  if (process.env.RMCH_SEED_DEBUG === "1") console.error("[seed]", message, extra || "");
};

if (argValue("--timeout")) {
  process.env.RMCH_SEED_TIMEOUT_MS = argValue("--timeout");
}

if (args.includes("--once")) {
  const result = await seedAttempt(cdpPort);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

log("seeder started", { cdpPort, pid: process.pid });
const result = await runSeededSeeder({ cdpPort, log });
log("seeder exit", { status: result.status });
// "game-closed" is the normal end of a fully seeded session (the watchdog
// standing down); only a seed-phase timeout is a failure.
process.exit(result.status === "timeout" ? 1 : 0);
