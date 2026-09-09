  // ---------------------------------------------------------------------------
  // Commands: save slots, the runtime save-data tree, value locks.
  //
  // save.contents.* is the 数据修改 feature: the live save contents serialised
  // the way the game itself would write a save, edited as a JSON tree in the
  // GUI, then handed back. JsonEx (not JSON) so class identity survives the
  // round trip — its output is still valid JSON, which is what makes the tree
  // editor possible at all.
  // ---------------------------------------------------------------------------

  function isMvWebStorage() {
    const storage = window.StorageManager;
    return !!(storage && typeof storage.webStorageKey === "function" &&
      typeof storage.isLocalMode === "function" && !storage.isLocalMode());
  }

  function isMzForageStorage() {
    const storage = window.StorageManager;
    return !!(storage && typeof storage.isLocalMode === "function" && !storage.isLocalMode() &&
      ["forageKey", "updateForageKeys", "loadZip", "saveZip", "loadObject", "exists", "remove"]
        .every(name => typeof storage[name] === "function"));
  }

  function requireSaveSlotId(value) {
    if (isMzForageStorage() && (value === 0 || value === "0")) return 0;
    return requireId(value, "save id");
  }

  function requireMvWebStorage() {
    if (!isMvWebStorage()) throw new Error("this game does not use MV WebStorage saves");
    return window.StorageManager;
  }

  function webSaveKeys() {
    const storage = requireMvWebStorage();
    const max = webSaveMaxSlots();
    const keys = new Set([storage.webStorageKey(0)]);
    for (let id = 1; id <= max; id += 1) keys.add(storage.webStorageKey(id));
    return keys;
  }

  function webSaveMaxSlots() {
    const manager = window.DataManager;
    return Math.max(1, Number(manager && typeof manager.maxSavefiles === "function" && manager.maxSavefiles()) || 20);
  }

  function webSaveSnapshot() {
    const entries = [];
    for (const key of webSaveKeys()) {
      const value = localStorage.getItem(key);
      if (value !== null) entries.push({ key, value });
    }
    return { format: "rmch-mv-webstorage-v1", title: window.$dataSystem && window.$dataSystem.gameTitle || null, entries };
  }

  const nativeSlotManagers = new WeakSet();
  function isNativeSlotStorage() {
    const storage = window.StorageManager, manager = window.DataManager;
    if (!storage || !manager || isMvWebStorage() || typeof storage.load !== "function" ||
        typeof storage.save !== "function" || typeof storage.exists !== "function" ||
        typeof storage.localFilePath !== "function") return false;
    if (nativeSlotManagers.has(storage)) return true;
    // Encrypted/remote MV storage may retain the local-mode flag and filename
    // methods while its real saves are only accessible through StorageManager.
    try {
      for (let id = 1; id <= webSaveMaxSlots(); id += 1) {
        if (storage.exists(id) === true && !fs.existsSync(storage.localFilePath(id))) {
          nativeSlotManagers.add(storage);
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  async function nativeSlotSnapshot() {
    if (!isNativeSlotStorage()) throw new Error("当前游戏未使用原生槽位存档");
    const storage = window.StorageManager, entries = [];
    for (let id = 1; id <= webSaveMaxSlots(); id += 1) {
      if (!await storage.exists(id)) continue;
      const value = await storage.load(id);
      if (typeof value !== "string" || !value) throw new Error(`无法读取存档 ${id}`);
      entries.push({id, value});
    }
    return {format: "rmch-mv-native-v1", title: window.$dataSystem.gameTitle,
      infoJson: requireJsonEx().stringify(await window.DataManager.loadGlobalInfo() || []), entries};
  }

  // This part is also loaded in isolation by the lock-unit test. The full
  // bridge has inventoryId from 62-commands-party.js; keep a strict numeric
  // fallback for the isolated module so custom inventory validation remains
  // testable without coupling the harness to another part.
  function lockInventoryId(value, party, kind) {
    return typeof inventoryId === "function"
      ? inventoryId(value, party, kind)
      : typeof requireId === "function"
        ? requireId(value, "id")
        : (() => {
          const id = Number(value);
          if (!Number.isInteger(id) || id < 0) throw new Error("id must be a non-negative integer");
          return id;
        })();
  }

  Object.assign(commandHandlers, {

    // --- save slots -----------------------------------------------------------

    "save.list": async () => {
      if (isMzForageStorage()) return mzForageList();
      if (isNativeSlotStorage()) {
        const snapshot = await nativeSlotSnapshot();
        const info = requireJsonEx().parse(snapshot.infoJson);
        return {dir: null, storage: "native", entries: snapshot.entries.map(entry => ({
          name: `file${entry.id}.rpgsave`, slot: entry.id, size: entry.value.length,
          mtime: info[entry.id] && info[entry.id].timestamp
            ? new Date(info[entry.id].timestamp).toISOString() : null
        }))};
      }
      if (isMvWebStorage()) {
        const storage = window.StorageManager;
        const info = window.DataManager.loadGlobalInfo() || [];
        const entries = [];
        for (const key of webSaveKeys()) {
          const value = localStorage.getItem(key);
          if (value === null) continue;
          const match = /^RPG File([1-9]\d*)$/.exec(key);
          let slot = match ? Number(match[1]) : null;
          if (slot === null && key !== storage.webStorageKey(0)) {
            const max = webSaveMaxSlots();
            for (let id = 1; id <= max; id += 1) if (storage.webStorageKey(id) === key) { slot = id; break; }
          }
          entries.push({ name: key, slot, size: value.length,
            mtime: slot !== null && info[slot] && info[slot].timestamp ? new Date(info[slot].timestamp).toISOString() : null });
        }
        return { dir: null, storage: "webstorage", entries };
      }
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

    "save.save": async (args) => {
      const id = requireSaveSlotId(args.id === undefined ? 1 : args.id);
      const dataManager = requireDataManager("saveGame");
      if (isMvWebStorage() && id > webSaveMaxSlots()) throw new Error("save id exceeds this game's slot limit");
      const system = resolveSystem();
      if (system && typeof system.onBeforeSave === "function") system.onBeforeSave();
      // MV returns a boolean; MZ resolves without a value on success. Both
      // implementations write their own slot metadata. Calling MV's
      // saveGlobalInfo() without its required array can corrupt that metadata.
      const saved = dataManager.saveGame(id);
      const asynchronous = !!(saved && typeof saved.then === "function");
      const result = await saved;
      if (result === false || (!asynchronous && !result)) throw new Error("saveGame returned false");
      return { id, saved: true };
    },

    "save.webstorage.export": () => isMzForageStorage() ? mzForageSnapshot() : webSaveSnapshot(),

    "save.native.export": () => nativeSlotSnapshot(),

    "save.native.import": async (args) => {
      const snapshot = args.snapshot, manager = window.DataManager, storage = window.StorageManager;
      if (!isNativeSlotStorage()) throw new Error("请先连接使用原生槽位存档的游戏");
      if (!snapshot || snapshot.format !== "rmch-mv-native-v1" || snapshot.title !== window.$dataSystem.gameTitle ||
          !Array.isArray(snapshot.entries) || typeof snapshot.infoJson !== "string") throw new Error("invalid native save backup");
      const restoredInfo = requireJsonEx().parse(snapshot.infoJson);
      if (!Array.isArray(restoredInfo)) throw new Error("invalid native save metadata");
      const seen = new Set();
      for (const entry of snapshot.entries) {
        if (!entry || !Number.isInteger(entry.id) || entry.id < 1 || entry.id > webSaveMaxSlots() ||
            seen.has(entry.id) || typeof entry.value !== "string") throw new Error("invalid native save slot");
        const data = JSON.parse(entry.value);
        if (!data || !data.system || !data.party || !data.actors) throw new Error("invalid native save contents");
        seen.add(entry.id);
      }
      // Preserve all other slots and merge only metadata of restored slots.
      const info = await manager.loadGlobalInfo() || [];
      for (const entry of snapshot.entries) {
        await storage.save(entry.id, entry.value);
        if (await storage.load(entry.id) !== entry.value) throw new Error(`存档 ${entry.id} 恢复后校验失败`);
        info[entry.id] = restoredInfo[entry.id] || null;
      }
      await manager.saveGlobalInfo(info);
      return {restored: snapshot.entries.length};
    },

    "save.native.delete": async (args) => {
      if (!isNativeSlotStorage()) throw new Error("当前游戏未使用原生槽位存档");
      const match = /^file([1-9]\d*)\.rpgsave$/.exec(args.name || "");
      const id = match && Number(match[1]);
      if (!id || id > webSaveMaxSlots()) throw new Error("invalid native save slot");
      const storage = window.StorageManager;
      await storage.remove(id);
      if (await storage.exists(id)) throw new Error("游戏的原生存档接口未执行删除，存档仍保留");
      const info = await window.DataManager.loadGlobalInfo() || [];
      delete info[id];
      await window.DataManager.saveGlobalInfo(info);
      return {name: args.name, deleted: true};
    },

    "save.webstorage.import": (args) => {
      if (isMzForageStorage()) return mzForageImport(args.snapshot);
      requireMvWebStorage();
      const snapshot = args.snapshot;
      if (!snapshot || snapshot.format !== "rmch-mv-webstorage-v1" || !Array.isArray(snapshot.entries) ||
          snapshot.title !== (window.$dataSystem && window.$dataSystem.gameTitle || null)) {
        throw new Error("invalid MV WebStorage backup");
      }
      const allowed = webSaveKeys();
      const seen = new Set();
      for (const entry of snapshot.entries) {
        if (!entry || typeof entry.key !== "string" || typeof entry.value !== "string" ||
            !allowed.has(entry.key) || seen.has(entry.key)) {
          throw new Error("invalid save key in MV WebStorage backup");
        }
        seen.add(entry.key);
        const json = window.LZString.decompressFromBase64(entry.value);
        if (!json) throw new Error(`invalid compressed save: ${entry.key}`);
        const parsed = JSON.parse(json);
        const global = entry.key === window.StorageManager.webStorageKey(0);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) !== global) {
          throw new Error(`invalid save structure: ${entry.key}`);
        }
      }
      const previous = snapshot.entries.map(entry => ({ key: entry.key, value: localStorage.getItem(entry.key) }));
      try {
        for (const entry of snapshot.entries) localStorage.setItem(entry.key, entry.value);
      } catch (error) {
        for (const entry of previous) {
          if (entry.value === null) localStorage.removeItem(entry.key);
          else localStorage.setItem(entry.key, entry.value);
        }
        throw error;
      }
      // Plugins may cache the decoded global index between operations.
      if (window.DataManager) window.DataManager._globalInfo = null;
      return { restored: snapshot.entries.length };
    },

    "save.webstorage.delete": (args) => {
      if (isMzForageStorage()) return mzForageDelete(args.name);
      const storage = requireMvWebStorage();
      const name = String(args.name || "");
      const known = webSaveKeys();
      if (!known.has(name) || name === storage.webStorageKey(0) || localStorage.getItem(name) === null) {
        throw new Error("save slot not found");
      }
      const original = localStorage.getItem(name);
      const originalBackup = localStorage.getItem(name + "bak");
      const globalKey = storage.webStorageKey(0);
      const originalGlobal = localStorage.getItem(globalKey);
      const info = JSON.parse(JSON.stringify(window.DataManager.loadGlobalInfo() || []));
      const match = /^RPG File([1-9]\d*)$/.exec(name);
      let id = match && match[1];
      if (!id) for (let slot = 1; slot <= webSaveMaxSlots(); slot += 1) {
        if (storage.webStorageKey(slot) === name) { id = slot; break; }
      }
      try {
        localStorage.removeItem(name);
        localStorage.removeItem(name + "bak");
        if (id) delete info[Number(id)];
        window.DataManager.saveGlobalInfo(info);
        window.DataManager._globalInfo = null;
      } catch (error) {
        localStorage.setItem(name, original);
        if (originalBackup !== null) localStorage.setItem(name + "bak", originalBackup);
        if (originalGlobal === null) localStorage.removeItem(globalKey);
        else localStorage.setItem(globalKey, originalGlobal);
        window.DataManager._globalInfo = null;
        throw error;
      }
      return { name, deleted: true };
    },

    "save.load": (args) => {
      const id = requireSaveSlotId(args.id);
      const dataManager = requireDataManager("loadGame");
      const enterMap = (ok) => {
        if (!ok) throw new Error(`loadGame(${id}) failed`);
        // Message windows are temporary UI, not part of save contents. A load
        // discards the current interaction before constructing the map scene.
        const message = window.$gameMessage;
        if (message && typeof message.clear === "function") message.clear();
        try {
          const system = resolveSystem();
          if (system && typeof system.onAfterLoad === "function") system.onAfterLoad();
        } catch (_) {}
        const sceneManager = resolveSceneManager();
        const sceneMap = resolveSceneMap();
        if (sceneManager && typeof sceneManager.goto === "function" && sceneMap) sceneManager.goto(sceneMap);
        return { id, loaded: true };
      };
      // MV returns a boolean synchronously; MZ returns a promise.
      const attempt = () => {
        // Ldd's native UI downloads cloud saves, while saveGame still writes
        // local MZ storage. Toolbox listings/backups refer to those local slots.
        if (isMzForageStorage() && typeof window.StorageManager.loadCloudSave === "function") {
          return mzForageLoad(id);
        }
        const loaded = dataManager.loadGame(id);
        return loaded && typeof loaded.then === "function"
          ? loaded.then(result => result === undefined || result === 0 ? true : result)
          : Promise.resolve(loaded);
      };
      // Some custom engines (傲世修仙录定制版 family) sit at the title with the
      // database NOT resident — window.$dataSystem is null until their own
      // chain loads it — and vanilla loadGame then dies inside Game_Vehicle on
      // the null. When the first attempt fails into exactly that shape, run the
      // game's own loadDatabase (its overrides handle any decryption), wait for
      // the system table to materialise, then retry once. Vanilla games never
      // reach this: their loadGame works, or fails for unrelated reasons.
      return attempt().then((ok) => {
        if (ok || window.$dataSystem || typeof dataManager.loadDatabase !== "function") {
          return enterMap(ok);
        }
        try { dataManager.loadDatabase(); } catch (_) {}
        const deadline = Date.now() + 15000;
        const poll = () => new Promise((resolve) => {
          const tick = () => {
            if (window.$dataSystem || Date.now() > deadline) return resolve();
            setTimeout(tick, 200);
          };
          tick();
        });
        return poll().then(() => attempt()).then(enterMap);
      });
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
      const message = window.$gameMessage;
      if (args.reload !== false && message && typeof message.isBusy === "function" && message.isBusy()) {
        throw new Error("请等待当前对话或选项结束后，再应用存档数据");
      }

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
      const party = resolveParty();
      const id = (kind === "item" || kind === "weapon" || kind === "armor")
        ? lockInventoryId(args.id, party, kind)
        : Math.floor(requireNumber(args.id, "id"));
      if (args.enabled === false) {
        delete table[id];
        return { kind, id, enabled: false, value: null };
      }
      const value = coerceLockValue(kind, args.value);
      validateInventoryLock(kind, id, value);
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
      const next = {};
      LOCKABLE_KINDS.forEach((kind) => {
        const table = Object.create(null);
        const source = incoming[kind];
        if (source && typeof source === "object") {
          for (const key of Object.keys(source)) {
            const id = (kind === "item" || kind === "weapon" || kind === "armor")
              ? lockInventoryId(key, resolveParty(), kind)
              : Math.floor(Number(key));
            if (typeof id !== "string" && !Number.isFinite(id)) continue;
            const value = coerceLockValue(kind, source[key]);
            validateInventoryLock(kind, id, value);
            table[id] = value;
          }
        }
        next[kind] = table;
      });
      next.gold = incoming.gold == null
        ? null
        : Math.max(0, Math.floor(Number(incoming.gold) || 0));
      Object.assign(bridge.valueLocks, next);
      return { locks: snapshotValueLocks() };
    }
  });
