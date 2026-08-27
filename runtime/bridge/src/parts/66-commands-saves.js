  // ---------------------------------------------------------------------------
  // Commands: save slots, the runtime save-data tree, value locks.
  //
  // save.contents.* is the 数据修改 feature: the live save contents serialised
  // the way the game itself would write a save, edited as a JSON tree in the
  // GUI, then handed back. JsonEx (not JSON) so class identity survives the
  // round trip — its output is still valid JSON, which is what makes the tree
  // editor possible at all.
  // ---------------------------------------------------------------------------

  Object.assign(commandHandlers, {

    // --- save slots -----------------------------------------------------------

    "save.list": () => {
      const dir = saveDirPath();
      const entries = [];
      try {
        for (const name of fs.readdirSync(dir)) {
          // MV writes fileN.rpgsave, MZ writes fileN.rmmzsave.
          if (!/\.(rpgsave|rmmzsave)$/i.test(name)) continue;
          const stat = fs.statSync(path.join(dir, name));
          entries.push({ name, size: stat.size, mtime: stat.mtime.toISOString() });
        }
      } catch (_) {}
      entries.sort((a, b) => a.name.localeCompare(b.name));
      return { dir, entries };
    },

    "save.save": (args) => {
      const id = requireId(args.id === undefined ? 1 : args.id, "save id");
      const dataManager = requireDataManager("saveGame");
      if (!dataManager.saveGame(id)) throw new Error("saveGame returned false");
      // Without global info the title screen's slot list stays stale.
      try {
        if (typeof dataManager.saveGlobalInfo === "function") dataManager.saveGlobalInfo();
      } catch (_) {}
      return { id, saved: true };
    },

    "save.load": (args) => {
      const id = requireId(args.id, "save id");
      const dataManager = requireDataManager("loadGame");
      // MV returns a boolean synchronously; MZ returns a promise. Either way the
      // game's own (possibly patched) StorageManager handles the file format.
      const loaded = dataManager.loadGame(id);
      const enterMap = (ok) => {
        if (!ok) throw new Error(`loadGame(${id}) failed`);
        try {
          const system = resolveSystem();
          if (system && typeof system.onAfterLoad === "function") system.onAfterLoad();
        } catch (_) {}
        const sceneManager = resolveSceneManager();
        const sceneMap = resolveSceneMap();
        if (sceneManager && typeof sceneManager.goto === "function" && sceneMap) sceneManager.goto(sceneMap);
        return { id, loaded: true };
      };
      return loaded && typeof loaded.then === "function" ? loaded.then(enterMap) : enterMap(loaded);
    },

    // --- save-data tree (数据修改) --------------------------------------------

    "save.contents.get": (args) => {
      const dataManager = requireDataManager("makeSaveContents");
      const jsonEx = requireJsonEx("stringify");
      const contents = dataManager.makeSaveContents();
      // JsonEx.maxDepth defaults to 100; deep plugin structures otherwise throw.
      const previousDepth = jsonEx.maxDepth;
      let json;
      try {
        jsonEx.maxDepth = Math.max(Number(previousDepth) || 100, 200);
        json = jsonEx.stringify(contents);
      } finally {
        jsonEx.maxDepth = previousDepth;
      }
      const bytes = json.length;
      // A 40MB save would wedge the tree editor; make the refusal explicit and
      // let the caller raise the ceiling deliberately.
      const limit = Math.max(1, Math.floor(Number(args && args.limitBytes) || 12 * 1024 * 1024));
      if (bytes > limit) {
        throw new Error(`save contents is ${bytes} bytes, over the ${limit} byte limit — ` +
          "raise limitBytes if you really want to load it into the editor");
      }
      return { json, bytes, keys: Object.keys(contents || {}) };
    },

    "save.contents.apply": (args) => {
      const dataManager = requireDataManager("extractSaveContents");
      const jsonEx = requireJsonEx("parse");
      const json = String(args.json || "");
      if (!json.trim()) throw new Error("json is empty");
      const contents = jsonEx.parse(json);
      if (!contents || typeof contents !== "object") throw new Error("parsed contents is not an object");

      // extractSaveContents swaps every $game* global at once, so the running
      // scene is left holding stale references; reload the map the same way
      // Scene_Load does unless the caller opts out.
      dataManager.extractSaveContents(contents);
      let reloaded = false;
      if (args.reload !== false) {
        try {
          const player = resolvePlayer();
          const map = resolveMap();
          const sceneManager = resolveSceneManager();
          const sceneMap = resolveSceneMap();
          if (player && map && typeof player.reserveTransfer === "function") {
            player.reserveTransfer(map.mapId(), player.x, player.y,
              typeof player.direction === "function" ? player.direction() : 2, 0);
            if (typeof player.requestMapReload === "function") player.requestMapReload();
          }
          if (sceneManager && sceneMap && typeof sceneManager.goto === "function") {
            sceneManager.goto(sceneMap);
            reloaded = true;
          }
        } catch (error) {
          noteError(error);
        }
      }
      return { applied: true, reloaded, bytes: json.length };
    },

    // --- value locks (数据锁定) ----------------------------------------------

    "lock.list": () => ({ locks: snapshotValueLocks(), stats: { ...bridge.lockStats } }),

    "lock.set": (args) => {
      const kind = String(args.kind || "");
      if (kind === "gold") {
        bridge.valueLocks.gold = args.enabled === false
          ? null
          : Math.max(0, Math.floor(requireNumber(args.value, "value")));
        return { kind, enabled: bridge.valueLocks.gold != null, value: bridge.valueLocks.gold };
      }
      const table = bridge.valueLocks[kind];
      if (!table) throw new Error(`unsupported lock kind: ${kind}`);
      const id = Math.floor(requireNumber(args.id, "id"));
      if (args.enabled === false) {
        delete table[id];
        return { kind, id, enabled: false, value: null };
      }
      const value = coerceLockValue(kind, args.value);
      table[id] = value;
      return { kind, id, enabled: true, value };
    },

    "lock.clear": (args) => {
      const kind = args && args.kind ? String(args.kind) : null;
      if (!kind) {
        bridge.valueLocks.gold = null;
        LOCKABLE_KINDS.forEach((key) => { bridge.valueLocks[key] = Object.create(null); });
        return { cleared: "all", locks: snapshotValueLocks() };
      }
      if (kind === "gold") bridge.valueLocks.gold = null;
      else if (bridge.valueLocks[kind]) bridge.valueLocks[kind] = Object.create(null);
      else throw new Error(`unsupported lock kind: ${kind}`);
      return { cleared: kind, locks: snapshotValueLocks() };
    },

    // Bulk restore, used when the GUI reconnects and replays a saved lock set.
    "lock.replace": (args) => {
      const incoming = args.locks || {};
      LOCKABLE_KINDS.forEach((kind) => {
        const table = Object.create(null);
        const source = incoming[kind];
        if (source && typeof source === "object") {
          for (const key of Object.keys(source)) {
            const id = Math.floor(Number(key));
            if (!Number.isFinite(id)) continue;
            table[id] = coerceLockValue(kind, source[key]);
          }
        }
        bridge.valueLocks[kind] = table;
      });
      bridge.valueLocks.gold = incoming.gold == null
        ? null
        : Math.max(0, Math.floor(Number(incoming.gold) || 0));
      return { locks: snapshotValueLocks() };
    }
  });
