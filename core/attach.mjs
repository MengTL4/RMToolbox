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

import { execFile, execFileSync, spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { scanGame } from "./scanner.mjs";
import { detectRgss, renderBridgeSource } from "./rgss.mjs";
import { buildBridge } from "./bridge-bundler.mjs";
import { ensureServer, launchGame } from "./launcher.mjs";
import { getToken } from "./token.mjs";
import { adoptRgssSession } from "./rgss-launcher.mjs";

export class AttachError extends Error {}

// Launch/attach-side diary, appended to the same bridge.log the GUI's log
// page shows. The bridge itself only starts logging once it is alive in the
// page — everything before that (spawn, process appearance, every injection
// attempt's verdict) would otherwise be invisible when a launch goes wrong.
function launchLog(projectRoot, gameKey, message, extra) {
  try {
    const dir = path.join(projectRoot, "runtime", "bridge-state", gameKey);
    mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] [launch] ${message}${extra ? " " + JSON.stringify(extra) : ""}\n`;
    appendFileSync(path.join(dir, "bridge.log"), line, "utf8");
  } catch (_) {}
}

const INJECT_RESULT_TIMEOUT_MS = 30000;
// See launchNwInjectGame: how long after the renderer appears before the
// first injection, so the shell's boot-time integrity checks are over.
const LAUNCH_ATTACH_DELAY_MS = 30000;
const RGSS_EVAL_TIMEOUT_MS = 75000;

// --- process discovery -------------------------------------------------------

function runPowerShellJson(script) {
  return new Promise((resolve, reject) => {
    // A powershell child can hang for good (WMI service stall, an AV engine
    // holding the process in scan) — without this timeout a single wedged
    // query silently freezes the whole launch poll loop.
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 15000, killSignal: "SIGKILL" },
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
  // Unicode letters/digits so Chinese-named exes (停不下来的轮回.exe…) pass;
  // everything here goes into a WQL string filter, and this class still
  // refuses every character that could break out of it (quotes, semicolons…).
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_. -]*$/u.test(exeName)) {
    throw new AttachError(`refusing exe name: ${exeName}`);
  }
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

// --- elevation interop ---------------------------------------------------------

// A game exe flagged 以管理员身份运行 (HKCU AppCompatFlags Layers, RUNASADMIN)
// boots ELEVATED. From the non-elevated toolbox its processes are unreadable:
// ExecutablePath/CommandLine come back empty, processesUnderRoot drops them and
// every poll spins into a timeout while the game sits there plainly running.
// The per-user flag needs no admin to clear, so do it and log. Returns true
// when a flag was removed.
function clearRunAsAdminFlag(exePath, log) {
  const key = "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers";
  try {
    const out = execFileSync("reg.exe", ["query", key, "/v", exePath], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
    });
    if (!/RUNASADMIN/i.test(String(out))) return false;
    execFileSync("reg.exe", ["delete", key, "/v", exePath, "/f"], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
    });
    if (log) log("cleared RUNASADMIN compat flag on game exe", { exe: exePath });
    return true;
  } catch (_) {
    return false; // value absent (reg query exits 1) or reg.exe unavailable
  }
}

// Processes exist under this exe name but NONE are readable under the game
// root — the signature of an elevated (RUNASADMIN) running instance. Build the
// actionable error; clearing the flag only helps the NEXT spawn, the running
// one stays elevated until closed.
function elevatedInstanceError(exeName) {
  return new AttachError(
    `检测到正在运行的 ${exeName} 是以管理员身份启动的，工具箱（非管理员）看不到也注入不了它。\n` +
    "已自动清除该 exe 的「以管理员身份运行」兼容设置。请关闭游戏后重试 —— " +
    "游戏本身不需要管理员权限，请不要勾选该选项。"
  );
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
// Holding-tap prelude for the bootTap bootstrap variant: patches JSON.parse
// before ANY page script runs and piles database-shaped/save-shaped parse
// results into window.__rmchBootParsed (80 entries max — the db parses twice
// per boot on the NB shell family). The full bridge replays the pile through
// its real classifier on startup (08-capture.js replayBootCaptured). This is
// what beats the race that canvas-gated injection cannot: the shell decrypts
// Items.json & friends ~40-800ms into the context, before any canvas exists.
const BOOT_TAP_SNIPPET = [
  "  if (!window.__rmchBootTap) {",
  "    window.__rmchBootTap = true;",
  "    var __rmchOrigParse = JSON.parse;",
  "    JSON.parse = function (text) {",
  "      var r = __rmchOrigParse.apply(this, arguments);",
  "      try {",
  "        if (r && typeof r === 'object' && !window.__rmchBridge) {",
  "          var hold = false;",
  "          if (Array.isArray(r)) {",
  "            hold = r.length >= 2 && r.length < 200000 && r[0] == null;",
  "          } else {",
  "            hold = !!(r.system && typeof r.system === 'object' && (r.party || r.switches || r.variables) && (r.map || r.player))",
  "              || !!(Array.isArray(r.switches) && Array.isArray(r.variables));",
  "          }",
  "          if (hold) {",
  "            var list = window.__rmchBootParsed || (window.__rmchBootParsed = []);",
  "            if (list.length < 80) list.push(r);",
  "          }",
  "        }",
  "      } catch (_) {}",
  "      return r;",
  "    };",
  "    try { Object.defineProperty(JSON.parse, 'length', { value: 2 }); } catch (_) {}",
  "  }",
].join("\n");

export function buildNwBootstrap({ gameRoot, projectRoot, gameKey, port, token, extraEnv }) {
  const bridgePath = path.join(projectRoot, "runtime", "bridge", "page-bridge.js");
  const bridgeSource = readFileSync(bridgePath, "utf8");
  const envVars = {
    RMCH_GAME_ROOT: gameRoot,
    RMCH_PROJECT_ROOT: projectRoot,
    RMCH_GAME_KEY: gameKey,
    RMCH_WS_PORT: String(port),
    RMCH_WS_TOKEN: token,
    ...(extraEnv || {})
  };
  const errLog = path.join(projectRoot, "runtime", "bridge-state", gameKey, "attach-error.log");
  const bootTap = envVars.RMCH_BOOT_TAP === "1";
  // Dance copies (ensureSealedCatalog) must survive the reload they straddle:
  // an existing bridge makes them THROW — the DLL reads an empty Run result
  // as a non-terminal miss, releases the claim and retries every ~400ms, so
  // the copy stays armed until the reloaded context's first V8 call. A plain
  // "return" would be terminal (Run produced a value) and the DLL would
  // disable its hooks right there, ahead of the reload.
  const throwIfBridged = envVars.RMCH_THROW_IF_BRIDGED === "1";
  return [
    "(function(){",
    "try {",
    ...(bootTap ? [BOOT_TAP_SNIPPET] : []),
    throwIfBridged
      ? "  if (window.__rmchBridge) throw new Error('rmch-not-game-page'); // dance copy: stay armed for the next context"
      : "  if (window.__rmchBridge) return; // already attached/launched",
    "  var __rmchStart = function () {",
    "    Object.assign(process.env, " + JSON.stringify(envVars) + ");",
    "    (0, eval)(" + JSON.stringify(bridgeSource) + ");",
    "  };",
    "  var isGamePage = !!(document && document.querySelector &&",
    "    (document.querySelector('canvas') || window.SceneManager || window.PluginManager || window.Utils));",
    ...(bootTap ? [
      // Sealed-shell boot race: the db decrypt+parse finishes BEFORE the canvas
      // exists, and the throw-and-rearm gate would land the bridge a context-
      // lifetime too late. Stay resident instead: the pre-tap above is already
      // holding the parses; start the full bridge the moment the canvas shows.
      // A wrong (background) context just times its poll out — the attach layer
      // keeps re-injecting fresh DLLs until the game page says hello.
      "  if (isGamePage) { __rmchStart(); return 'started'; }",
      "  var __rmchGateTries = 0;",
      "  var __rmchGate = setInterval(function () {",
      "    __rmchGateTries += 1;",
      "    var ok = !!(document && document.querySelector &&",
      "      (document.querySelector('canvas') || window.SceneManager || window.PluginManager || window.Utils));",
      "    if (ok && !window.__rmchBridge) { clearInterval(__rmchGate); __rmchStart(); }",
      "    else if (__rmchGateTries >= 240) clearInterval(__rmchGate);",
      "  }, 250);",
      "  return 'armed';"
    ] : [
      // Throw (not return) on non-game contexts: the DLL treats an empty Run
      // result as "wrong context, re-arm and try the next one". NW.js renderers
      // host several contexts (extension background page, game page, ...), and
      // the first captured one is often the background page.
      "  if (!isGamePage) throw new Error('rmch-not-game-page');",
      "  __rmchStart();"
    ]),
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

// Reads the file channel directly for the bridge's hello — the same liveness
// signal the bridge server's FileSession adoption keys on (state.json
// rewritten every second + a {t:"hello"} line in events.jsonl). Returns the
// hello message, or null when no live bridge has announced itself.
function fileBridgeHello(stateDir) {
  try {
    const stat = statSync(path.join(stateDir, "state.json"));
    if (Date.now() - stat.mtimeMs > 5000) return null; // stale — writer is dead
  } catch (_) {
    return null;
  }
  let lines;
  try {
    lines = readFileSync(path.join(stateDir, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean);
  } catch (_) {
    return null;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const message = JSON.parse(lines[index]);
      if (message && message.t === "hello") return message;
    } catch (_) {}
  }
  return null;
}

// Holds the attach result until the bridge announces itself; the bridge
// server's 1.5s adoption scan then picks the channel up as a FileSession.
async function waitForFileBridgeHello(stateDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hello = fileBridgeHello(stateDir);
    if (hello) return hello;
    if (Date.now() > deadline) {
      throw new AttachError(`bridge did not announce itself on the file channel within ${Math.round(timeoutMs / 1000)}s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// attachNw on a plain-running game, with the bridge pinned to the JSONL file
// channel (RMCH_TRANSPORT=file) — the only transport an nb-evalnwbin shell
// survives. RMCH_SEALED keeps hook installation retrying forever because the
// engine classes only appear after the shell's login gate lets the game boot.
//
// `retries`/`retryDelayMs`: when called right after spawning the game (launch
// path), the renderer process exists LONG before its JS context is ready —
// the shell is still decrypting the engine blob, and an early eval finds no
// page context (or no canvas gate) and fails. A single attempt is therefore
// racy on slower machines; launch passes a retry loop, manual attach stays
// single-shot (the game has been sitting at its login screen for a while).
async function attachNwFile({ scan, projectRoot, port, retries = 1, retryDelayMs = 4000, bootTap = false }) {
  // Fail BEFORE touching anything (bridge build, token, state dir) when the
  // game is not even running.
  const exeName = path.basename(scan.paths.exe);
  const allByName = await listProcessesByExeName(exeName);
  const firstProcs = processesUnderRoot(allByName, scan.root);
  if (!firstProcs.length) {
    if (allByName.length && allByName.every((p) => !p.ExecutablePath)) {
      // Elevated (RUNASADMIN) running instance — unreadable from here.
      clearRunAsAdminFlag(scan.paths.exe, (m, e) => launchLog(projectRoot, scan.gameKey, m, e));
      launchLog(projectRoot, scan.gameKey, "attach aborted: running instance is elevated/unreadable");
      throw elevatedInstanceError(exeName);
    }
    throw new AttachError(`no running ${exeName} process found under ${scan.root}`);
  }

  const token = getToken(projectRoot);
  buildBridge(projectRoot);
  // The bridge never dials the WS port (the shell kills the page on any socket
  // construct), but the bridge SERVER is what adopts the file channel as a
  // FileSession — in the GUI the in-process server is already up, for CLI use
  // ensureServer spawns the standalone one.
  await ensureServer({ projectRoot, port, token });

  const firstMains = firstProcs.filter((p) => !/--type=/.test(p.CommandLine || ""));
  const mainPid = firstMains.length ? firstMains[0].ProcessId : null;
  const arch = readPeArch(scan.paths.exe);
  const bootstrap = buildNwBootstrap({
    gameRoot: scan.root, projectRoot, gameKey: scan.gameKey, port, token,
    extraEnv: {
      RMCH_TRANSPORT: "file", RMCH_SEALED: "1",
      ...(bootTap ? { RMCH_BOOT_TAP: "1" } : {})
    }
  });

  const stateDir = path.join(projectRoot, "runtime", "bridge-state", scan.gameKey);
  mkdirSync(stateDir, { recursive: true });
  launchLog(projectRoot, scan.gameKey, "attach begin", {
    procs: firstProcs.length, retries, bootTap
  });
  // Stale channel files from a dead bridge would fake a hello — wipe them
  // unless a live bridge (state.json rewritten within the last seconds) is
  // already there, in which case this attach only re-adopts its channel.
  if (!fileBridgeHello(stateDir)) {
    for (const file of ["commands.jsonl", "events.jsonl"]) {
      rmSync(path.join(stateDir, file), { force: true });
    }
  }

  const results = [];
  let injectedPid = null;
  for (let attempt = 1; attempt <= retries && !injectedPid; attempt += 1) {
    // A prior attempt's eval may have succeeded but its result pipe raced us;
    // the hello landing in events.jsonl is the ground truth.
    if (fileBridgeHello(stateDir)) break;
    const procs = attempt === 1
      ? firstProcs
      : processesUnderRoot(await listProcessesByExeName(exeName), scan.root);
    if (!procs.length) {
      throw new AttachError("game exited while waiting to attach");
    }
    const renderers = procs.filter((p) => /--type=renderer/.test(p.CommandLine || ""));
    const pageRenderers = renderers.filter((p) => !/--extension-process/.test(p.CommandLine || ""));
    const extRenderers = renderers.filter((p) => /--extension-process/.test(p.CommandLine || ""));
    const targets = [...pageRenderers, ...extRenderers];
    if (!targets.length) targets.push(...procs.filter((p) => !/--type=/.test(p.CommandLine || "")));
    for (const target of targets) {
      const result = await injectAndDeliver({
        projectRoot, arch, pid: target.ProcessId,
        dllName: "rmch-mvhook.dll", bootstrap, mode: "crt",
        // A hung eval (e.g. a context that dies mid-Run) must not eat the
        // whole retry window: attempts use a shorter fuse than a settled game.
        timeoutMs: retries > 1 ? 10000 : INJECT_RESULT_TIMEOUT_MS
      });
      results.push({ attempt, pid: target.ProcessId, ...result });
      launchLog(projectRoot, scan.gameKey, "inject attempt", {
        attempt, pid: target.ProcessId, ok: result.ok, detail: result.detail
      });
      if (result.ok) { injectedPid = target.ProcessId; break; }
    }
    if (!injectedPid && attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  if (!injectedPid && !fileBridgeHello(stateDir)) {
    launchLog(projectRoot, scan.gameKey, "attach failed", {
      attempts: results.length,
      results: results.map((r) => `pid ${r.pid}: ${r.detail}`)
    });
    throw new AttachError(
      "injection failed: " + results.map((r) => `pid ${r.pid}: ${r.detail}`).join("; ") +
      (retries > 1 ? ` (${retries} attempts — the game may still have been booting; 等登录界面出来后点「附加到运行中」)` : "")
    );
  }
  launchLog(projectRoot, scan.gameKey, "injection landed, waiting for bridge hello", { pid: injectedPid });
  await waitForFileBridgeHello(stateDir, retries > 1 ? 60000 : 30000);
  launchLog(projectRoot, scan.gameKey, "bridge hello received", { pid: injectedPid });
  return {
    game: scan.title,
    gameKey: scan.gameKey,
    root: scan.root,
    engine: scan.engine.id,
    strategy: "nw-inject-file",
    arch,
    pid: mainPid,
    injected: injectedPid ? [injectedPid] : [],
    results,
    port: null
  };
}

// Launch for nb-evalnwbin games: the shell refuses EVERY extra launch flag
// (measured: --user-data-dir alone dies at boot), so "launch" is a plain
// flag-free spawn followed by the DLL file-channel attach above, once a
// renderer process exists.
//
// The game must come up with no live "hostile" ancestor: measured on the NB
// family (V1.2.2_B / V3.7.3 / 宿敌), the shell walks the game's live
// ancestor chain during boot and force-exits it (~2s in) when it finds a
// blacklisted process name (RMToolbox.exe, node.exe, cmd.exe, WmiPrvSE,
// svchost…); a dead ancestor simply stops the walk and is fine. Direct
// spawns, persistent cmd parents, WMI, scheduled tasks, transient
// `explorer.exe <exe>` relays and one-hop ShellExecute relays (the powershell
// relay is still alive when the game checks) all die; only a real
// double-click (parent explorer.exe) runs.
//
// So we go two hops: we spawn powershell#1, which ShellExecutes powershell#2
// and exits immediately; #2 waits for #1's death, then ShellExecutes the
// game and lingers 30s. The boot-time walk sees game → live benign
// powershell#2 → dead #1 and passes (verified surviving 30s+ on 宿敌 with a
// blacklisted node.exe above the hops).
//
// Spawn-flag gotcha (measured): powershell spawned with BOTH windowsHide and
// `-WindowStyle Hidden` silently never runs its command; windowsHide alone
// (CREATE_NO_WINDOW) executes fine and shows no window.
export function shellExecuteSpawn(exe, cwd, log) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const enc = (s) => Buffer.from(s, "utf16le").toString("base64");
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
  );
  const stamp = path.join(os.tmpdir(), `rmch-hop-${process.pid}-${Date.now()}.pid`);
  // Hop2: wait for hop1's recorded pid to die (10s cap, then proceed anyway)
  // so its ancestry walk never reaches us; ShellExecute the game; linger 30s
  // as the benign live parent through the game's boot checks.
  const hop2 =
    `$hop=${q(stamp)};` +
    "try{$hp=[int](Get-Content $hop);" +
    "$n=0;while((Get-Process -Id $hp -ErrorAction SilentlyContinue) -and $n -lt 50)" +
    "{Start-Sleep -Milliseconds 200;$n++}}catch{};" +
    `$exe=${q(exe)};$dir=${q(cwd)};` +
    "(New-Object -ComObject Shell.Application).ShellExecute($exe,'',$dir,'open',1);" +
    "Remove-Item $hop -Force -ErrorAction SilentlyContinue;" +
    "Start-Sleep -Seconds 30";
  const hop1 =
    "$PID | Out-File -Encoding ascii " + q(stamp) + ";" +
    `(New-Object -ComObject Shell.Application).ShellExecute(${q(powershell)},` +
    `${q("-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " + enc(hop2))},'','open',0)`;
  const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", enc(hop1)],
    { stdio: "ignore", windowsHide: true });
  if (log) child.on("error", (error) => log("hop spawn error", { error: String(error) }));
  child.unref();
  return stamp;
}

// The simple alternative to the hop chain: `cmd /c start` hands the game off
// and EXITS immediately, so at the shell's boot-time ancestry walk (~2s in)
// the game's parent is an already-dead cmd.exe and the walk stops there —
// exactly the rule the two-hop powershell chain exists to exploit, but with
// no COM, no base64 (hidden powershell + EncodedCommand is a classic AV/EDR
// heuristic trigger, which is the likely reason the hop chain is flaky when
// issued from the GUI). Empirically: game appears in ~3s and survives the
// boot checks. launchNwInjectGame tries this first and falls back to the hop
// chain when no process shows up.
export function cmdStartSpawn(exe, cwd, log) {
  // `start` treats its first quoted argument as a window TITLE — the leading
  // "" is mandatory, or the exe path becomes the title and nothing launches.
  const child = spawn("cmd.exe", ["/c", "start", "", "/d", cwd, exe],
    { stdio: "ignore", windowsHide: true });
  if (log) child.on("error", (error) => log("cmd start spawn error", { error: String(error) }));
  child.unref();
}

// Closure-sealed shells decrypt the database INSIDE their blob and hand the
// plaintext to JSON.parse — the bridge's capture tap (08-capture.js) sees the
// whole $data* load, but only when a tap is already in the page before the
// parse. Measured on the NB family: a fresh context parses the whole database
// within its first ~800ms of script execution (starting ~40ms in), before any
// canvas exists, and a location.reload() turnaround completes in ~1s — far
// faster than any inject loop (WMI + spawn + LoadLibrary ≈ 1-2s per attempt)
// can possibly chase. The race is therefore won by PRE-ARMING: a DLL injected
// before the reload whose bootstrap THROWS on the live bridge stays armed
// (empty Run result → claim released, retried every ~400ms, non-terminal)
// until the reloaded context's very first V8 call, where it installs the
// holding tap (window.__rmchBootParsed pile) at t≈0 and arms a canvas poll;
// the full bridge replays the pile on startup (replayBootCaptured).
//
// After a launch attach, give the boot capture a moment to flush its cache —
// the launch-time bootTap attach sometimes lands before the shell's decrypt
// finishes, so nothing below runs at all. Launch-flow only by contract: a
// reload discards unsaved progress, so this never runs against a game the
// user started themselves.
async function ensureSealedCatalog({ scan, projectRoot, port }) {
  const stateDir = path.join(projectRoot, "runtime", "bridge-state", scan.gameKey);
  const cachePath = path.join(stateDir, "catalog-cache.json");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitForCache = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (existsSync(cachePath)) return true;
      await sleep(500);
    }
    return existsSync(cachePath);
  };
  if (await waitForCache(10000)) return;

  const exeName = path.basename(scan.paths.exe);
  const arch = readPeArch(scan.paths.exe);
  const token = getToken(projectRoot);
  const bootstrap = buildNwBootstrap({
    gameRoot: scan.root, projectRoot, gameKey: scan.gameKey, port, token,
    extraEnv: {
      RMCH_TRANSPORT: "file", RMCH_SEALED: "1", RMCH_BOOT_TAP: "1",
      RMCH_THROW_IF_BRIDGED: "1"
    }
  });
  const listTargets = async () => {
    const procs = processesUnderRoot(await listProcessesByExeName(exeName), scan.root);
    const renderers = procs.filter((p) => /--type=renderer/.test(p.CommandLine || ""));
    const pageRenderers = renderers.filter((p) => !/--extension-process/.test(p.CommandLine || ""));
    const extRenderers = renderers.filter((p) => /--extension-process/.test(p.CommandLine || ""));
    const targets = [...pageRenderers, ...extRenderers];
    if (!targets.length) targets.push(...procs.filter((p) => !/--type=/.test(p.CommandLine || "")));
    return { procs, targets };
  };
  const helloSince = (sinceTs) => {
    const hello = fileBridgeHello(stateDir);
    return hello && Number(hello.ts || 0) >= sinceTs ? hello : null;
  };

  for (let round = 0; round < 2; round += 1) {
    // The reload must be executed by a live bridge — without one there is
    // nothing to order around. Attach first (also covers the race where the
    // launch-time attach's hello never landed).
    if (!fileBridgeHello(stateDir)) {
      const { procs, targets } = await listTargets();
      if (!procs.length) return;
      for (const target of targets) {
        await injectAndDeliver({
          projectRoot, arch, pid: target.ProcessId,
          dllName: "rmch-mvhook.dll", bootstrap, mode: "crt", timeoutMs: 25000
        });
        if (fileBridgeHello(stateDir)) break;
      }
      const helloDeadline = Date.now() + 30000;
      while (!fileBridgeHello(stateDir) && Date.now() < helloDeadline) await sleep(500);
      if (!fileBridgeHello(stateDir)) return; // no bridge at all — give up quietly
    }

    // Pre-arm one DLL per renderer BEFORE ordering the reload. The result
    // pipe name is per-pid, so a second inject into the same process while
    // one is pending just fails to bind — tracked via `settled` and retried,
    // which also covers a copy going terminal in a wrong context.
    const { procs: alive, targets } = await listTargets();
    if (!alive.length) return;
    const pids = targets.map((t) => t.ProcessId);
    if (!pids.length) return;
    const settled = new Map();
    const fire = (pid) => {
      settled.set(pid, false);
      injectAndDeliver({
        projectRoot, arch, pid, dllName: "rmch-mvhook.dll",
        bootstrap, mode: "crt", timeoutMs: 30000
      }).then(() => settled.set(pid, true), () => settled.set(pid, true));
    };
    pids.forEach(fire);
    // LoadLibrary + hook install + the first throw cycle take a few hundred
    // ms; the reload must not start before at least one copy is armed.
    await sleep(800);

    const sinceTs = Date.now();
    appendFileSync(path.join(stateDir, "commands.jsonl"), JSON.stringify({
      commandId: `bootcap-${sinceTs}`, ts: sinceTs,
      type: "system.rebootCapture", args: {}
    }) + "\n", "utf8");

    const roundDeadline = Date.now() + 45000;
    let newHello = null;
    for (let tick = 0; Date.now() < roundDeadline && !newHello; tick += 1) {
      await sleep(400);
      newHello = helloSince(sinceTs);
      if (newHello) break;
      for (const pid of pids) {
        if (settled.get(pid)) fire(pid); // that copy resolved without a hello — arm the next
      }
      if (tick % 8 === 7) {
        const { procs } = await listTargets();
        if (!procs.length) return; // the reload killed the game — nothing to catch
      }
    }
    if (!newHello) continue; // the reload never produced a new bridge — retry once
    if (await waitForCache(20000)) return;
    // The new bridge came up but still caught nothing — one more round while
    // there is a live bridge to order around.
  }
}

