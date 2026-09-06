  // ---------------------------------------------------------------------------
  // Startup.
  //
  // Ordering matters here in a way that is easy to get wrong: engine classes do
  // not all exist when the bridge is injected (document_start), so hook
  // installation retries on a timer and again on window load. Everything else —
  // transport, state, the lock/option tickers — can start immediately.
  // ---------------------------------------------------------------------------

  const HOOK_RETRY_MS = 500;
  const HOOK_RETRY_LIMIT = 120;       // ~60s, enough for a slow disk + big game
  const WORLD_OPTION_MS = 500;        // fields the game also writes
  const VITALS_GUARD_MS = 100;        // beat direct _hp writes
  const STATE_WRITE_MS = 1000;
  const COMMAND_POLL_MS = 250;

  ensureDir();
  log("bridge injected", { href: location.href, gameKey, bridgeVersion: bridge.version });

  // Save-contents capture (08-capture.js): closure-sealed shells expose no
  // engine globals, and this tap is the only channel that ever reaches them.
  // Installed for every game — it is inert until a save/load flows by, and
  // resolvers only consult the capture after every other source fails.
  try { installSaveCaptureTap(); } catch (error) { noteError(error); }
  // A bootTap bootstrap (launch/dance for sealed shells) may have arrived
  // before the canvas gate allowed the full bridge eval — its holding tap
  // kept the boot-time database parses for us.
  try { replayBootCaptured(); } catch (error) { noteError(error); }

  loadProfile();

  // Sealed-launcher games (RMCH_SEALED=1): the engine's singletons are not on
  // window when this runs — a CDP seeder publishes them after the game enters
  // a session, which can be minutes after boot (the bundled launcher gates the
  // game behind its own start button). Hook installation therefore never gives
  // up for these games: it keeps the fast retry until the first stable pass,
  // then drops to a slow permanent retry so hooks whose classes materialise
  // later (party actors only exist once a save is loaded) still land.
  const sealedEngine = envVar("RMCH_SEALED") === "1";

  // Boot progress watch (sealed shells only): while the game sits on its
  // splash, the JSON tap counters are the only externally visible sign of
  // life. One compact line every 5s for the first 3 minutes makes "卡在哪一
  // 段" readable straight from bridge.log — parses frozen at a fixed count
  // means the shell's boot is stalled, a save capture means gameplay reached.
  if (sealedEngine) {
    let bootWatchTicks = 0;
    const bootWatchTimer = setInterval(function () {
      bootWatchTicks += 1;
      const stats = bridge.jsonTapStats || {};
      const captured = !!window.__rmchCapture;
      log("boot watch", {
        t: bootWatchTicks * 5,
        parses: stats.parses || 0,
        stringifies: stats.stringifies || 0,
        captured,
        tables: Object.keys(window.__rmchDataTables || {}).length,
        hooks: lastHookCount
      });
      if (captured || bootWatchTicks >= 36) clearInterval(bootWatchTimer);
    }, 5000);
  }
  let hookRetries = 0;
  let stablePasses = 0;
  let lastHookCount = -1;
  let hookTimer = null;
  let hookSlowTimer = null;
  // The permanent slow cadence: patchMethod is idempotent and the pass is
  // cheap, so hooks whose classes materialise later (a save loaded minutes
  // into the session) still land without burning CPU in the meantime.
  const startSlowRetry = function (summary) {
    if (hookTimer) clearInterval(hookTimer);
    hookTimer = null;
    log("hook install finished", { ...summary, retries: hookRetries });
    applyWorldOptions();
    writeState();
    hookSlowTimer = setInterval(function () {
      const slow = patchTrainerHooks();
      if (slow.count !== lastHookCount) {
        lastHookCount = slow.count;
        applyWorldOptions();
        writeState();
      }
    }, 5000);
  };
  const hookTick = function () {
    hookRetries += 1;
    const summary = patchTrainerHooks();
    if (summary.count > 0 && summary.count === lastHookCount) stablePasses += 1;
    else stablePasses = 0;
    lastHookCount = summary.count;
    const done = summary.count > 0 && (!sealedEngine || stablePasses >= 10);
    if (done || (!sealedEngine && hookRetries >= HOOK_RETRY_LIMIT)) {
      if (sealedEngine) startSlowRetry(summary);
      else {
        if (hookTimer) clearInterval(hookTimer);
        log("hook install finished", { ...summary, retries: hookRetries });
        applyWorldOptions();
        writeState();
      }
    } else if (sealedEngine && hookRetries >= HOOK_RETRY_LIMIT && summary.count === 0) {
      // Game still hasn't entered a session after the standard window — keep
      // trying, just at the slow cadence.
      startSlowRetry(summary);
    }
  };
  hookTimer = setInterval(hookTick, HOOK_RETRY_MS);

  // Plugins can replace prototypes after boot, so patch once more when the page
  // is fully loaded — patchMethod makes the repeat harmless.
  window.addEventListener("load", function () {
    patchTrainerHooks();
    applyWorldOptions();
    ensureWindowShown("load");
  });

  // Window-show watchdog. A whole class of protected games boots with
  // "window": {"show": false} in package.json and relies on its startup chain
  // calling nw.Window.get().show() once ready. If that chain stalls (protection
  // hiccup, plugin error, timing), the page — and this bridge — keeps running
  // with no visible window: "process alive, items listed, BGM audible, but no
  // game UI". While the window has never been visible, re-assert show() every
  // few seconds. Once the window has been seen visible even once the watchdog
  // disarms, so it never fights the user (minimize) or the game (intentional
  // hide) later on. show() on an already-visible window is a no-op.
  let windowWatchdogArmed = true;
  function ensureWindowShown(reason) {
    if (!windowWatchdogArmed) return;
    try {
      if (typeof nw === "undefined" || !nw.Window || typeof nw.Window.get !== "function") {
        windowWatchdogArmed = false; // not an NW page (e.g. test harness)
        return;
      }
      if (!document || document.visibilityState !== "hidden") {
        windowWatchdogArmed = false; // window shown (or state unknown) — game is fine
        return;
      }
      const win = nw.Window.get();
      if (!win || typeof win.show !== "function") return;
      win.show();
      log("window show asserted", { reason });
    } catch (error) {
      noteError(error);
    }
  }
  const windowWatchdogTimer = setInterval(function () { ensureWindowShown("watchdog"); }, 1500);
  setTimeout(function () {
    clearInterval(windowWatchdogTimer);
    windowWatchdogArmed = false;
  }, 30000);

  connectWs();
  writeState();

  setInterval(applyWorldOptions, WORLD_OPTION_MS);
  setInterval(function () {
    preserveVitalsTick();
    // Value locks normally reassert from the SceneManager.updateMain wrapper
    // (40-hooks), but games with a fully custom main loop never call it
    // (停不下来的轮回: 0 invocations of SceneManager.update in 2s — measured).
    // Tick them here too, on a clock no game loop can break. Cheap when no
    // locks are armed (tiny object scans) and idempotent with the frame path.
    applyValueLocks();
  }, VITALS_GUARD_MS);
  setInterval(writeState, STATE_WRITE_MS);
  setInterval(pollCommands, COMMAND_POLL_MS);
})();
// @rmch-iife-close
