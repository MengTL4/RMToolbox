// Store slice: value locks (数据锁定) and the runtime save-data tree (数据修改).
// Both are "reach into the running game's state" features, kept apart from the
// plain read/write lists in store/data.js.

(function () {
  "use strict";

  var store = window.RMCH.store;
  var data = store.data;

  // --- value locks -------------------------------------------------------------

  function applyLockSnapshot(payload) {
    if (!payload || !payload.locks) return;
    data.locks = payload.locks;
    if (payload.stats) data.lockStats = payload.stats;
  }

  function loadLocks() {
    return store.tracked(data.loading, "locks",
      store.cmd("lock.list", {}).then(function (p) {
        applyLockSnapshot(p);
        return p;
      }));
  }

  function isLocked(kind, id) {
    if (kind === "gold") return data.locks.gold != null;
    var table = data.locks[kind];
    return !!(table && Object.prototype.hasOwnProperty.call(table, String(id)));
  }

  function lockedValue(kind, id) {
    if (kind === "gold") return data.locks.gold;
    var table = data.locks[kind];
    return table ? table[String(id)] : undefined;
  }

  function setLock(kind, id, value, enabled) {
    var args = { kind: kind, enabled: enabled !== false };
    if (kind !== "gold") args.id = id;
    if (enabled !== false) args.value = value;
    return store.cmd("lock.set", args).then(function (p) {
      if (!p) return null;
      if (kind === "gold") data.locks.gold = p.enabled ? p.value : null;
      else if (p.enabled) data.locks[kind][String(id)] = p.value;
      else delete data.locks[kind][String(id)];
      return p;
    });
  }

  function clearLocks(kind) {
    return store.cmd("lock.clear", kind ? { kind: kind } : {}).then(function (p) {
      if (p) {
        applyLockSnapshot(p);
        store.ok(kind ? "已清空 " + kind + " 锁定" : "已清空全部锁定");
      }
      return p;
    });
  }

  function saveLockFile() {
    if (!store.trainer.gameKey) return store.warn("先选择一个已连接的游戏");
    try {
      var result = store.server.saveLocks(store.trainer.gameKey, data.locks);
      data.lockFileExists = true;
      store.ok("锁定状态已保存 → " + result.file);
    } catch (error) {
      store.fail("保存锁定状态失败：" + error.message);
    }
  }

  function loadLockFile() {
    if (!store.trainer.gameKey) return store.warn("先选择一个已连接的游戏");
    var saved = null;
    try {
      saved = store.server.loadLocks(store.trainer.gameKey);
    } catch (error) {
      return store.fail("读取锁定状态失败：" + error.message);
    }
    if (!saved) return store.warn("这个游戏还没有保存过锁定状态");
    return store.cmd("lock.replace", { locks: saved }).then(function (p) {
      if (!p) return null;
      applyLockSnapshot(p);
      store.ok("锁定状态已载入并生效");
      return p;
    });
  }

  // --- save-data tree ----------------------------------------------------------

  function loadSaveTree() {
    data.tree.loading = true;
    data.tree.error = null;
    return store.send(store.trainer.gameKey, "save.contents.get", {})
      .then(function (payload) {
        data.tree.json = payload.json;
        data.tree.bytes = payload.bytes;
        store.ok("已拉取存档数据（" + Math.round(payload.bytes / 1024) + " KB）");
        return payload;
      })
      .catch(function (error) {
        data.tree.error = error.message;
        store.fail("拉取存档数据失败：" + error.message);
        return null;
      })
      .finally(function () { data.tree.loading = false; });
  }

  function applySaveTree(json, reload) {
    data.tree.applying = true;
    return store.send(store.trainer.gameKey, "save.contents.apply", { json: json, reload: reload !== false })
      .then(function (payload) {
        data.tree.json = json;
        store.ok("已应用至游戏" + (payload.reloaded ? "（已重载地图）" : "（未重载）"));
        return payload;
      })
      .catch(function (error) {
        store.fail("应用失败：" + error.message);
        return null;
      })
      .finally(function () { data.tree.applying = false; });
  }

  // --- scenes / repair ---------------------------------------------------------

  function pushScene(name) {
    return store.cmd("scene.push", { name: name }).then(function (p) {
      if (p) store.info("已打开 " + name);
      return p;
    });
  }

  function popScene() {
    return store.cmd("scene.pop", {}).then(function (p) {
      if (p) store.info("已弹出场景");
      return p;
    });
  }

  function repair(action, label) {
    return store.cmd("game.repair", { action: action }).then(function (p) {
      if (p) store.ok(label + " 完成");
      return p;
    });
  }

  Object.assign(store, {
    loadLocks: loadLocks,
    isLocked: isLocked,
    lockedValue: lockedValue,
    setLock: setLock,
    clearLocks: clearLocks,
    saveLockFile: saveLockFile,
    loadLockFile: loadLockFile,
    loadSaveTree: loadSaveTree,
    applySaveTree: applySaveTree,
    pushScene: pushScene,
    popScene: popScene,
    repair: repair
  });
})();
