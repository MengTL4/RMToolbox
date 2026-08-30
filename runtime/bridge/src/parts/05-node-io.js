  // ---------------------------------------------------------------------------
  // Node I/O. In a NW.js page `require` is available — but only inside the
  // game's own context. In a Tauri shell (WebView2) there is no Node at all:
  // config then comes from window.__rmchEnv and every writer below degrades
  // to a no-op, leaving the CDP outbox as the only transport (55-transport).
  // Everything below is paths + append-only writers; the JSONL files double
  // as the fallback command channel where fs exists.
  // ---------------------------------------------------------------------------

  function tryRequire(name) {
    try {
      if (typeof require === "function") return require(name);
    } catch (error) {
      bridge.lastError = String(error && error.stack || error);
    }
    return null;
  }

  const fs = tryRequire("fs");
  const path = tryRequire("path");

  // Two runtime contexts:
  //   NW.js page  — require/process exist; RMCH_* arrive via process.env.
  //   Tauri shell — no Node at all. The CDP bootstrap (core/tauri-cdp.mjs)
  //     leaves config on window.__rmchEnv and file I/O degrades to no-ops:
  //     the JSONL fallback channel, state.json and bridge.log all need fs,
  //     so under RMCH_TRANSPORT="cdp" everything moves over the CDP link.
  const envShim = window.__rmchEnv || null;
  if ((!fs || !path || typeof process === "undefined") && !envShim) {
    bridge.lastError = "Node require/process is unavailable in page context";
    return;
  }
  const fileIo = !!(fs && path);

  function envVar(name) {
    if (typeof process !== "undefined" && process.env && process.env[name]) return process.env[name];
    return (envShim && envShim[name]) || "";
  }

  // RMCH_* environment variables are set by the launcher (core/launcher.mjs).
  // State lives under <projectRoot>/runtime/bridge-state/<gameKey>/.
  const gameRoot = envVar("RMCH_GAME_ROOT") || (typeof process !== "undefined" ? process.cwd() : "");
  const projectRoot = envVar("RMCH_PROJECT_ROOT") || (fileIo ? path.join(gameRoot, "RMCH") : "");
  const gameKey = envVar("RMCH_GAME_KEY") || "unknown";
  const wsPort = Number(envVar("RMCH_WS_PORT")) || 47412;
  const wsToken = envVar("RMCH_WS_TOKEN") || "";
  const transportMode = envVar("RMCH_TRANSPORT") || "auto";
  const bridgeDir = fileIo && projectRoot ? path.join(projectRoot, "runtime", "bridge-state", gameKey) : null;
  const commandPath = bridgeDir ? path.join(bridgeDir, "commands.jsonl") : null;
  const eventPath = bridgeDir ? path.join(bridgeDir, "events.jsonl") : null;
  const statePath = bridgeDir ? path.join(bridgeDir, "state.json") : null;
  const logPath = bridgeDir ? path.join(bridgeDir, "bridge.log") : null;

  function ensureDir() {
    if (!fileIo || !bridgeDir) return;
    try {
      // existsSync first: NW.js 0.29 ships Node 9.7.1, where mkdirSync has no
      // recursive option and an existing dir throws EEXIST. The throw is
      // caught here either way — but it would pollute bridge.lastError, which
      // settleResult (55-transport.js) reports as the command's error text.
      if (!fs.existsSync(bridgeDir)) fs.mkdirSync(bridgeDir, { recursive: true });
    } catch (error) {
      bridge.lastError = String(error && error.stack || error);
    }
  }

  function append(file, value) {
    if (!fileIo || !file) return;
    ensureDir();
    fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf8");
  }

  function log(message, extra) {
    if (!fileIo || !logPath) return;
    ensureDir();
    const line = `[${new Date().toISOString()}] ${message}${extra ? " " + JSON.stringify(extra) : ""}\n`;
    fs.appendFileSync(logPath, line, "utf8");
  }

  function event(command, ok, payload) {
    if (!eventPath) return;
    append(eventPath, {
      ts: Date.now(),
      commandId: command && command.__rmchQueueId || null,
      type: command && command.type,
      ok,
      payload
    });
  }

  // Every catch that wants to record a failure funnels through here, so the
  // "stack or string" dance exists once instead of in forty places.
  function noteError(error) {
    bridge.lastError = String((error && error.stack) || error);
    return bridge.lastError;
  }
