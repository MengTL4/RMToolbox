// Launch a game with the RMCH trainer bridge injected via --load-extension
// (zero game-file modification). Also ensures the bridge WebSocket server is
// running: if the port is free, a detached `tools/serve.mjs` process is
// spawned so the CLI/GUI can talk to the bridge after this process exits.
// Extension launches get a private per-game --user-data-dir (see the spawn
// site) so same-profile games cannot single-instance-kill each other.

import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanGame } from "./scanner.mjs";
import { planLaunch } from "./launch-plan.mjs";
import { buildBridge } from "./bridge-bundler.mjs";
import { getToken } from "./token.mjs";
import { launchShadowGame, launchBundledShadowGame } from "./shadow-launcher.mjs";
import { launchRgssGame, getRgssSession, listRgssSessions } from "./rgss-launcher.mjs";
import { ensureEvbUnpackedAsync } from "./evb-unpack.mjs";
import { launchTauriGame, getTauriSession, listTauriSessions } from "./tauri-cdp.mjs";
import { pickFreePort, runSeededSeeder, appendSeedLog } from "./sealed-seed.mjs";

// The GUI host routes commands/sessions through these; re-export so it only
// ever talks to this module.
export { getRgssSession, listRgssSessions, getTauriSession, listTauriSessions };

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
  await once(child, "spawn");
  child.unref();
  const up = await waitForPort(port, 6000);
  return { running: up, started: true, pid: child.pid };
}

export async function launchGame({ gameRoot, projectRoot, port = 47412, strategy = "auto", build = true, onProgress }) {
  const scan = scanGame(gameRoot);
  if (scan.container === "nb-shell") {
    // Measured (ACCEPTANCE v0.6.3): any extra launch flag (--load-extension,
    // --remote-debugging-port, --user-data-dir) makes the shell exit at boot,
    // so even the flag-free parts of a toolbox launch are impossible.
    throw new Error(
      "nb-shell protected game (nbtool.node): the shell hash-verifies its boot files, refuses every launch flag and kills injected code — " +
      "start it with its own exe; the toolbox cannot attach to this shell either"
    );
  }
  if (scan.container === "nb-evalnwbin") {
    // The shell refuses every launch flag (measured: even --user-data-dir
    // alone dies at boot), so the standard extension launch would kill the
    // game. Launching plain and then attaching works — but the inject
    // machinery lives in attach.mjs, which already imports this module;
    // routing host-side keeps the GUI bundle cycle-free. CLI: use attach.
    throw new Error(
      "nb-evalnwbin shell game: it refuses every launch flag, so the extension launch path would kill it — " +
      'use attach instead (the GUI "启动并注入" button launches plain + injects automatically)'
    );
  }
  if (scan.container === "enigma-nb") {
    // Same shape as nb-evalnwbin: the Enigma box exits within 10-25s when ANY
    // launch flag is present (measured on 三国修仙传 V1.91), so the extension
    // path is fatal. Plain spawn + DLL attach lives in attach.mjs.
    throw new Error(
      "enigma-nb boxed game: any launch flag makes the Enigma box exit, so the extension launch path would kill it — " +
      'use attach instead (the GUI "启动并注入" button launches plain + injects automatically)'
    );
  }
  if (strategy !== "shadow" && scan.protection && scan.protection.flags && scan.protection.flags.includes("grover-boot")) {
    // The Grover shell's toolbox-shadowed launch freezes the payload after its
    // (shim-assisted) verification, while the plainly launched real game runs
    // fine — its suicide paths fail on their own. Route like enigma-nb:
    // plain spawn + DLL attach lives in attach.mjs.
    throw new Error(
      "grover-boot shell game: the shadow launch freezes after the shell's verification — " +
      'use attach instead (the GUI "启动并注入" button launches plain + injects automatically)'
    );
  }
  if (scan.engine.id === "RM2K") {
    throw new Error(`engine "${scan.engine.id}" is not supported by the toolbox launch routes (${planLaunch(scan).error || "no route"})`);
  }
  if (scan.container === "evb") {
    // Enigma Virtual Box: extract the embedded filesystem once (big images
    // take tens of seconds — 宝可梦赤途's 2.9GB exe unpacks in ~30s), then
    // hand the real directory to the standard RGSS path. The gameKey stays
    // derived from the ORIGINAL folder so bridge state survives re-unpacks.
    const unpacked = await ensureEvbUnpackedAsync(scan.evb.exePath, { onProgress });
    const handle = await launchRgssGame({ gameRoot: unpacked.dir, projectRoot, gameKey: scan.gameKey });
    return {
      game: scan.title,
      gameKey: scan.gameKey,
      root: scan.root,
      engine: scan.engine.id,
      protection: scan.protection,
      strategy: "evb-unpack-rgss-script",
      strategyReason: `EVB extraction to ${unpacked.dir} (${unpacked.extracted ? "fresh" : "reused"}) + shadow copy + Scripts archive entry`,
      pid: handle.child.pid,
      shadowApp: handle.prepared.shadowRoot,
      rgssSession: handle.session,
      server: null,
      port: null
    };
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
  if (scan.container === "tauri") {
    // Tauri (WebView2) shells need neither the ws server nor the extension:
    // the bridge is eval'd over CDP and its transport is outbox polling.
    return launchTauriGame({ scan, projectRoot });
  }
  if (scan.container === "nwjs-sealed") {
    return launchSealedGame({ scan, projectRoot, port });
  }
  if (scan.container === "nwjs-bundled") {
    return launchBundledGame({ scan, projectRoot, port });
  }
  if (!scan.paths.exe) throw new Error("Game.exe not found in game root");

  const plan = planLaunch(scan, { strategy });
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
    // Explicit shadow keeps the native startup chain used by older releases.
    // The additional Grover kill-path guards freeze otherwise working games
    // (verified with 再刷一把); default automatic launches still use DLL attach.
    const shadowScan = strategy === "shadow" && scan.protection
      ? { ...scan, protection: { ...scan.protection, flags: scan.protection.flags.filter(flag => flag !== "grover-boot") } }
      : scan;
    processInfo = launchShadowGame({ projectRoot, scan: shadowScan, gameKey: scan.gameKey, port, token });
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
    await once(child, "spawn");
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
    strategyReason: chosen === "shadow" ? "bg-script startup chain: shadow dir + patched bg-script" : (plan.selectedReason || plan.error),
    pid: processInfo.pid,
    shadowApp: processInfo.appDir || null,
    profileDir: processInfo.profileDir || null,
    server,
    port,
    extensionDir
  };
}

