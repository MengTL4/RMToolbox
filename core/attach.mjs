// Attach the RMCH bridge to an ALREADY-RUNNING RPG Maker game process,
// MTool-style: a tiny native hook DLL is injected into the game, evals the
// existing bridge bootstrap inside the game, and from there on everything
// reuses the normal transports (WebSocket for MV/MZ, JSONL files for RGSS).
//
//   MV/MZ (NW.js): rmch-mvhook.dll is CreateRemoteThread-injected into ONE
//     renderer child process at a time (plain renderers first, extension
//     renderers last — games packaged as a chrome-extension page only have
//     the latter), stopping at the first success. The DLL resolves the v8
//     C++ symbols exported by nw.dll, Script::Compile+Run's a bootstrap that
//     sets the RMCH_* env vars and evals runtime/bridge/page-bridge.js —
//     exactly what the launch-time extension does — then UNLOADS ITSELF, so
//     games with periodic module-integrity scans find no foreign residue.
//     The bridge dials in over WS as usual.
//   RGSS (XP/VX/VXAce): rmch-rgsshook.dll is loaded via SetWindowsHookEx on
//     the game's main thread and rb_eval_string_protect's a rendered
//     runtime/rgss-bridge/bridge.rb — after which the file channel runs from
//     runtime/rgss-attach/<gameKey>/ (kept out of the game directory).
//
// Native binaries live in runtime/inject/bin/<arch>/ (see tools/build-inject.mjs).

import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { scanGame } from "./scanner.mjs";
import { detectRgss, renderBridgeSource } from "./rgss.mjs";
import { buildBridge } from "./bridge-bundler.mjs";
import { ensureServer } from "./launcher.mjs";
import { getToken } from "./token.mjs";
import { adoptRgssSession } from "./rgss-launcher.mjs";

export class AttachError extends Error {}

const INJECT_RESULT_TIMEOUT_MS = 30000;
const RGSS_EVAL_TIMEOUT_MS = 75000;

// --- process discovery -------------------------------------------------------

function runPowerShellJson(script) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) return reject(new AttachError(`process query failed: ${error.message}`));
        const text = String(stdout || "").trim();
        if (!text) return resolve([]);
        try {
          const parsed = JSON.parse(text);
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (parseError) {
          reject(new AttachError(`process query parse failed: ${parseError.message}`));
        }
      }
    );
  });
}

// All processes whose executable is `exeName`. Returns [{ProcessId,
// ParentProcessId, ExecutablePath, CommandLine}].
export async function listProcessesByExeName(exeName) {
  if (!/^[\w. -]+$/.test(exeName)) throw new AttachError(`refusing exe name: ${exeName}`);
  return runPowerShellJson(
    `Get-CimInstance Win32_Process -Filter "Name='${exeName}'" ` +
      `| Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine ` +
      `| ConvertTo-Json -Compress`
  );
}

function normPath(p) {
  return String(p || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function processesUnderRoot(processes, gameRoot) {
  const rootPrefix = normPath(gameRoot) + "\\";
  return processes.filter((p) => {
    const exe = normPath(p.ExecutablePath);
    return exe && (exe + "\\").startsWith(rootPrefix);
  });
}

// --- PE bitness ---------------------------------------------------------------

// Returns "win32" | "x64" for a PE file's machine type.
export function readPeArch(exePath) {
  const fd = openSync(exePath, "r");
  try {
    const head = Buffer.alloc(64);
    if (readSync(fd, head, 0, 64, 0) < 64 || head.toString("latin1", 0, 2) !== "MZ") {
      throw new AttachError(`not a PE file: ${exePath}`);
    }
    const peOffset = head.readUInt32LE(0x3c);
    const sig = Buffer.alloc(6);
    if (readSync(fd, sig, 0, 6, peOffset) < 6 || sig.toString("latin1", 0, 4) !== "PE\0\0") {
      throw new AttachError(`PE signature missing: ${exePath}`);
    }
    const machine = sig.readUInt16LE(4);
    if (machine === 0x14c) return "win32";
    if (machine === 0x8664) return "x64";
    throw new AttachError(`unknown PE machine 0x${machine.toString(16)}: ${exePath}`);
  } finally {
    closeSync(fd);
  }
}

// --- pipe framing (mirrors runtime/inject/src/common.h) -----------------------
// Exported for tools/test-attach.mjs; not part of the attach API surface.

export function frameReader(sock, onMsg) {
  let buf = Buffer.alloc(0);
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      const payload = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      try {
        onMsg(JSON.parse(payload.toString("utf8")));
      } catch (_) {}
    }
  });
}

