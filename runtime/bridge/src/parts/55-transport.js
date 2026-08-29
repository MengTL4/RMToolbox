  // ---------------------------------------------------------------------------
  // Transport. Two channels, one executor.
  //
  //   WebSocket  — primary. The bridge is the CLIENT; the GUI (or `rmch serve`)
  //                hosts 127.0.0.1:47412. Reconnects with exponential backoff,
  //                so closing and reopening the GUI does not require a restart
  //                of the game.
  //   JSONL file — fallback. commands.jsonl in / events.jsonl out, polled every
  //                250ms. Survives a missing server entirely, and is the only
  //                channel available when a game's CSP blocks WebSocket.
  //
  // Both funnel into execute() and both must handle handlers that return a
  // promise (MZ's loadGame does), which is what settleResult exists for.
  // ---------------------------------------------------------------------------

  let ws = null;
  let wsBackoffMs = 1000;
  let wsConnected = false;

  function wsUrl() {
    return `ws://127.0.0.1:${wsPort}/bridge/${encodeURIComponent(gameKey)}?token=${encodeURIComponent(wsToken)}`;
  }

  function wsSend(value) {
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(value));
        return true;
      }
    } catch (_) {}
    return false;
  }

  function engineInfo() {
    try {
      const utils = window.Utils || {};
      return {
        maker: utils.RPGMAKER_NAME || null,
        makerVersion: utils.RPGMAKER_VERSION || null,
        title: (window.$dataSystem && window.$dataSystem.gameTitle) || null
      };
    } catch (_) {
      return null;
    }
  }

  // Run a command and report through `reply(ok, payloadOrErrorText)` exactly
  // once, whether the handler threw, returned a value, or returned a promise.
  function settleResult(type, args, reply) {
    let payload;
    try {
      payload = execute(type, args || {});
    } catch (error) {
      // Capture the text BEFORE log(): any file I/O inside log() may set
      // bridge.lastError again (e.g. mkdir quirks on old embedded Node).
      const text = noteError(error);
      log("command failed", { type, error: text });
      reply(false, text);
      return;
    }
    if (payload && typeof payload.then === "function") {
      payload.then(
        (value) => reply(true, value === undefined ? null : value),
        (error) => {
          const text = noteError(error);
          log("command failed (async)", { type, error: text });
          reply(false, text);
        }
      );
      return;
    }
    reply(true, payload === undefined ? null : payload);
  }

  // --- WebSocket --------------------------------------------------------------

  function connectWs() {
    let socket = null;
    try {
      socket = new WebSocket(wsUrl());
    } catch (error) {
      noteError(error);
      setTimeout(connectWs, wsBackoffMs);
      return;
    }
    ws = socket;

    socket.onopen = function () {
      wsConnected = true;
      wsBackoffMs = 1000;
      wsSend({
        t: "hello",
        bridgeVersion: bridge.version,
        engine: engineInfo(),
        gameKey,
        profile: bridge.profile || null
      });
      writeState();
    };

    socket.onmessage = function (socketEvent) {
      let message = null;
      try {
        message = JSON.parse(socketEvent.data);
      } catch (_) {
        return;
      }
      if (!message || typeof message !== "object") return;
      if (message.t === "ping") {
        wsSend({ t: "pong" });
        return;
      }
      if (message.t !== "cmd") return;
      const id = message.id;
      settleResult(message.type, message.args, (ok, value) => {
        const result = { t: "result", id, ok };
        if (ok) result.payload = value;
        else result.error = value;
        wsSend(result);
        // The GUI treats every result as a chance to re-render live values.
        writeState();
      });
    };

    socket.onclose = function () {
      wsConnected = false;
      ws = null;
      setTimeout(connectWs, wsBackoffMs);
      wsBackoffMs = Math.min(5000, wsBackoffMs * 2);
    };

    socket.onerror = function () {};
  }

  // --- JSONL file queue (same protocol the zs2/nwr modkits used) -------------

  function hashString(text) {
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) | 0;
    }
    return String(hash);
  }

  function commandQueueId(command, line) {
    if (command.commandId) return `file:${command.commandId}`;
    return `file:${hashString(String(line))}`;
  }

  function pollCommands() {
    try {
      ensureDir();
      if (!fs.existsSync(commandPath)) return;
      const lines = fs.readFileSync(commandPath, "utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        let command;
        try {
          command = JSON.parse(line);
        } catch (error) {
          log("bad command json", { line, error: String(error) });
          continue;
        }
        const id = commandQueueId(command, line);
        command.__rmchQueueId = id;
        if (!id || bridge.processed[id]) continue;
        // The file is append-only and never truncated on restart, so anything
        // older than this bridge's start belongs to a previous session.
        if (Number(command.ts || 0) < bridge.startedAtMs) {
          bridge.processed[id] = true;
          continue;
        }
        bridge.processed[id] = true;
        settleResult(command.type, command.args, (ok, value) => {
          event(command, ok, ok ? value : { error: value });
          writeState();
        });
      }
      // Compact the processed map so it never grows unbounded.
      const keys = Object.keys(bridge.processed);
      if (keys.length > 2000) {
        for (let index = 0; index < keys.length - 1000; index += 1) delete bridge.processed[keys[index]];
      }
    } catch (error) {
      log("poll failed", { error: noteError(error) });
    }
  }
