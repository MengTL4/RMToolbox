  // ---------------------------------------------------------------------------
  // Per-game profiles: optional JS files at
  // <projectRoot>/runtime/bridge/profiles/<gameKey>.js that extend the generic
  // bridge with game-specific commands and options. They run in the page
  // context with the API object below; the generic core never depends on them,
  // and a profile that throws must not take the bridge down with it.
  // ---------------------------------------------------------------------------

  const profileCommands = Object.create(null);

  function profileApi() {
    return {
      bridge,
      registerCommands(handlers) {
        if (handlers && typeof handlers === "object") Object.assign(profileCommands, handlers);
      },
      registerOptions(defaults) {
        if (defaults && typeof defaults === "object") Object.assign(bridge.options, defaults);
      },
      patchMethod,
      setTrainerOptions,
      patchTrainerHooks,
      resolve: {
        party: resolveParty,
        system: resolveSystem,
        variables: resolveVariables,
        switches: resolveSwitches,
        selfSwitches: resolveSelfSwitches,
        actors: resolveActors,
        troop: resolveTroop,
        temp: resolveTemp,
        map: resolveMap,
        player: resolvePlayer,
        followers: resolveFollowers,
        screen: resolveScreen,
        dataManager: resolveDataManager,
        storageManager: resolveStorageManager,
        data: resolveData,
        battleManagers: resolveBattleManagers
      },
      helpers: {
        actorInfo,
        actorIdOf,
        requireActor,
        getPartyMembers,
        partyBattleMembers,
        troopEnemies,
        battlerHp,
        setBattlerHp,
        refreshActor,
        refreshMapAndWindows,
        currentMapInfo,
        catalogEntries,
        runtimeDataTable,
        // Suppression scopes: wrap a write so the trainer's own hooks leave it
        // alone. See 20-values.js for which hook honours which.
        withRatesSuppressed,
        withLocksSuppressed,
        withNoCostSuppressed,
        withInvincibleSuppressed,
        clampNumber,
        looseNumber,
        requireNumber,
        toBool,
        log,
        event
      },
      paths: { gameRoot, projectRoot, bridgeDir },
      fs,
      path
    };
  }

  function loadProfile() {
    // Profiles are read from disk; in a no-Node shell (Tauri) there are none.
    if (!fileIo) {
      bridge.profile = { loaded: false, reason: "no fs in page context" };
      return false;
    }
    try {
      const profilePath = path.join(projectRoot, "runtime", "bridge", "profiles", `${gameKey}.js`);
      if (!fs.existsSync(profilePath)) {
        bridge.profile = { loaded: false, reason: "no profile" };
        return false;
      }
      const source = fs.readFileSync(profilePath, "utf8");
      const api = profileApi();
      // One execution covers both profile forms: a plain script that uses the
      // api directly, and `module.exports = function (api) {...}` (the export is
      // invoked after the runner so the body sees the same api object).
      const moduleObject = { exports: {} };
      const runner = new Function("api", "module", "exports", `"use strict";\n${source}\n`);
      runner(api, moduleObject, moduleObject.exports);
      const exported = moduleObject.exports;
      const entry = typeof exported === "function"
        ? exported
        : (exported && typeof exported.default === "function" ? exported.default : null);
      if (entry) entry(api);
      bridge.profile = {
        loaded: true,
        path: profilePath,
        commands: Object.keys(profileCommands).sort()
      };
      log("profile loaded", { path: profilePath, commands: bridge.profile.commands });
      return true;
    } catch (error) {
      bridge.profile = { loaded: false, error: noteError(error) };
      log("profile load failed", { error: bridge.lastError });
      return false;
    }
  }
