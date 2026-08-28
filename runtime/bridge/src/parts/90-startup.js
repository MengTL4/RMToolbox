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

  loadProfile();

  let hookRetries = 0;
  const hookTimer = setInterval(function () {
    hookRetries += 1;
    const summary = patchTrainerHooks();
    if (summary.count > 0 || hookRetries >= HOOK_RETRY_LIMIT) {
      clearInterval(hookTimer);
      log("hook install finished", { ...summary, retries: hookRetries });
      applyWorldOptions();
      writeState();
    }
  }, HOOK_RETRY_MS);

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
  setInterval(preserveVitalsTick, VITALS_GUARD_MS);
  setInterval(writeState, STATE_WRITE_MS);
  setInterval(pollCommands, COMMAND_POLL_MS);
})();
// @rmch-iife-close
