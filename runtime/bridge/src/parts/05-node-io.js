  // ---------------------------------------------------------------------------
  // Node I/O. The bridge runs in a NW.js page, so `require` is available — but
  // only inside the game's own context, which is exactly why this bails loudly
  // instead of limping on. Everything below is paths + append-only writers;
  // the JSONL files double as the fallback command channel (55-transport.js).
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
  if (!fs || !path || typeof process === "undefined") {
    bridge.lastError = "Node require/process is unavailable in page context";
    return;
  }

  // RMCH_* environment variables are set by the launcher (core/launcher.mjs).
  // State lives under <projectRoot>/runtime/bridge-state/<gameKey>/.
  const gameRoot = process.env.RMCH_GAME_ROOT || process.cwd();
  const projectRoot = process.env.RMCH_PROJECT_ROOT || path.join(gameRoot, "RMCH");
  const gameKey = process.env.RMCH_GAME_KEY || "unknown";
  const wsPort = Number(process.env.RMCH_WS_PORT) || 47412;
  const wsToken = process.env.RMCH_WS_TOKEN || "";
  const bridgeDir = path.join(projectRoot, "runtime", "bridge-state", gameKey);
  const commandPath = path.join(bridgeDir, "commands.jsonl");
  const eventPath = path.join(bridgeDir, "events.jsonl");
  const statePath = path.join(bridgeDir, "state.json");
  const logPath = path.join(bridgeDir, "bridge.log");

  function ensureDir() {
    try {
      fs.mkdirSync(bridgeDir, { recursive: true });
    } catch (error) {
      bridge.lastError = String(error && error.stack || error);
    }
  }

  function append(file, value) {
    ensureDir();
    fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf8");
  }

  function log(message, extra) {
    ensureDir();
    const line = `[${new Date().toISOString()}] ${message}${extra ? " " + JSON.stringify(extra) : ""}\n`;
    fs.appendFileSync(logPath, line, "utf8");
  }

  function event(command, ok, payload) {
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
