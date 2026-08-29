// Store slice: the game library, launching/stopping, and boot.

(function () {
  "use strict";

  var store = window.RMCH.store;
  var state = store.state;
  var server = store.server;

  function refreshSessions() {
    try {
      state.sessions = server.listSessions();
    } catch (_) {
      state.sessions = [];
    }
  }

  function refreshLibrary() {
    state.scanning = true;
    try {
      state.games = server.listLibrary();
    } catch (error) {
      store.fail("库扫描失败：" + error.message);
      state.games = [];
    } finally {
      state.scanning = false;
    }
    refreshIcons();
    refreshSessions();
  }

  // Each card shows the game's own icon when it ships one. Read once per scan —
  // these are small files and the library is a handful of entries.
  function refreshIcons() {
    state.icons = {};
    state.games.forEach(function (game) {
      try {
        var icon = server.gameIcon(game.root);
        if (icon) state.icons[game.gameKey] = icon;
      } catch (_) {}
    });
  }

  function addManualRoot(root) {
    try {
      var entry = server.addManualRoot(root);
      store.ok("已添加 " + entry.title);
      refreshLibrary();
      return entry;
    } catch (error) {
      store.fail("添加失败 " + root + "：" + error.message);
      return null;
    }
  }

  function removeManualRoot(root) {
    server.removeManualRoot(root);
    refreshLibrary();
  }

  async function launch(game) {
    state.busy[game.gameKey] = "launching";
    try {
      var summary = await server.launch(game.root);
      state.pids[summary.gameKey] = summary.pid;
      store.ok(summary.game + " 已启动（策略 " + summary.strategy + "，pid " + summary.pid + "）");
      return summary;
    } catch (error) {
      store.fail("启动失败 " + game.title + "：" + error.message);
      return null;
    } finally {
      delete state.busy[game.gameKey];
      refreshSessions();
    }
  }

  // Attach to a game the user started themselves. The summary carries the main
  // process pid (NW) or the game pid (RGSS) so the stop button keeps working.
  async function attach(game) {
    state.busy[game.gameKey] = "attaching";
    try {
      var summary = await server.attach(game.root);
      if (summary.pid) state.pids[summary.gameKey] = summary.pid;
      store.ok(summary.game + " 已附加（策略 " + summary.strategy + "）");
      return summary;
    } catch (error) {
      store.fail("附加失败 " + game.title + "：" + error.message);
      return null;
    } finally {
      delete state.busy[game.gameKey];
      refreshSessions();
    }
  }

  async function stop(game) {
    var pid = state.pids[game.gameKey];
    if (!pid) {
      store.warn(game.title + "：本次会话没有记录它的 PID（可能不是从这里启动的）");
      return;
    }
    state.busy[game.gameKey] = "stopping";
    try {
      await server.stop(pid);
      delete state.pids[game.gameKey];
      store.info(game.title + " 已停止");
    } finally {
      delete state.busy[game.gameKey];
      refreshSessions();
    }
  }

  async function init() {
    server.setHandlers({
      onLog: function (line) { store.log(line); },
      onState: function (gameKey, payload) {
        if (gameKey === store.trainer.gameKey && payload) store.applyLiveState(payload);
      },
      onSessions: function (sessions) {
        state.sessions = sessions;
        // A bridge that dropped invalidates the trainer's selection.
        if (store.trainer.gameKey && !store.sessionFor(store.trainer.gameKey)) store.selectGame(null);
      }
    });

    var initial = server.getLog();
    if (initial) state.log = initial.split(/\r?\n/);

    try {
      await server.init();
      var desc = server.describe();
      state.port = desc.port;
      state.about = desc.about || null;
      state.projectRoot = desc.projectRoot || null;
      state.ready = true;
    } catch (error) {
      state.bootError = error.message;
      store.fail("桥接服务器启动失败：" + error.message);
    }

    refreshLibrary();
  }

  Object.assign(store, {
    init: init,
    refreshLibrary: refreshLibrary,
    refreshSessions: refreshSessions,
    addManualRoot: addManualRoot,
    removeManualRoot: removeManualRoot,
    launch: launch,
    attach: attach,
    stop: stop
  });
})();
