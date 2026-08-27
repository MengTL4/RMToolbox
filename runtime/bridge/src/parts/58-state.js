  // ---------------------------------------------------------------------------
  // State snapshot: written to state.json every second and pushed over the
  // WebSocket after every command, so the GUI renders live gold / party / map /
  // options without polling the game for each field.
  // ---------------------------------------------------------------------------

  function collectState() {
    const party = resolveParty();
    return {
      bridgeVersion: bridge.version,
      gameKey,
      engine: engineInfo(),
      wsConnected,
      profile: bridge.profile || null,
      startedAt: bridge.startedAt,
      gold: safeGold(party),
      map: currentMapInfo(),
      party: partyBattleMembers().map(actorInfo),
      saveDir: saveDirPath(),
      inBattle: isInBattle(),
      options: { ...bridge.options },
      hooks: {
        patched: bridge.hooksPatched,
        count: bridge.hookTargets.length,
        // Capped: a heavily-plugged game patches hundreds of prototype chain
        // entries and the full list dwarfs the rest of the snapshot.
        targets: bridge.hookTargets.slice(0, 80)
      },
      lastError: bridge.lastError
    };
  }

  function writeState() {
    const state = collectState();
    try {
      ensureDir();
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
    } catch (error) {
      noteError(error);
    }
    wsSend({ t: "state", state });
    return state;
  }