export function writeFrame(sock, text) {
  const payload = Buffer.from(text, "utf8");
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32LE(payload.length, 0);
  sock.write(Buffer.concat([hdr, payload]));
}

// --- injector orchestration ----------------------------------------------------

function injectBinDir(projectRoot, arch) {
  return path.join(projectRoot, "runtime", "inject", "bin", arch);
}

// Runs rmch-inject.exe against one pid and delivers `bootstrap` over the pipe.
// mode: "crt" (CreateRemoteThread) or "wh" (SetWindowsHookEx; keeps stdin open
// until the DLL reports, then writes "done").
// Resolves { ok, detail, injectorExit } — never rejects for expected failures.
export function injectAndDeliver({ projectRoot, arch, pid, dllName, bootstrap, mode, timeoutMs }) {
  const binDir = injectBinDir(projectRoot, arch);
  const injector = path.join(binDir, "rmch-inject.exe");
  const dll = path.join(binDir, dllName);
  if (!existsSync(injector)) return Promise.resolve({ ok: false, detail: `injector missing: ${injector}` });
  if (!existsSync(dll)) return Promise.resolve({ ok: false, detail: `hook dll missing: ${dll}` });

  const pipeName = `\\\\.\\pipe\\rmch-attach-${pid}`;
  const server = net.createServer();

  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch (_) {}
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (child && mode === "wh") {
        try { child.stdin.write("done\n"); } catch (_) {}
      }
      if (child) { try { child.kill(); } catch (_) {} }
      finish({ ok: false, detail: "core-timeout" });
    }, timeoutMs);

    server.once("error", (error) => finish({ ok: false, detail: `pipe-server: ${error.message}` }));
    server.listen(pipeName, () => {
      child = spawn(injector, [`--${mode}`, "--pid", String(pid), "--dll", dll], {
        stdio: [mode === "wh" ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true
      });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("error", (error) => finish({ ok: false, detail: `injector spawn: ${error.message}` }));
      child.on("exit", (code) => {
        // The injector exiting early (nonzero) means injection itself failed.
        if (!settled && code !== 0) {
          finish({ ok: false, detail: `injector-exit-${code}: ${stderr.trim()}` });
        }
      });
    });
    server.on("connection", (sock) => {
      frameReader(sock, (msg) => {
        if (msg.t === "ready") {
          writeFrame(sock, bootstrap);
          return;
        }
        if (msg.t === "result") {
          if (child && mode === "wh") {
            try { child.stdin.write("done\n"); } catch (_) {}
          }
          finish({ ok: !!msg.ok, detail: msg.detail || "", dll: msg.dll, arch: msg.arch });
        }
      });
    });
  });
}

// --- MV/MZ bootstrap ------------------------------------------------------------

