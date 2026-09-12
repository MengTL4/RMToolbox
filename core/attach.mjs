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
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { scanGame } from "./scanner.mjs";
import { detectRgss, renderBridgeSource } from "./rgss.mjs";
import { buildBridge } from "./bridge-bundler.mjs";
import { ensureServer, launchGame, payloadPaths } from "./launcher.mjs";
import { getToken } from "./token.mjs";
import { adoptRgssSession } from "./rgss-launcher.mjs";
import { buildSelfSeedBootstrap } from "./sealed-seed.mjs";

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
const RGSS_EVAL_TIMEOUT_MS = 75000;

// --- process discovery -------------------------------------------------------

function runPowerShellJson(script, executable = "powershell.exe") {
  return new Promise((resolve, reject) => {
    // A powershell child can hang for good (WMI service stall, an AV engine
    // holding the process in scan) — without this timeout a single wedged
    // query silently freezes the whole launch poll loop.
    execFile(
      executable,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        timeout: 15000,
        killSignal: "SIGKILL"
      },
      (error, stdout) => {
        if (error)
          return reject(
            new AttachError(`process query failed: ${error.message}`)
          );
        const text = String(stdout || "").trim();
        if (!text) return resolve([]);
        try {
          const parsed = JSON.parse(text);
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (parseError) {
          reject(
            new AttachError(`process query parse failed: ${parseError.message}`)
          );
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
  return String(p || "")
    .replace(/\//g, "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
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
  const key =
    "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers";
  try {
    const out = execFileSync("reg.exe", ["query", key, "/v", exePath], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (!/RUNASADMIN/i.test(String(out))) return false;
    execFileSync("reg.exe", ["delete", key, "/v", exePath, "/f"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (log)
      log("cleared RUNASADMIN compat flag on game exe", { exe: exePath });
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
    if (
      readSync(fd, head, 0, 64, 0) < 64 ||
      head.toString("latin1", 0, 2) !== "MZ"
    ) {
      throw new AttachError(`not a PE file: ${exePath}`);
    }
    const peOffset = head.readUInt32LE(0x3c);
    const sig = Buffer.alloc(6);
    if (
      readSync(fd, sig, 0, 6, peOffset) < 6 ||
      sig.toString("latin1", 0, 4) !== "PE\0\0"
    ) {
      throw new AttachError(`PE signature missing: ${exePath}`);
    }
    const machine = sig.readUInt16LE(4);
    if (machine === 0x14c) return "win32";
    if (machine === 0x8664) return "x64";
    throw new AttachError(
      `unknown PE machine 0x${machine.toString(16)}: ${exePath}`
    );
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
export function injectAndDeliver({
  projectRoot,
  arch,
  pid,
  dllName,
  bootstrap,
  mode,
  timeoutMs
}) {
  const binDir = injectBinDir(projectRoot, arch);
  const injector = path.join(binDir, "rmch-inject.exe");
  const dll = path.join(binDir, dllName);
  if (!existsSync(injector))
    return Promise.resolve({
      ok: false,
      detail: `injector missing: ${injector}`
    });
  if (!existsSync(dll))
    return Promise.resolve({ ok: false, detail: `hook dll missing: ${dll}` });

  const pipeName = `\\\\.\\pipe\\rmch-attach-${pid}`;
  const server = net.createServer();

  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        server.close();
      } catch (_) {}
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (child && mode === "wh") {
        try {
          child.stdin.write("done\n");
        } catch (_) {}
      }
      if (child) {
        try {
          child.kill();
        } catch (_) {}
      }
      finish({ ok: false, detail: "core-timeout" });
    }, timeoutMs);

    server.once("error", (error) =>
      finish({ ok: false, detail: `pipe-server: ${error.message}` })
    );
    server.listen(pipeName, () => {
      child = spawn(
        injector,
        [`--${mode}`, "--pid", String(pid), "--dll", dll],
        {
          stdio: [mode === "wh" ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true
        }
      );
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", (error) =>
        finish({ ok: false, detail: `injector spawn: ${error.message}` })
      );
      child.on("exit", (code) => {
        // The injector exiting early (nonzero) means injection itself failed.
        if (!settled && code !== 0) {
          finish({
            ok: false,
            detail: `injector-exit-${code}: ${stderr.trim()}`
          });
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
            try {
              child.stdin.write("done\n");
            } catch (_) {}
          }
          finish({
            ok: !!msg.ok,
            detail: msg.detail || "",
            dll: msg.dll,
            arch: msg.arch
          });
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
export function buildNwBootstrap({
  gameRoot,
  projectRoot,
  gameKey,
  port,
  token,
  extraEnv
}) {
  const bridgePath = path.join(
    projectRoot,
    "runtime",
    "bridge",
    "page-bridge.js"
  );
  const bridgeSource = readFileSync(bridgePath, "utf8");
  const envVars = {
    RMCH_GAME_ROOT: gameRoot,
    RMCH_PROJECT_ROOT: projectRoot,
    RMCH_GAME_KEY: gameKey,
    RMCH_WS_PORT: String(port),
    RMCH_WS_TOKEN: token,
    ...(extraEnv || {})
  };
  const errLog = path.join(
    projectRoot,
    "runtime",
    "bridge-state",
    gameKey,
    "attach-error.log"
  );
  return [
    "(function(){",
    "try {",
    "  if (window.__rmchBridge) return; // already attached",
    "  var __rmchStart = function () {",
    "    Object.assign(process.env, " + JSON.stringify(envVars) + ");",
    "    (0, eval)(" + JSON.stringify(bridgeSource) + ");",
    ...(envVars.RMCH_SELF_SEED === "1"
      ? ["    " + buildSelfSeedBootstrap() + ";"]
      : []),
    "  };",
    "  var isGamePage = !!(document && document.querySelector &&",
    "    (document.querySelector('canvas') || window.SceneManager || window.PluginManager || window.Utils));",
    // Throw (not return) on non-game contexts: the DLL treats an empty Run
    // result as "wrong context, re-arm and try the next one". NW.js renderers
    // host several contexts (extension background page, game page, ...), and
    // the first captured one is often the background page.
    "  if (!isGamePage) throw new Error('rmch-not-game-page');",
    "  __rmchStart();",
    "} catch (e) {",
    "  if (e && e.message === 'rmch-not-game-page') throw e;",
    "  try {",
    "    require('fs').writeFileSync(" +
      JSON.stringify(errLog) +
      ", String(e && e.stack || e));",
    "  } catch (_) {}",
    "}",
    "})();"
  ].join("\n");
}

// --- MV/MZ attach -----------------------------------------------------------------

function nwProcessTargets(procs) {
  const renderers = procs.filter((p) =>
    /--type=renderer/.test(p.CommandLine || "")
  );
  const mains = procs.filter((p) => !/--type=/.test(p.CommandLine || ""));
  // Game pages usually live in a plain renderer; --extension-process renderers
  // host background pages — but games packaged AS a chrome-extension page
  // (再刷一把) only have the extension renderer, so it is tried last, not never.
  // Some NW setups run single-process; fall back to the main process then.
  const pageRenderers = renderers.filter(
    (p) => !/--extension-process/.test(p.CommandLine || "")
  );
  const extRenderers = renderers.filter((p) =>
    /--extension-process/.test(p.CommandLine || "")
  );
  const targets = [...pageRenderers, ...extRenderers];
  if (!targets.length) targets.push(...mains);
  return { mains, targets };
}

// The evalNWBin shell cannot survive an in-page socket, so its bridge rides the
// JSONL file channel. Enigma-NB tolerates WS but exposes its engine late, so it
// attaches with retries. Every other NW.js game is a plain single-shot WS
// attach.
function nwAttachmentPolicy(scan) {
  const sealedWs = scan.container === "enigma-nb";
  const file = scan.container === "nb-evalnwbin";
  const retries = sealedWs ? 5 : 1;
  return {
    file,
    sealed: file || sealedWs,
    retries,
    timeoutMs: INJECT_RESULT_TIMEOUT_MS
  };
}

// Reads the file channel directly for the bridge's hello — the same liveness
// signal the bridge server's FileSession adoption keys on (state.json
// rewritten every second + a {t:"hello"} line in events.jsonl). Returns the
// hello message, or null when no live bridge has announced itself.
function fileBridgeHello(stateDir, now) {
  try {
    const stat = statSync(path.join(stateDir, "state.json"));
    if (now - stat.mtimeMs > 5000) return null; // stale — writer is dead
  } catch (_) {
    return null;
  }
  let lines;
  try {
    lines = readFileSync(path.join(stateDir, "events.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
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
async function waitForFileBridgeHello(stateDir, timeoutMs, clock) {
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    const hello = fileBridgeHello(stateDir, clock.now());
    if (hello) return hello;
    if (clock.now() > deadline) {
      throw new AttachError(
        `bridge did not announce itself on the file channel within ${Math.round(timeoutMs / 1000)}s`
      );
    }
    await clock.sleep(250);
  }
}

// One orchestration owns preparation, target order, retries and confirmation.
// A file hello is ground truth even if an injection result raced the pipe;
// WS retains its existing success condition (the DLL reported successful eval).
async function attachNw({ scan, projectRoot, port = 47412 }, runtime) {
  const { platform, clock } = runtime;
  const policy = nwAttachmentPolicy(scan);
  const { file, retries } = policy;
  if (!scan.paths.exe) throw new AttachError("Game.exe not found in game root");
  // File attachment rejects a missing game before bridge build/token/state
  // writes. Sealed WS keeps retrying if its first process snapshot is empty.
  const exeName = path.basename(scan.paths.exe);
  let firstProcs = null;
  if (file) {
    const allByName = await platform.listProcessesByExeName(exeName);
    firstProcs = processesUnderRoot(allByName, scan.root);
    if (!firstProcs.length) {
      if (allByName.length && allByName.every((p) => !p.ExecutablePath)) {
        // Elevated (RUNASADMIN) running instance — unreadable from here.
        platform.clearRunAsAdminFlag(scan.paths.exe, (m, e) =>
          launchLog(projectRoot, scan.gameKey, m, e)
        );
        launchLog(
          projectRoot,
          scan.gameKey,
          "attach aborted: running instance is elevated/unreadable"
        );
        throw elevatedInstanceError(exeName);
      }
      throw new AttachError(
        `no running ${exeName} process found under ${scan.root} — ` +
          "请先自行双击启动游戏，进入游戏后再点「附加到运行中」"
      );
    }
  }

  const token = getToken(projectRoot);
  buildBridge(projectRoot);
  // Both transports need the server: it adopts file channels even when the
  // injected page must never construct a socket. Prepare it once per flow.
  await ensureServer({ projectRoot, port, token });

  const firstMains = nwProcessTargets(firstProcs || []).mains;
  const mainPid = firstMains.length ? firstMains[0].ProcessId : null;
  const arch = readPeArch(scan.paths.exe);
  const bootstrap = buildNwBootstrap({
    gameRoot: scan.root,
    projectRoot,
    gameKey: scan.gameKey,
    port,
    token,
    extraEnv: {
      ...(file ? { RMCH_TRANSPORT: "file" } : {}),
      ...(policy.sealed ? { RMCH_SEALED: "1" } : {}),
      ...(scan.container === "nb-evalnwbin" ? { RMCH_SELF_SEED: "1" } : {})
    }
  });

  const stateDir = path.join(
    projectRoot,
    "runtime",
    "bridge-state",
    scan.gameKey
  );
  const hello = () => (file ? fileBridgeHello(stateDir, clock.now()) : null);
  if (file) {
    mkdirSync(stateDir, { recursive: true });
    launchLog(projectRoot, scan.gameKey, "attach begin", {
      procs: firstProcs.length,
      retries
    });
    // Stale channel files from a dead bridge would fake a hello — wipe them
    // unless a live bridge is already there, in which case only re-adopt it.
    if (!hello()) {
      for (const name of ["commands.jsonl", "events.jsonl"]) {
        rmSync(path.join(stateDir, name), { force: true });
      }
    }
  }

  let results = [];
  let injectedPid = null;
  let resultMainPid = mainPid;
  let lastError = null;
  for (let attempt = 1; attempt <= retries && !injectedPid; attempt += 1) {
    // A prior attempt's eval may have succeeded but its result pipe raced us;
    // the hello landing in events.jsonl is the ground truth.
    if (hello()) break;
    try {
      const procs =
        attempt === 1 && firstProcs
          ? firstProcs
          : processesUnderRoot(
              await platform.listProcessesByExeName(exeName),
              scan.root
            );
      if (!procs.length) {
        throw new AttachError(
          file
            ? "game exited while waiting to attach"
            : `no running ${exeName} process found under ${scan.root} — ` +
                "请先自行双击启动游戏，进入游戏后再点「附加到运行中」"
        );
      }
      const { mains, targets } = nwProcessTargets(procs);
      if (!file) {
        // WS summaries historically describe the successful attempt only.
        results = [];
        resultMainPid = mains.length ? mains[0].ProcessId : null;
      }
      for (const target of targets) {
        const result = await platform.injectAndDeliver({
          projectRoot,
          arch,
          pid: target.ProcessId,
          dllName: "rmch-mvhook.dll",
          bootstrap,
          mode: "crt",
          timeoutMs: policy.timeoutMs
        });
        results.push({
          ...(file ? { attempt } : {}),
          pid: target.ProcessId,
          ...result
        });
        if (file)
          launchLog(projectRoot, scan.gameKey, "inject attempt", {
            attempt,
            pid: target.ProcessId,
            ok: result.ok,
            detail: result.detail
          });
        // Every additional injection exposes another foreign DLL. Stop as
        // soon as one renderer reports success, regardless of transport.
        if (result.ok) {
          injectedPid = target.ProcessId;
          break;
        }
      }
      if (!file && !injectedPid) {
        throw new AttachError(
          "injection failed: " +
            results.map((r) => `pid ${r.pid}: ${r.detail}`).join("; ")
        );
      }
    } catch (error) {
      if (file) throw error;
      lastError = error;
      if (policy.sealed)
        launchLog(projectRoot, scan.gameKey, "ws attach attempt failed", {
          attempt,
          error: String((error && error.message) || error)
        });
    }
    if (!injectedPid && attempt < retries) {
      await clock.sleep(4000);
    }
  }
  if (!file && !injectedPid) throw lastError;
  if (!injectedPid && !hello()) {
    launchLog(projectRoot, scan.gameKey, "attach failed", {
      attempts: results.length,
      results: results.map((r) => `pid ${r.pid}: ${r.detail}`)
    });
    throw new AttachError(
      "injection failed: " +
        results.map((r) => `pid ${r.pid}: ${r.detail}`).join("; ") +
        (retries > 1
          ? ` (${retries} attempts — the game may still have been booting; 等登录界面出来后点「附加到运行中」)`
          : "")
    );
  }
  if (file) {
    launchLog(
      projectRoot,
      scan.gameKey,
      "injection landed, waiting for bridge hello",
      { pid: injectedPid }
    );
    await waitForFileBridgeHello(stateDir, retries > 1 ? 60000 : 30000, clock);
    launchLog(projectRoot, scan.gameKey, "bridge hello received", {
      pid: injectedPid
    });
  }
  return {
    game: scan.title,
    gameKey: scan.gameKey,
    root: scan.root,
    engine: scan.engine.id,
    strategy: file ? "nw-inject-file" : "nw-inject",
    arch,
    pid: resultMainPid,
    injected: injectedPid ? [injectedPid] : [],
    results,
    port: file ? null : port
  };
}

// Internal module interface: the caller asks for an attach, never a transport
// or retry count. Windows effects and time are the only substitutable
// dependencies; preparation and file-channel I/O remain real. Tests use this
// same orchestration with process snapshots and a virtual clock.
export function createNwAttachment({ platform, clock } = {}) {
  const runtime = {
    platform: platform || {
      listProcessesByExeName,
      clearRunAsAdminFlag,
      injectAndDeliver,
      ensureServer
    },
    clock: clock || {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    }
  };
  return {
    attach: (options) => attachNw(options, runtime)
  };
}

const nwAttachment = createNwAttachment();

// --- RGSS attach ------------------------------------------------------------------

async function attachRgss({ scan, projectRoot }) {
  const detect = detectRgss(scan.root);
  if (!detect)
    throw new AttachError(
      `RGSS detection failed (Game.ini Library): ${scan.root}`
    );
  if (detect.mkxp)
    // mkxp statically links its Ruby: no rgss*.dll module exists for the
    // attach hook (rmch-rgsshook) to resolve rb_eval_string_protect from.
    // The launch route works because it splices the bridge into the Scripts
    // archive instead.
    throw new AttachError(
      'mkxp variant games statically link Ruby — there is no rgss module to hook into post-launch; use "启动并注入" (the rgss-script route) instead'
    );
  const exePath = scan.paths.exe || detect.exe;
  if (!existsSync(exePath))
    throw new AttachError(`game exe not found: ${exePath}`);

  const procs = processesUnderRoot(
    await listProcessesByExeName(path.basename(exePath)),
    scan.root
  );
  if (!procs.length) {
    throw new AttachError(
      `no running ${path.basename(exePath)} process found under ${scan.root}`
    );
  }
  const target = procs[0]; // RGSS games are single-process
  const arch = readPeArch(exePath);

  // The file channel lives under runtime/rgss-attach/<gameKey>/ so attaching
  // does not drop rmch-*.jsonl files into the real game directory.
  const channelDir = path.join(
    projectRoot,
    "runtime",
    "rgss-attach",
    scan.gameKey
  );
  mkdirSync(channelDir, { recursive: true });

  // The bridge payload belongs to the rgss engine adapter; fall back to the
  // historical path for any scan no adapter claims.
  const bridge = payloadPaths(
    projectRoot,
    scan,
    "runtime/rgss-bridge",
    "bridge.rb"
  );
  const bridgeSource = readFileSync(
    path.join(bridge.dir, bridge.entry),
    "utf8"
  );
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
    projectRoot,
    arch,
    pid: target.ProcessId,
    dllName: "rmch-rgsshook.dll",
    bootstrap,
    mode: "wh",
    timeoutMs: RGSS_EVAL_TIMEOUT_MS
  });
  if (!result.ok) {
    throw new AttachError(
      `injection failed: pid ${target.ProcessId}: ${result.detail}`
    );
  }

  // The bridge truncates the channel files and says hello on its first frame.
  const session = await adoptRgssSession({
    dir: channelDir,
    gameKey: scan.gameKey,
    pid: target.ProcessId
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
      const killer = spawn(
        "taskkill",
        ["/PID", String(target.ProcessId), "/T", "/F"],
        { stdio: "ignore" }
      );
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
  if (/^RGSS/i.test(scan.engine.id)) {
    return attachRgss({ scan, projectRoot });
  }
  return nwAttachment.attach({ scan, projectRoot, port });
}
