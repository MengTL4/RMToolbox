// Launch a game with the RMCH trainer bridge injected via --load-extension
// (zero game-file modification). Also ensures the bridge WebSocket server is
// running: if the port is free, a detached `tools/serve.mjs` process is
// spawned so the CLI/GUI can talk to the bridge after this process exits.

import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanGame, injectionStrategy } from "./scanner.mjs";
import { buildBridge } from "./bridge-bundler.mjs";
import { getToken } from "./token.mjs";
import { launchShadowGame } from "./shadow-launcher.mjs";

function portInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1200, () => done(false));
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}

async function waitForPort(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portInUse(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

export async function ensureServer({ projectRoot, port, token }) {
  if (await portInUse(port)) {
    return { running: true, started: false };
  }
  const serveScript = path.join(projectRoot, "tools", "serve.mjs");
  if (!existsSync(serveScript)) throw new Error(`serve script not found: ${serveScript}`);
  const child = spawn(process.execPath, [serveScript, "--port", String(port)], {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, RMCH_TOKEN: token, RMCH_PROJECT_ROOT: projectRoot },
    windowsHide: true
  });
  child.unref();
  const up = await waitForPort(port, 6000);
  return { running: up, started: true, pid: child.pid };
}

export async function launchGame({ gameRoot, projectRoot, port = 47412, strategy = "auto", build = true }) {
  const scan = scanGame(gameRoot);
  if (scan.engine.id === "RM2K" || scan.engine.id === "RGSS") {
    throw new Error(`engine "${scan.engine.id}" is not supported by the M1 injectors (planned: ${injectionStrategy(scan).id})`);
  }
  if (!scan.paths.exe) throw new Error("Game.exe not found in game root");

  const plan = injectionStrategy(scan);
  let chosen = strategy === "auto" ? (scan.manifest && scan.manifest.bgScript ? "shadow" : "extension") : strategy;
  if (chosen === "shadow" && !(scan.manifest && scan.manifest.bgScript)) {
    throw new Error("shadow strategy requires a bg-script game");
  }
  if (!["extension", "shadow"].includes(chosen)) {
    throw new Error(`unsupported strategy "${strategy}"`);
  }

  const token = getToken(projectRoot);
  if (build) buildBridge(projectRoot);
  const extensionDir = path.join(projectRoot, "runtime", "bridge");
  if (!existsSync(path.join(extensionDir, "manifest.json"))) throw new Error(`bridge extension missing: ${extensionDir}`);

  const server = await ensureServer({ projectRoot, port, token });

  let processInfo;
  if (chosen === "shadow") {
    processInfo = launchShadowGame({ projectRoot, scan, gameKey: scan.gameKey, port, token });
  } else {
    const child = spawn(scan.paths.exe, [`--load-extension=${extensionDir}`], {
      cwd: scan.root,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        RMCH_GAME_ROOT: scan.root,
        RMCH_PROJECT_ROOT: projectRoot,
        RMCH_GAME_KEY: scan.gameKey,
        RMCH_WS_PORT: String(port),
        RMCH_WS_TOKEN: token
      },
      windowsHide: true
    });
    child.unref();
    processInfo = { pid: child.pid };
  }

  return {
    game: scan.title,
    gameKey: scan.gameKey,
    root: scan.root,
    engine: scan.engine.id,
    protection: scan.protection,
    strategy: chosen,
    strategyReason: chosen === "shadow" ? "bg-script startup chain: shadow dir + patched bg-script" : plan.reason,
    pid: processInfo.pid,
    shadowApp: processInfo.appDir || null,
    server,
    port,
    extensionDir
  };
}
