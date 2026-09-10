// Store slice: save-file backups (zip-free directory copies on the Node side),
// plus the shell/file operations the saves view needs.

(function () {
  "use strict";

  var store = window.RMCH.store;
  var server = store.server;

  async function backupSaves(gameKey) {
    try {
      var result = await server.backupSaves(gameKey);
      store.ok("已备份 " + result.files + " 个文件 → " + result.destDir);
      return result;
    } catch (error) {
      store.fail("备份失败：" + error.message);
      return null;
    }
  }

  function listBackups(gameKey) {
    if (!gameKey) return [];
    try {
      return server.listBackups(gameKey);
    } catch (error) {
      store.fail("读取备份列表失败：" + error.message);
      return [];
    }
  }

  async function restoreBackup(gameKey, name) {
    try {
      var result = await server.restoreBackup(gameKey, name);
      store.ok("已恢复 " + result.restored + " 个文件（" + name + "）");
      return result;
    } catch (error) {
      store.fail("恢复失败：" + error.message);
      return null;
    }
  }

  function deleteBackup(gameKey, name) {
    try {
      server.deleteBackup(gameKey, name);
      store.ok("已删除备份 " + name);
      return true;
    } catch (error) {
      store.fail("删除备份失败：" + error.message);
      return false;
    }
  }

  // The bridge has no slot-delete command; files are local, so the Node side
  // unlinks them from the same directory save.list read.
  async function deleteSaveFile(gameKey, name) {
    try {
      await server.deleteSaveFile(gameKey, name);
      store.ok("已删除 " + name);
      return true;
    } catch (error) {
      store.fail("删除失败：" + error.message);
      return false;
    }
  }

  function backupsDir(gameKey) {
    if (!gameKey || !store.state.projectRoot) return null;
    return store.state.projectRoot + "/backups/" + gameKey;
  }

  // Open an http(s) link in the user's browser. Distinct from openPath, which
  // stats a filesystem path and routes it through nw.Shell.openPath.
  function openExternal(url) {
    try {
      server.openExternal(url);
      return true;
    } catch (error) {
      store.fail("打开链接失败：" + error.message);
      return false;
    }
  }

  function openPath(target) {
    try {
      server.openPath(target);
      return true;
    } catch (error) {
      store.fail("打开目录失败：" + error.message);
      return false;
    }
  }

  Object.assign(store, {
    backupSaves: backupSaves,
    listBackups: listBackups,
    restoreBackup: restoreBackup,
    deleteBackup: deleteBackup,
    deleteSaveFile: deleteSaveFile,
    backupsDir: backupsDir,
    openPath: openPath,
    openExternal: openExternal
  });
})();
