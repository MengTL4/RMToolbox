  // ---------------------------------------------------------------------------
  // Commands: core / diagnostics.
  //
  // Every handler takes the args object and returns a plain JSON payload, or
  // throws an Error whose message the GUI shows verbatim. Throwing is the normal
  // way to say "this game does not support that" — see 20-values.js require*.
  // ---------------------------------------------------------------------------

  Object.assign(commandHandlers, {
    "ping": () => collectState(),

    "runtime.info": () => ({
      bridgeVersion: bridge.version,
      engine: engineInfo(),
      gameKey,
      profile: bridge.profile || null,
      hooks: { patched: bridge.hooksPatched, targets: bridge.hookTargets.slice() },
      options: { ...bridge.options },
      location: String(window.location && window.location.href || "")
    }),

    "trainer.options.get": () => ({ options: { ...bridge.options }, hooks: patchTrainerHooks() }),

    // Accepts either {options:{...}} or the option map directly, because the CLI
    // sends the flat form and the GUI sends the wrapped one.
    "trainer.options.set": (args) => ({ options: setTrainerOptions(args.options || args) }),

    "trainer.hooks.info": () => ({
      options: { ...bridge.options },
      hooks: patchTrainerHooks(),
      hookTargets: bridge.hookTargets.slice(),
      rateStats: { ...bridge.rateStats },
      battleStats: { ...bridge.battleStats }
    }),

    // Runs in the page's own realm. Note that on some bundled games the game's
    // globals are not visible to a bare eval (they live in a module scope) —
    // reach them through TK.$ or use the dedicated commands instead.
    "console.eval": (args) => {
      const code = String(args.code || "");
      if (!code.trim()) throw new Error("code is empty");
      const result = (0, eval)(code);
      return { result: compactRuntimeValue(result, 3) };
    }
  });