export async function launchNwInjectGame({ scan, projectRoot, port = 47412 }) {
  if (!scan.paths.exe) throw new AttachError("game exe not found in game root");
  const exeName = path.basename(scan.paths.exe);
  const allByName = await listProcessesByExeName(exeName);
  const running = processesUnderRoot(allByName, scan.root);
  if (!running.length && allByName.length && allByName.every((p) => !p.ExecutablePath)) {
    // Every instance is unreadable → the running game is elevated
    // (RUNASADMIN). Clear the flag for next time and fail loudly; silently
    // polling past it is how this used to look like "一直转圈".
    clearRunAsAdminFlag(scan.paths.exe, (m, e) => launchLog(projectRoot, scan.gameKey, m, e));
    launchLog(projectRoot, scan.gameKey, "launch aborted: running instance is elevated/unreadable");
    throw elevatedInstanceError(exeName);
  }
  if (running.length) {
    // The shell boots fine plain, but a second instance's fate is the shell's
    // own business — attach to what is already there instead.
    launchLog(projectRoot, scan.gameKey, "launch skipped, already running — attaching");
    return attachNwFile({ scan, projectRoot, port });
  }
  const t0 = Date.now();
  const elapsed = () => Math.round((Date.now() - t0) / 100) / 10;
  const log = (m, e) => launchLog(projectRoot, scan.gameKey, m, e);
  launchLog(projectRoot, scan.gameKey, "launch begin", { exe: scan.paths.exe });

  // A RUNASADMIN compat flag would make the spawned game elevated (plus a UAC
  // prompt nobody expects) — strip it before spawning. Cheap no-op when unset.
  clearRunAsAdminFlag(scan.paths.exe, log);

  // The spawn returns before the shell has started the exe, so the game
  // process shows up a beat later. Primary mechanism: transient `cmd /c
  // start` (dead-parent trick — see cmdStartSpawn). Fallback: the two-hop
  // powershell ShellExecute chain, kept for machines where cmd start is
  // blocked. Both are logged; a total absence of process within the combined
  // window means something external (AV) is eating the launches.
  const procsNow = () => listProcessesByExeName(exeName)
    .then((list) => processesUnderRoot(list, scan.root));
  // Per-poll error tolerance + transient sightings: a process that is born
  // and dies between two polls is the single most important diagnostic for
  // "AV ate the launch" vs "spawn never happened", so log every pid we ever
  // see, even once. Sightings are logged from the RAW (unfiltered) list with
  // path readability, because a process whose ExecutablePath comes back empty
  // (elevated instance, protected process) is invisible to the root filter —
  // that distinction decides "not spawned" vs "spawned but unreadable".
  const sightings = new Set();
  const waitForProcess = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      let raw;
      try {
        raw = await listProcessesByExeName(exeName);
      } catch (error) {
        log("process poll error", { error: String(error && error.message || error) });
        continue;
      }
      for (const p of raw) {
        if (!sightings.has(p.ProcessId)) {
          sightings.add(p.ProcessId);
          log("process sighted", {
            pid: p.ProcessId, ppid: p.ParentProcessId, t: elapsed(),
            path: p.ExecutablePath ? "readable" : "UNREADABLE",
            cmd: p.CommandLine ? "yes" : "no"
          });
        }
      }
      const procs = processesUnderRoot(raw, scan.root);
      if (procs.length) return procs;
    }
    return [];
  };

  cmdStartSpawn(scan.paths.exe, scan.root, log);
  log("spawn issued (cmd /c start)");
  let appeared = await waitForProcess(25000);
  if (!appeared.length) {
    log("cmd start produced no process within 25s — falling back to ShellExecute hop chain");
    shellExecuteSpawn(scan.paths.exe, scan.root, log);
    log("spawn issued (ShellExecute hop chain)");
    appeared = await waitForProcess(35000);
  }
  if (!appeared.length) {
    log("launch failed: no process within 60s (both spawn mechanisms)");
    throw new AttachError(
      "game process did not appear within 60s of launch — " +
      "两种方式都没拉起游戏，可能被杀软拦截；请手动双击启动游戏后用「附加到运行中」"
    );
  }
  launchLog(projectRoot, scan.gameKey, "game process appeared", { t: elapsed() });
  const deadline = Date.now() + 90000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const procs = processesUnderRoot(await listProcessesByExeName(exeName), scan.root);
    if (procs.some((p) => /--type=renderer/.test(p.CommandLine || ""))) break;
    if (!procs.length) {
      launchLog(projectRoot, scan.gameKey, "launch failed: game exited during boot", { t: elapsed() });
      throw new AttachError("game exited during boot (plain launch, no toolbox flags)");
    }
    if (Date.now() > deadline) {
      launchLog(projectRoot, scan.gameKey, "launch failed: no renderer within 90s", { t: elapsed() });
      throw new AttachError("no renderer process appeared within 90s of launch");
    }
  }
  launchLog(projectRoot, scan.gameKey, "renderer appeared", { t: elapsed() });

  // DO NOT inject right away. Measured on the NB shell family: an injection
  // landing while the shell is still booting (decrypt + integrity self-check,
  // the first seconds of the renderer) makes the shell silently suspend the
  // boot at the splash screen — even a bootstrap that evals NOTHING but a
  // marker trips it. Injecting once the boot has fully settled (game idling
  // at splash/title or already in play) is always safe. There is no external
  // signal for "settled", so wait a fixed window — 30s is ~10x the measured
  // decrypt phase on a warm machine — then run the normal attach.
  launchLog(projectRoot, scan.gameKey, "waiting for shell boot checks to settle", { delayMs: LAUNCH_ATTACH_DELAY_MS });
  await new Promise((resolve) => setTimeout(resolve, LAUNCH_ATTACH_DELAY_MS));
  const alive = processesUnderRoot(await listProcessesByExeName(exeName), scan.root);
  if (!alive.length) {
    launchLog(projectRoot, scan.gameKey, "launch failed: game exited during settle wait", { t: elapsed() });
    throw new AttachError("game exited during boot (before attach)");
  }
  // bootTap is pointless this late (the boot-time db parse is long done) and
  // its JSON.parse pre-swap is exactly the kind of residue the shell's checks
  // notice — plain file-channel attach only.
  const summary = await attachNwFile({ scan, projectRoot, port, retries: 8, retryDelayMs: 4000 });
  launchLog(projectRoot, scan.gameKey, "launch complete", { t: elapsed(), pid: summary.pid });
  // Best-effort: prime catalog-cache.json (the $data* tables the data page
  // lists) when this game has none yet. Never fails the launch — the game is
  // running and bridged either way.
  try {
    await ensureSealedCatalog({ scan, projectRoot, port });
  } catch (_) {}
  return { ...summary, strategy: "nw-launch-inject-file", launchedPid: summary.pid };
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