// The page-context bootstrap: set RMCH_* env first (05-node-io.js reads them at
// eval time), then indirect-eval the built bridge — the same trick the shadow
// launcher's bg-script suffix uses. A canvas/SceneManager gate keeps spare
// renderers and NW's extension background page from becoming useless sessions:
// non-game contexts THROW so the DLL re-arms and retries the next context.
// Any other throw is logged to runtime/bridge-state/<gameKey>/attach-error.log
// (the DLL cannot read JS exception text through the narrow v8 ABI we use).
export function buildNwBootstrap({ gameRoot, projectRoot, gameKey, port, token }) {
  const bridgePath = path.join(projectRoot, "runtime", "bridge", "page-bridge.js");
  const bridgeSource = readFileSync(bridgePath, "utf8");
  const envVars = {
    RMCH_GAME_ROOT: gameRoot,
    RMCH_PROJECT_ROOT: projectRoot,
    RMCH_GAME_KEY: gameKey,
    RMCH_WS_PORT: String(port),
    RMCH_WS_TOKEN: token
  };
  const errLog = path.join(projectRoot, "runtime", "bridge-state", gameKey, "attach-error.log");
  return [
    "(function(){",
    "try {",
    "  if (window.__rmchBridge) return; // already attached/launched",
    "  var isGamePage = !!(document && document.querySelector &&",
    "    (document.querySelector('canvas') || window.SceneManager || window.PluginManager || window.Utils));",
    // Throw (not return) on non-game contexts: the DLL treats an empty Run
    // result as "wrong context, re-arm and try the next one". NW.js renderers
    // host several contexts (extension background page, game page, ...), and
    // the first captured one is often the background page.
    "  if (!isGamePage) throw new Error('rmch-not-game-page');",
    "  Object.assign(process.env, " + JSON.stringify(envVars) + ");",
    "  (0, eval)(" + JSON.stringify(bridgeSource) + ");",
    "} catch (e) {",
    "  if (e && e.message === 'rmch-not-game-page') throw e;",
    "  try {",
    "    require('fs').writeFileSync(" + JSON.stringify(errLog) + ", String(e && e.stack || e));",
    "  } catch (_) {}",
    "}",
    "})();"
  ].join("\n");
}

// --- MV/MZ attach -----------------------------------------------------------------

async function attachNw({ scan, projectRoot, port }) {
  if (!scan.paths.exe) throw new AttachError("Game.exe not found in game root");
  const token = getToken(projectRoot);
  buildBridge(projectRoot);
  await ensureServer({ projectRoot, port, token });

  const exeName = path.basename(scan.paths.exe);
  const procs = processesUnderRoot(await listProcessesByExeName(exeName), scan.root);
  if (!procs.length) {
    throw new AttachError(`no running ${exeName} process found under ${scan.root}`);
  }
  const renderers = procs.filter((p) => /--type=renderer/.test(p.CommandLine || ""));
  const mains = procs.filter((p) => !/--type=/.test(p.CommandLine || ""));
  // Game pages usually live in a plain renderer; --extension-process renderers
  // host background pages — but games packaged AS a chrome-extension page
  // (再刷一把) only have the extension renderer, so it is tried last, not never.
  // Some NW setups run single-process; fall back to the main process then.
  const pageRenderers = renderers.filter((p) => !/--extension-process/.test(p.CommandLine || ""));
  const extRenderers = renderers.filter((p) => /--extension-process/.test(p.CommandLine || ""));
  const targets = [...pageRenderers, ...extRenderers];
  if (!targets.length) targets.push(...mains);

  const arch = readPeArch(scan.paths.exe);
  const bootstrap = buildNwBootstrap({
    gameRoot: scan.root, projectRoot, gameKey: scan.gameKey, port, token
  });

  const results = [];
  for (const target of targets) {
    const result = await injectAndDeliver({
      projectRoot, arch, pid: target.ProcessId,
      dllName: "rmch-mvhook.dll", bootstrap, mode: "crt",
      timeoutMs: INJECT_RESULT_TIMEOUT_MS
    });
    results.push({ pid: target.ProcessId, ...result });
    // One live bridge is enough — every extra injection is more foreign-module
    // exposure on games with integrity scans.
    if (result.ok) break;
  }
  const ok = results.filter((r) => r.ok);
  if (!ok.length) {
    throw new AttachError(
      "injection failed: " + results.map((r) => `pid ${r.pid}: ${r.detail}`).join("; ")
    );
  }
  return {
    game: scan.title,
    gameKey: scan.gameKey,
    root: scan.root,
    engine: scan.engine.id,
    strategy: "nw-inject",
    arch,
    pid: mains.length ? mains[0].ProcessId : null, // main process, for the stop button
    injected: ok.map((r) => r.pid),
    results,
    port
  };
}