// Sealed-launcher MZ games (停不下来的轮回 family): the engine lives in one
// obfuscated IIFE executed by a bundled launcher page, so the extension bridge
// boots but its resolvers start empty. Two additions to the standard extension
// launch fix that:
//   1. --remote-debugging-port on the game process, so the seeder process can
//      heap-scan via CDP and publish the engine objects onto window
//      (core/sealed-seed.mjs) once the game enters a session.
//   2. RMCH_SEALED=1, which tells the bridge to keep retrying hooks on a slow
//      cadence instead of giving up after 60s (the globals appear late).
// Everything else — ws server, per-game profile, extension injection — is the
// proven standard path. The seeder logs to runtime/bridge-state/<gameKey>/seed.log.
// Spawn the detached seeder process for a sealed-launcher game. The seeder is
// a plain Node script, so the executable matters: inside the NW.js GUI
// process.execPath is the GUI shell (RMToolbox.exe), which cannot run a .mjs —
// spawning it silently did nothing and every GUI launch of a sealed game
// stayed unseeded (empty data tabs, "DataManager is unavailable"). Prefer
// execPath when it actually is Node (the CLI path), fall back to "node" from
// PATH, and if even that fails run the seeder loop in-process so seeding never
// depends on a standalone Node install.
export function startSealedSeeder({ projectRoot, gameKey, gameRoot, seedPort }) {
  const env = {
    ...process.env,
    RMCH_SEED_CDP_PORT: String(seedPort),
    RMCH_GAME_KEY: gameKey,
    RMCH_GAME_ROOT: gameRoot,
    RMCH_PROJECT_ROOT: projectRoot
  };
  const seederScript = path.join(projectRoot, "tools", "seed-sealed.mjs");
  const isNodeSelf = path.basename(process.execPath).toLowerCase().startsWith("node");
  const seeder = spawn(isNodeSelf ? process.execPath : "node", [seederScript], {
    detached: true,
    stdio: "ignore",
    env,
    windowsHide: true
  });
  seeder.on("error", () => {
    // No standalone Node available (GUI install without a dev toolchain):
    // the poll loop is plain fs/net code, so run it in this process instead.
    const log = (message, extra) => appendSeedLog(projectRoot, gameKey, message, extra);
    runSeededSeeder({ cdpPort: seedPort, log }).catch(() => {});
  });
  seeder.unref();
}