// --- sealed / bundled takeover ------------------------------------------------

// Sealed and bundled-engine games cannot be hooked post-launch: the sealed
// engine never reaches window, and a bundled engine's managers stay
// closure-sealed — sealed needs a CDP heap scan whose port only a toolbox
// launch adds, bundled needs the engine-script publish patch only the shadow
// copy carries. So "attach" means TAKEOVER: stop the running (manually
// started) instance, then go through the normal launch path for the family.
// Only processes running from THIS game directory are stopped.
async function attachSealed({ scan, projectRoot, port }) {
  const bundled = scan.container === "nwjs-bundled";
  const exeName = path.basename(scan.paths.exe);
  let stopped = 0;
  const processes = await listProcessesByExeName(exeName); // throws = no takeover, fail loudly
  for (const target of processesUnderRoot(processes, scan.root)) {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(target.ProcessId), "/T", "/F"], { stdio: "ignore" });
      killer.on("close", resolve);
      killer.on("error", resolve);
    });
    stopped += 1;
  }
  if (stopped) {
    // Let the dying process release file handles before the relaunch re-opens
    // the same profile/save files.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  const summary = await launchGame({ gameRoot: scan.root, projectRoot, port });
  return {
    ...summary,
    strategy: bundled ? "bundled-relaunch" : "sealed-relaunch",
    strategyReason: stopped
      ? bundled
        ? `bundled engine keeps its managers closure-sealed and cannot be hooked post-launch: stopped ${stopped} game process(es) and relaunched via the toolbox (shadow copy + engine publish)`
        : `sealed engine cannot be hooked post-launch: stopped ${stopped} game process(es) and relaunched via the toolbox (debug port + engine publish; the game auto-resumes its last save)`
      : bundled
        ? "no running game process found; launched via the toolbox (shadow copy + engine publish)"
        : "no running game process found; launched via the toolbox (debug port + engine publish)"
  };
}

// --- entry -------------------------------------------------------------------------

export async function attachGame({ gameRoot, projectRoot, port = 47412 }) {
  const scan = scanGame(gameRoot);
  if (scan.container === "nb-shell") {
    // Measured (ACCEPTANCE v0.6.3): the shell detects the injected DLL within
    // seconds of the LoadLibrary event and force-exits the game — attaching
    // would crash the user's live session for zero benefit.
    throw new AttachError(
      "nb-shell protected game (nbtool.node): the shell detects injected code and force-exits the game — " +
      "attaching would crash the running game; this shell has no toolbox injection vector"
    );
  }
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
  if (scan.container === "nwjs-sealed" || scan.container === "nwjs-bundled") {
    return attachSealed({ scan, projectRoot, port });
  }
  if (scan.container === "nb-evalnwbin") {
    // The bridge must not open its WebSocket (the shell kills the app on any
    // in-page socket construct) — attach with the JSONL file channel instead.
    return attachNwFile({ scan, projectRoot, port });
  }
  if (/^RGSS/i.test(scan.engine.id)) {
    return attachRgss({ scan, projectRoot });
  }
  return attachNw({ scan, projectRoot, port });
}
