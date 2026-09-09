// Store slice: the game library, launching/stopping, and boot.

(function () {
  "use strict";

  var store = window.RMCH.store;
  var state = store.state;
  var server = store.server;

  function refreshSessions() {
    try {
      updateSessions(server.listSessions());
    } catch (_) {
      updateSessions([]);
    }
  }

  function updateSessions(sessions) {
    var key = store.trainer.gameKey;
    var previous = store.sessionFor(key);
    // Host callbacks may reuse their array/records. Keep a reactive snapshot so
    // a reconnect cannot mutate our previous state without notifying Vue.
    state.sessions = sessions.map(function (session) { return Object.assign({}, session); });
    var next = store.sessionFor(key);
    if (key && (!!previous !== !!next || (previous && next && previous.connectedAt !== next.connectedAt))) {
      store.selectGame(key);
    }
  }

  async function operate(game, kind, run) {
    var key = game.gameKey;
    if (state.busy[key]) return null;
    state.busy[key] = kind;
    state.operations[key] = { kind: kind, status: "pending", text: kind === "stopping" ? "正在结束游戏…" : "正在等待游戏连接，部分游戏需要约一分钟…" };
    try {
      var summary = await run();
      if (summary && summary.pid) state.pids[key] = summary.pid;
      if (kind === "stopping") delete state.pids[key];
      // RGSS/EVB images (宝可梦赤途: a 2.9GB tree) keep the window black for a
      // minute while the engine loads, and the bridge is up long before that —
      // without this the working trainer next to a black window looks like a
      // failed launch.
      if (kind === "launching" && summary && /rgss|evb/.test(summary.strategy || "")) {
        store.info(game.title + "：游戏本体正在加载，窗口会先黑屏 1–2 分钟，属正常；工具箱显示「游戏加载中」时请等待标题画面。");
      }
      state.operations[key] = { kind: kind, status: "success", text: kind === "stopping" ? "游戏已停止" : "接入步骤已完成，正在确认连接…" };
      return summary;
    } catch (error) {
      state.operations[key] = { kind: kind, status: "error", text: error.message };
      store.fail(game.title + "：" + error.message);
      return null;
    } finally {
      delete state.busy[key];
      refreshSessions();
    }
  }

  function refreshLibrary() {
    state.scanning = true;
    try {
      state.games = server.listLibrary();
      state.routePlans = {};
      state.games.forEach(function (game) {
        try {
          state.routePlans[game.gameKey] = server.plan(game.root, "auto");
        } catch (error) {
          state.routePlans[game.gameKey] = { selected: null, candidates: [], error: error.message };
        }
      });
    } catch (error) {
      store.fail("库扫描失败：" + error.message);
      state.games = [];
      state.routePlans = {};
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

  async function launch(game, strategy) {
    // A Tauri launch takes several seconds (boot grace before the CDP link);
    // ignore extra clicks while one is in flight instead of piling up
    // concurrent launches.
    var selected = strategy || state.routeChoices[game.gameKey] || "auto";
    return operate(game, "launching", function () { return server.launch(game.root, selected); });
  }

  // Attach to a game the user started themselves. The summary carries the main
  // process pid (NW) or the game pid (RGSS) so the stop button keeps working.
  async function attach(game) {
    return operate(game, "attaching", function () { return server.attach(game.root); });
  }

  async function stop(game) {
    if (state.busy[game.gameKey]) return null;
    var pid = state.pids[game.gameKey];
    if (!pid) {
      store.warn(game.title + "：本次会话没有记录它的 PID（可能不是从这里启动的）");
      return;
    }
    return operate(game, "stopping", function () { return server.stop(pid); });
  }

  async function init() {
    server.setHandlers({
      onLog: function (line) { store.log(line); },
      onState: function (gameKey, payload) {
        if (gameKey === store.trainer.gameKey && payload) store.applyLiveState(payload);
      },
      onSessions: updateSessions
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
