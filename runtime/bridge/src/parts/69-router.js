  // ---------------------------------------------------------------------------
  // Router. Every 6x-commands-*.js part has assigned its domain onto
  // commandHandlers by now; freeze it so a profile can extend the bridge but
  // never silently replace a core command.
  // ---------------------------------------------------------------------------

  Object.freeze(commandHandlers);

  function execute(type, args) {
    const key = String(type || "");
    // Core first, profile second: a per-game profile adds commands, it does not
    // shadow them. (profileCommands is declared in 70-profiles.js — this only
    // runs after every part has loaded.)
    const handler = commandHandlers[key] || profileCommands[key];
    if (!handler) throw new Error(`unknown command type: ${type}`);
    return handler(args || {});
  }
