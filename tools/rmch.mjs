#!/usr/bin/env node
// RMCH unified CLI.
// Usage:
//   node tools/rmch.mjs scan [gameRoot|steam] [--json]
//   node tools/rmch.mjs serve [--port 47412]
//   node tools/rmch.mjs launch <gameRoot> [--port 47412] [--strategy auto|extension]
//   node tools/rmch.mjs attach <gameRoot> [--port 47412]
//   node tools/rmch.mjs send <gameRoot|gameKey> <command.type> [jsonArgs]
//   node tools/rmch.mjs bridge-build
//   node tools/rmch.mjs token

import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage(exitCode = 0) {
  const text = [
    "RMCH - RPG Maker Cheat Hub",
    "",
    "Commands:",
    "  scan [gameRoot|steam] [--json]   Scan a game directory (default: all Steam libraries)",
    "  serve [--port 47412]             Start standalone bridge WebSocket server (for testing)",
    "  launch <gameRoot> [--port N]     Launch game with injected trainer bridge",
    "  attach <gameRoot> [--port N]     Attach to an ALREADY-RUNNING game via DLL injection",
    "  send <gameRoot|gameKey> <type> [jsonArgs]   Send one command to a running bridge",
    "  bridge-build                     Build runtime/bridge/page-bridge.js from src parts",
    "  token                            Print the local auth token",
    "",
    "Project root: " + projectRoot
  ].join("\n");
  console.log(text);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options[key] = next;
        index += 1;
      } else {
        options[key] = true;
      }
    } else {
      positional.push(value);
    }
  }
  return { positional, options };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") usage();

  switch (command) {
    case "scan": {
      const { scanGame, findSteamLibraries, scanLibrary } = await import("../core/scanner.mjs");
      const { positional, options } = parseArgs(rest);
      const target = positional[0];
      let results = [];
      if (!target || target === "steam") {
        for (const library of findSteamLibraries()) {
          results = results.concat(scanLibrary(library));
        }
      } else {
        results = [scanGame(path.resolve(target))];
      }
      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        for (const info of results) printScan(info);
        if (!results.length) console.log("No RPG Maker games found.");
      }
      break;
    }
    case "serve": {
      const { runStandaloneServer } = await import("./serve.mjs");
      const { options } = parseArgs(rest);
      await runStandaloneServer({ port: Number(options.port) || 47412, projectRoot });
      break;
    }
    case "launch": {
      const { launchGame } = await import("../core/launcher.mjs");
      const { positional, options } = parseArgs(rest);
      if (!positional[0]) usage(1);
      const summary = await launchGame({
        gameRoot: path.resolve(positional[0]),
        projectRoot,
        port: Number(options.port) || 47412,
        strategy: options.strategy || "auto"
      });
      // Session objects are live EventEmitters — not printable. A Tauri
      // session also pins the event loop via its CDP socket; the CLI has no
      // IPC back to it, so close it and point interactive use at the GUI.
      const tauriSession = summary.tauriSession;
      const printable = { ...summary };
      delete printable.rgssSession;
      delete printable.tauriSession;
      console.log(JSON.stringify(printable, null, 2));
      if (tauriSession) {
        tauriSession.close();
        console.error("[rmch] tauri-cdp sessions live inside the launcher process — use the GUI (or keep this process alive) for trainer commands");
      }
      break;
    }
    case "attach": {
      const { attachGame } = await import("../core/attach.mjs");
      const { positional, options } = parseArgs(rest);
      if (!positional[0]) usage(1);
      const summary = await attachGame({
        gameRoot: path.resolve(positional[0]),
        projectRoot,
        port: Number(options.port) || 47412
      });
      // The RGSS summary carries a live EventEmitter session — not printable.
      const printable = { ...summary };
      delete printable.session;
      console.log(JSON.stringify(printable, null, 2));
      break;
    }
    case "send": {
      const { sendCommand } = await import("./send.mjs");
      const { positional } = parseArgs(rest);
      const [target, type, rawArgs] = positional;
      if (!target || !type) usage(1);
      let args = {};
      if (rawArgs) {
        try {
          args = JSON.parse(rawArgs);
        } catch (error) {
          console.error(`invalid JSON args: ${error.message}`);
          process.exit(1);
        }
      }
      const result = await sendCommand({ projectRoot, target, type, args });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "bridge-build": {
      const { buildBridge } = await import("../core/bridge-bundler.mjs");
      const output = buildBridge(projectRoot);
      console.log(`bridge built: ${output}`);
      break;
    }
    case "token": {
      const { getToken } = await import("../core/token.mjs");
      console.log(getToken(projectRoot));
      break;
    }
    default:
      console.error(`unknown command: ${command}`);
      usage(1);
  }
}

function printScan(info) {
  const lines = [
    `${info.title}  [${info.engine.id}${info.engine.bytecode ? " bytecode" : ""}]`,
    `  root:       ${info.root}`,
    `  gameKey:    ${info.gameKey}`,
    `  engine:     ${info.engine.id} (confidence: ${info.engine.confidence})`,
    `  layout:     ${info.layout}  protection: L${info.protection.level} [${info.protection.flags.join(", ") || "none"}]`,
    `  exe:        ${info.paths.exe || "-"}`
  ];
  console.log(lines.join("\n"));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
