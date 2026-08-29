// Launch a game with the RMCH trainer bridge injected via --load-extension
// (zero game-file modification). Also ensures the bridge WebSocket server is
// running: if the port is free, a detached `tools/serve.mjs` process is
// spawned so the CLI/GUI can talk to the bridge after this process exits.
// Extension launches get a private per-game --user-data-dir (see the spawn
// site) so same-profile games cannot single-instance-kill each other.

import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanGame, injectionStrategy } from "./scanner.mjs";
import { buildBridge } from "./bridge-bundler.mjs";
import { getToken } from "./token.mjs";
import { launchShadowGame } from "./shadow-launcher.mjs";
import { launchRgssGame, getRgssSession, listRgssSessions } from "./rgss-launcher.mjs";

// The GUI host routes commands/sessions through these; re-export so it only
// ever talks to this module.
export { getRgssSession, listRgssSessions };

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
  if (scan.engine.id === "RM2K") {
    throw new Error(`engine "${scan.engine.id}" is not supported by the M1 injectors (planned: ${injectionStrategy(scan).id})`);
  }
  if (/^RGSS/i.test(scan.engine.id)) {
    // RGSS games need no ws server and no extension build: the bridge is a
    // Ruby entry spliced into the shadow copy's Scripts archive.
    const handle = await launchRgssGame({ gameRoot: scan.root, projectRoot, gameKey: scan.gameKey });
    return {
      game: scan.title,
      gameKey: scan.gameKey,
      root: scan.root,
      engine: scan.engine.id,
      protection: scan.protection,
      strategy: "rgss-script",
      strategyReason: "shadow copy + Scripts archive entry before rgss_main",
      pid: handle.child.pid,
      shadowApp: handle.prepared.shadowRoot,
      rgssSession: handle.session,
      server: null,
      port: null
    };
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
    // Per-game private profile. Most RM games keep the manifest default name
    // ("rmmz-game" — even MV titles), so without this they all share one
    // Chromium profile: a running (or zombie) instance makes the next launch
    // die on the single-instance check, and a profile written by a newer
    // NW.js breaks older games ("database is too new"). The shadow strategy
    // already does this; extension launches get the same isolation. The dir
    // is persistent (NOT wiped per launch) so plugin data that lands in
    // nw.App.dataPath survives across runs.
    const profileDir = path.join(projectRoot, "runtime", "profiles", scan.gameKey);
    mkdirSync(profileDir, { recursive: true });
    const child = spawn(scan.paths.exe, [
      `--user-data-dir=${profileDir}`,
      `--load-extension=${extensionDir}`
    ], {
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
      // Do NOT set windowsHide here: it lands in the child's STARTUPINFO as
      // SW_HIDE, and old NW.js builds (0.29-era MV games) create their main
      // window with SW_SHOWDEFAULT, which honors it — the game window is born
      // invisible while the page runs normally. Game.exe is GUI-subsystem,
      // so there is no console window to hide anyway.
      windowsHide: false
    });
    child.unref();
    processInfo = { pid: child.pid, profileDir };
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
    profileDir: processInfo.profileDir || null,
    server,
    port,
    extensionDir
  };
}
