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
  });

  connectWs();
  writeState();

  setInterval(applyWorldOptions, WORLD_OPTION_MS);
  setInterval(preserveVitalsTick, VITALS_GUARD_MS);
  setInterval(writeState, STATE_WRITE_MS);
  setInterval(pollCommands, COMMAND_POLL_MS);
})();
// @rmch-iife-close