// --- RGSS attach ------------------------------------------------------------------

async function attachRgss({ scan, projectRoot }) {
  const detect = detectRgss(scan.root);
  if (!detect) throw new AttachError(`RGSS detection failed (Game.ini Library): ${scan.root}`);
  const exePath = scan.paths.exe || detect.exe;
  if (!existsSync(exePath)) throw new AttachError(`game exe not found: ${exePath}`);

  const procs = processesUnderRoot(await listProcessesByExeName(path.basename(exePath)), scan.root);
  if (!procs.length) {
    throw new AttachError(`no running ${path.basename(exePath)} process found under ${scan.root}`);
  }
  const target = procs[0]; // RGSS games are single-process
  const arch = readPeArch(exePath);

  // The file channel lives under runtime/rgss-attach/<gameKey>/ so attaching
  // does not drop rmch-*.jsonl files into the real game directory.
  const channelDir = path.join(projectRoot, "runtime", "rgss-attach", scan.gameKey);
  mkdirSync(channelDir, { recursive: true });

  const bridgeSource = readFileSync(
    path.join(projectRoot, "runtime", "rgss-bridge", "bridge.rb"), "utf8");
  const rendered = renderBridgeSource(bridgeSource, {
    port: 0,
    token: "",
    gameKey: scan.gameKey,
    realDir: scan.root,
    engine: detect.engine,
    channelDir
  });
  // The eval runs through rb_eval_string_protect, which reports only a numeric
  // status — catch in Ruby and log the message ourselves.
  const errLog = path.join(channelDir, "attach-error.log");
  const bootstrap = [
    "begin",
    rendered,
    "rescue Exception => __rmch_e",
    "  begin",
    `    File.open(${JSON.stringify(errLog)}, "wb") { |f| f.write(__rmch_e.class.to_s + ": " + __rmch_e.message.to_s + "\\n" + (__rmch_e.backtrace || []).join("\\n")) }`,
    "  rescue Exception",
    "  end",
    "end"
  ].join("\n");

  const result = await injectAndDeliver({
    projectRoot, arch, pid: target.ProcessId,
    dllName: "rmch-rgsshook.dll", bootstrap, mode: "wh",
    timeoutMs: RGSS_EVAL_TIMEOUT_MS
  });
  if (!result.ok) {
    throw new AttachError(`injection failed: pid ${target.ProcessId}: ${result.detail}`);
  }

  // The bridge truncates the channel files and says hello on its first frame.
  const session = await adoptRgssSession({
    dir: channelDir, gameKey: scan.gameKey, pid: target.ProcessId
  });
  return {
    game: scan.title,
    gameKey: scan.gameKey,
    root: scan.root,
    engine: detect.engine,
    strategy: "rgss-inject",
    arch,
    pid: target.ProcessId,
    channelDir,
    session
  };
}

// --- entry -------------------------------------------------------------------------

export async function attachGame({ gameRoot, projectRoot, port = 47412 }) {
  const scan = scanGame(gameRoot);
  if (scan.engine.id === "RM2K") {
    throw new AttachError('engine "RM2K" is not supported by attach');
  }
  if (scan.container === "tauri") {
    // WebView2 takes no external debug flags once running (the app overrides
    // WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS), so there is nothing to hook
    // into post-launch — the patched exe copy IS the injection vehicle.
    throw new AttachError(
      'Tauri-shelled games cannot be attached post-launch; use "launch" instead (a patched exe copy opens the debug port)'
    );
  }
  if (/^RGSS/i.test(scan.engine.id)) {
    return attachRgss({ scan, projectRoot });
  }
  return attachNw({ scan, projectRoot, port });
}
