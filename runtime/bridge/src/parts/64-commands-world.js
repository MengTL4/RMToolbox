  // ---------------------------------------------------------------------------
  // Commands: switches, variables, maps, events, battle.
  //
  // Switch/variable ids are validated against $dataSystem's declared length:
  // writing past it "works" but the game never reads it back, which looks like
  // the trainer silently failing.
  // ---------------------------------------------------------------------------

  const SELF_SWITCH_LETTERS = Object.freeze(["A", "B", "C", "D"]);

  function requireSystemId(kind, value, label) {
    const id = requireId(value, label);
    const limit = systemListLimit(kind);
    if (limit > 0 && id >= limit) throw new Error(`${label} ${id} exceeds system limit ${limit}`);
    return id;
  }

  Object.assign(commandHandlers, {

    // --- switches / variables -------------------------------------------------

    "switch.set": (args) => {
      const switches = requireSwitches();
      const id = requireSystemId("switches", args.id, "switch id");
      switches.setValue(id, !!args.value);
      return { id, value: !!args.value };
    },

    "switch.list": (args) => listSystemEntries("switches", args),

    "variable.set": (args) => {
      const variables = requireVariables();
      const id = requireSystemId("variables", args.id, "variable id");
      variables.setValue(id, args.value);
      return { id, value: args.value };
    },

    "variable.list": (args) => listSystemEntries("variables", args),

    // --- self switches --------------------------------------------------------
    //
    // Keyed by [mapId, eventId, letter] and stored sparsely: only switches that
    // have ever been set exist, so the list is "what this map has touched", not
    // "every event on this map".

    "selfSwitch.set": (args) => {
      const selfSwitches = requireSelfSwitches();
      const mapId = Math.floor(requireNumber(args.mapId, "mapId"));
      const eventId = Math.floor(requireNumber(args.eventId, "eventId"));
      const letter = String(args.letter || "A").toUpperCase();
      if (!SELF_SWITCH_LETTERS.includes(letter)) throw new Error("letter must be one of A/B/C/D");
      selfSwitches.setValue([mapId, eventId, letter], !!args.value);
      return { mapId, eventId, letter, value: !!args.value };
    },

    "selfSwitch.list": (args) => {
      const selfSwitches = resolveSelfSwitches();
      const mapId = Math.floor(requireNumber(args.mapId, "mapId"));
      const entries = [];
      try {
        const data = selfSwitches && selfSwitches._data;
        if (data) {
          Object.keys(data).forEach((key) => {
            const parts = String(key).split(",");
            if (Number(parts[0]) !== mapId) return;
            entries.push({
              mapId: Number(parts[0]),
              eventId: Number(parts[1]),
              letter: parts[2] || "",
              value: !!data[key]
            });
          });
        }
      } catch (_) {}
      return { mapId, entries };
    },

    // --- maps / movement ------------------------------------------------------

    "map.info": () => currentMapInfo(),
    "map.list": () => mapList(),

    "map.transfer": (args) => {
      const player = requirePlayer();
      const mapId = requireId(args.mapId, "mapId");
      const mapInfoTable = runtimeDataTable("mapInfo");
      // Only validate when the table is actually loaded — an early transfer
      // request should not be rejected just because $dataMapInfos is still empty.
      if (Array.isArray(mapInfoTable) && mapInfoTable.length > 1 && !mapInfoTable[mapId]) {
        throw new Error(`map ${mapId} not found`);
      }
      const x = Math.floor(requireNumber(args.x, "x"));
      const y = Math.floor(requireNumber(args.y, "y"));
      const direction = hasValue(args.direction) ? Math.floor(requireNumber(args.direction, "direction")) : 2;
      const fade = hasValue(args.fade) ? Math.floor(requireNumber(args.fade, "fade")) : 0;
      if (typeof player.reserveTransfer === "function") {
        player.reserveTransfer(mapId, x, y, direction, fade);
      } else if (typeof player.locate === "function") {
        player.locate(x, y);
      } else {
        throw new Error("player transfer is unavailable");
      }
      refreshMapAndWindows();
      return { mapId, x, y, direction, fade };
    },

    "map.through.set": (args) => {
      const player = requireThroughCapablePlayer();
      player._through = !!args.value;
      bridge.options.throughWalls = player._through;
      return { through: player._through };
    },

    "map.through.toggle": () => {
      const player = requireThroughCapablePlayer();
      player._through = !player._through;
      bridge.options.throughWalls = player._through;
      return { through: player._through };
    },

    "player.location": () => {
      const player = requirePlayer();
      return {
        mapId: player._mapId != null ? player._mapId : (resolveMap() && resolveMap()._mapId),
        x: player._x,
        y: player._y,
        direction: player._direction
      };
    },

    // --- map events -----------------------------------------------------------

    "map.events.list": () => {
      const map = requireMap();
      const events = Array.isArray(map._events) ? map._events : [];
      const entries = [];
      events.forEach((mapEvent) => {
        if (!mapEvent) return;
        let data = null;
        try { data = typeof mapEvent.event === "function" ? mapEvent.event() : null; } catch (_) {}
        let commands = 0;
        try {
          const page = data && data.pages && data.pages[mapEvent._pageIndex];
          commands = page && Array.isArray(page.list) ? page.list.length : 0;
        } catch (_) {}
        entries.push({
          eventId: Number(mapEvent._eventId) || 0,
          name: (data && data.name) || "",
          x: Number(mapEvent._x) || 0,
          y: Number(mapEvent._y) || 0,
          pageIndex: mapEvent._pageIndex == null ? null : Number(mapEvent._pageIndex),
          pages: (data && Array.isArray(data.pages)) ? data.pages.length : 0,
          commands
        });
      });
      entries.sort((a, b) => a.eventId - b.eventId);
      return { mapId: typeof map.mapId === "function" ? map.mapId() : null, entries };
    },

    "map.transferToEvent": (args) => {
      const map = requireMap();
      const player = requirePlayer();
      const eventId = Math.floor(requireNumber(args.eventId, "eventId"));
      const mapEvent = typeof map.event === "function" ? map.event(eventId) : null;
      if (!mapEvent) throw new Error(`event ${eventId} is not on the current map`);
      const x = Number(mapEvent._x) || 0;
      const y = Number(mapEvent._y) || 0;
      if (typeof player.locate === "function") player.locate(x, y);
      else { player._x = x; player._y = y; }
      return { eventId, x, y };
    },

    "commonEvent.run": (args) => {
      const id = Math.floor(requireNumber(args.id, "id"));
      const eventData = runtimeDataTable("commonEvent")[id];
      if (!eventData) throw new Error(`common event ${id} not found`);
      const temp = requireEngineObject(resolveTemp(), "game temp", "reserveCommonEvent");
      temp.reserveCommonEvent(id);
      const map = resolveMap();
      if (map && typeof map.requestRefresh === "function") map.requestRefresh();
      return { id, name: eventData.name || "" };
    },

    // --- battle ---------------------------------------------------------------

    "battle.info": () => ({
      inBattle: isInBattle(),
      enemies: troopEnemies(false).map((enemy, index) => ({
        index,
        name: enemyNameOf(enemy),
        hp: battlerHp(enemy),
        mhp: Number(readStat(enemy, "mhp", "_mhp")) || null,
        isAlive: typeof enemy.isAlive === "function" ? !!enemy.isAlive() : battlerHp(enemy) > 0
      })),
      party: partyBattleMembers().map(actorInfo)
    }),

    "battle.enemy.setHp": (args) => {
      const index = Math.floor(requireNumber(args.index, "index"));
      const enemy = troopEnemies(false)[index];
      if (!enemy) throw new Error(`enemy index ${index} not found`);
      const hp = Math.max(0, Math.floor(requireNumber(args.value, "value")));
      withLocksSuppressed(() => {
        if (typeof enemy.setHp === "function") enemy.setHp(hp);
        else enemy._hp = hp;
      });
      return { index, hp: battlerHp(enemy) };
    },

    "battle.killEnemies": () => {
      let killed = 0;
      troopEnemies(true).forEach((enemy) => {
        if (defeatEnemy(enemy, "battle.killEnemies")) killed += 1;
      });
      return { killed, remaining: troopEnemies(true).length };
    },

    "battle.escape": () => {
      const managers = resolveBattleManagers();
      const battle = managers[0] && managers[0].object;
      if (!battle) throw new Error("battle manager is unavailable");
      if (!isInBattle()) throw new Error("not in battle");
      // abortBattle is the clean exit; endBattle(1) is the "escaped" result code
      // and is what older/patched managers expose instead.
      if (typeof battle.abortBattle === "function") {
        battle.abortBattle();
        return { escaped: true, method: "abortBattle" };
      }
      if (typeof battle.endBattle === "function") {
        battle.endBattle(1);
        return { escaped: true, method: "endBattle" };
      }
      throw new Error("no escape method available");
    }
  });

  // Some games strip _through entirely; failing loudly beats setting a field the
  // engine never reads.
  function requireThroughCapablePlayer() {
    const player = requirePlayer();
    if (!Object.prototype.hasOwnProperty.call(player, "_through")) {
      throw new Error("player through field is unavailable");
    }
    return player;
  }