// Bundled-engine games (命运II离线版 family): the whole RPG Maker runtime is one
// combined classic script inside a single wrapper closure — no $data*/$game*/
// manager name ever reaches window — and this family's old NW.js builds expose
// no CDP at all (measured on NW.js 0.29: --remote-debugging-port ignored on
// the command line AND in chromium-args — the devtools HTTP server is not in
// this binary), so neither plain extension resolvers nor the sealed heap scan
// can reach anything. The way in: a shadow copy where the engine script gets
// a publish snippet appended INSIDE the wrapper closure (static publishes for
// managers/classes, live getters for $data*/$game*), after which the standard
// extension bridge sees a completely normal MV/MZ game. No seeder, no CDP.
async function launchBundledGame({ scan, projectRoot, port }) {
  if (!scan.paths.exe) {
    throw new Error(`game exe not found in ${scan.root} (looked for Game.exe, <manifest name>.exe, or a single root exe)`);
  }
  const token = getToken(projectRoot);
  buildBridge(projectRoot);
  const extensionDir = path.join(projectRoot, "runtime", "bridge");
  if (!existsSync(path.join(extensionDir, "manifest.json"))) throw new Error(`bridge extension missing: ${extensionDir}`);

  const server = await ensureServer({ projectRoot, port, token });

  const profileDir = path.join(projectRoot, "runtime", "profiles", scan.gameKey);
  mkdirSync(profileDir, { recursive: true });
  const info = launchBundledShadowGame({
    projectRoot,
    scan,
    gameKey: scan.gameKey,
    profileDir,
    extraEnv: {
      RMCH_GAME_ROOT: scan.root,
      RMCH_PROJECT_ROOT: projectRoot,
      RMCH_GAME_KEY: scan.gameKey,
      RMCH_WS_PORT: String(port),
      RMCH_WS_TOKEN: token
    }
  });

  return {
    game: scan.title,
    gameKey: scan.gameKey,
    root: scan.root,
    engine: scan.engine.id,
    protection: scan.protection,
    strategy: "shadow-engine-publish",
    strategyReason: planLaunch(scan).selectedReason,
    pid: info.pid,
    shadowApp: info.appDir,
    profileDir,
    server,
    port,
    extensionDir
  };
}

async function launchSealedGame({ scan, projectRoot, port }) {
  if (!scan.paths.exe) {
    throw new Error(`game exe not found in ${scan.root} (looked for Game.exe, <manifest name>.exe, or a single root exe)`);
  }
  const token = getToken(projectRoot);
  buildBridge(projectRoot);
  const extensionDir = path.join(projectRoot, "runtime", "bridge");
  if (!existsSync(path.join(extensionDir, "manifest.json"))) throw new Error(`bridge extension missing: ${extensionDir}`);

  const server = await ensureServer({ projectRoot, port, token });
  const seedPort = await pickFreePort();

  const profileDir = path.join(projectRoot, "runtime", "profiles", scan.gameKey);
  mkdirSync(profileDir, { recursive: true });
  const child = spawn(scan.paths.exe, [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extensionDir}`,
    `--remote-debugging-port=${seedPort}`
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
      RMCH_WS_TOKEN: token,
      RMCH_SEALED: "1",
      RMCH_SEED_CDP_PORT: String(seedPort)
    },
    // See the extension-path note above: windowsHide lands as SW_HIDE in old
    // NW.js builds and leaves the game window invisible.
    windowsHide: false
  });
  await once(child, "spawn");
  child.unref();

  const family = scan.container === "nwjs-bundled" ? "bundled" : "sealed";
  startSealedSeeder({ projectRoot, gameKey: scan.gameKey, gameRoot: scan.root, seedPort, family });

  return {
    game: scan.title,
    gameKey: scan.gameKey,
    root: scan.root,
    engine: scan.engine.id,
    protection: scan.protection,
    strategy: "extension-cdp-seed",
    strategyReason: planLaunch(scan).selectedReason,
    pid: child.pid,
    profileDir,
    seedPort,
    server,
    port,
    extensionDir
  };
}
