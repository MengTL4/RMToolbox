  // MZ browser saves live in localForage, accessed through the native codec.
  // Keep the existing webstorage command contract used by the desktop host.
  function mzForageName(name) {
    return typeof name === "string" && /^(?:global|file\d{1,4})$/.test(name);
  }

  async function mzForageSnapshot() {
    const storage = window.StorageManager;
    await storage.updateForageKeys();
    const prefix = storage.forageKey("");
    const names = (storage._forageKeys || []).filter(key => key.startsWith(prefix))
      .map(key => key.slice(prefix.length)).filter(mzForageName).sort();
    const entries = [];
    for (const key of names) {
      const value = await storage.loadZip(key);
      if (typeof value !== "string") throw new Error(`无法读取本地存档 ${key}`);
      entries.push({key, value});
    }
    return {format:"rmch-mz-forage-v1", title:window.$dataSystem.gameTitle, prefix, entries};
  }

  async function mzForageList() {
    const snapshot = await mzForageSnapshot(), storage = window.StorageManager;
    const info = await storage.loadObject("global").catch(() => []);
    return {dir:null, storage:"webstorage", localOnly:typeof storage.loadCloudSave === "function", entries:snapshot.entries.map(entry => {
      const match = /^file(\d+)$/.exec(entry.key), slot = match ? Number(match[1]) : null;
      return {name:entry.key + ".rmmzsave", slot, size:entry.value.length,
        mtime:slot !== null && info && info[slot] && info[slot].timestamp
          ? new Date(info[slot].timestamp).toISOString() : null};
    })};
  }

  async function mzForageImport(snapshot) {
    const storage = window.StorageManager, manager = window.DataManager;
    if (!snapshot || snapshot.format !== "rmch-mz-forage-v1" ||
        snapshot.title !== window.$dataSystem.gameTitle || snapshot.prefix !== storage.forageKey("") ||
        !Array.isArray(snapshot.entries)) throw new Error("invalid MZ browser save backup");
    const seen = new Set();
    let restoredInfo;
    // Decode every entry before writing any of them. Config and other games'
    // storage keys are never valid backup destinations.
    for (const entry of snapshot.entries) {
      if (!entry || !mzForageName(entry.key) || seen.has(entry.key) || typeof entry.value !== "string") {
        throw new Error("invalid MZ browser save entry");
      }
      seen.add(entry.key);
      const contents = await storage.jsonToObject(await storage.zipToJson(entry.value));
      if (entry.key === "global" ? !Array.isArray(contents) :
          !contents || !contents.system || !contents.party || !contents.actors) throw new Error("invalid MZ save contents");
      if (entry.key === "global") restoredInfo = contents;
    }
    const entries = snapshot.entries.map(entry => ({key:entry.key,value:entry.value}));
    if (restoredInfo) {
      const currentInfo = await storage.loadObject("global").catch(() => []);
      const merged = Array.isArray(currentInfo) ? currentInfo.slice() : [];
      for (const entry of entries) {
        if (entry.key === "global") continue;
        const id = Number(entry.key.slice(4));
        if (Object.prototype.hasOwnProperty.call(restoredInfo, id)) merged[id] = restoredInfo[id];
        else delete merged[id];
      }
      entries.find(entry => entry.key === "global").value =
        await storage.jsonToZip(await storage.objectToJson(merged));
    }
    const before = [];
    for (const entry of entries) before.push({key:entry.key,
      value:await storage.exists(entry.key) ? await storage.loadZip(entry.key) : null});
    try {
      for (const entry of entries) await storage.saveZip(entry.key, entry.value);
      for (const entry of entries) {
        if (await storage.loadZip(entry.key) !== entry.value) throw new Error("MZ save restore verification failed");
      }
      await manager.loadGlobalInfo();
    } catch (error) {
      for (const entry of before) {
        if (entry.value === null) await storage.remove(entry.key);
        else await storage.saveZip(entry.key, entry.value);
      }
      await manager.loadGlobalInfo();
      throw error;
    }
    return {restored:snapshot.entries.length};
  }

  async function mzForageDelete(filename) {
    const name = String(filename || "").replace(/\.rmmzsave$/, "");
    if (!/^file\d{1,4}$/.test(name)) throw new Error("invalid MZ save slot");
    const storage = window.StorageManager, manager = window.DataManager;
    if (!await storage.exists(name)) throw new Error("本地存档不存在");
    const old = await storage.loadZip(name), info = await storage.loadObject("global").catch(() => []);
    const previousInfo = requireJsonEx().stringify(info || []);
    try {
      await storage.remove(name);
      if (await storage.exists(name)) throw new Error("游戏未删除本地存档");
      delete info[Number(name.slice(4))];
      await storage.saveObject("global", info);
      await manager.loadGlobalInfo();
    } catch (error) {
      await storage.saveZip(name, old);
      await storage.saveObject("global", requireJsonEx().parse(previousInfo));
      await manager.loadGlobalInfo();
      throw error;
    }
    return {name:filename, deleted:true};
  }

  async function mzForageLoad(id) {
    const manager = window.DataManager, storage = window.StorageManager;
    const name = manager.makeSavename(id);
    if (!await storage.exists(name)) throw new Error(`未找到本地存档 ${id}`);
    const contents = await storage.loadObject(name);
    manager.createGameObjects();
    manager.extractSaveContents(contents);
    if (typeof manager.correctDataErrors === "function") manager.correctDataErrors();
    return true;
  }
