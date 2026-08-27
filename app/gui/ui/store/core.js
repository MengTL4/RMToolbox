// Store core: the reactive roots that every slice shares, the toast/log sink,
// and the two ways to talk to the bridge.
//
// ui/store/*.js each attach their own slice onto RMCH.store. Cross-slice calls
// are made through the assembled store object rather than direct references, so
// load order only has to satisfy "core first" — the rest resolves at call time.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  var reactive = Vue.reactive;
  var computed = Vue.computed;

  // NW resolves page-context require() against the document's directory, so
  // this is app/gui/host.cjs no matter how deep the requiring script sits.
  var server = require("./host.cjs");

  var LOG_CAP = 2000;

  var PROTECTION = [
    { label: "L0 明文", type: "success" },
    { label: "L1 数据加密", type: "info" },
    { label: "L2 字节码", type: "warning" },
    { label: "L3 启动保护", type: "error" }
  ];

  var state = reactive({
    ready: false,
    port: null,
    bootError: null,
    about: null,         // host.cjs describe().about — versions/runtime for About
    projectRoot: null,
    games: [],
    icons: {},           // gameKey -> data URL of the game's own icon (www/icon/icon.png)
    scanning: false,
    sessions: [],
    pids: {},
    busy: {},            // gameKey -> "launching" | "stopping"
    log: [],
    logSeq: 0
  });

  // Viewport size, so list panes can size themselves without CSS calc guesswork.
  var viewport = reactive({ width: window.innerWidth, height: window.innerHeight });
  window.addEventListener("resize", function () {
    viewport.width = window.innerWidth;
    viewport.height = window.innerHeight;
  });

  // Feedback surface, injected by the shell once the Naive providers exist.
  var feedback = { message: null, dialog: null };

  function log(line) {
    state.log.push(line);
    if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP);
    state.logSeq += 1;
  }

  function toast(kind, text) {
    log("[" + kind + "] " + text);
    if (feedback.message && feedback.message[kind]) feedback.message[kind](text);
  }

  function sessionFor(gameKey) {
    for (var i = 0; i < state.sessions.length; i += 1) {
      if (state.sessions[i].gameKey === gameKey && state.sessions[i].alive) return state.sessions[i];
    }
    return null;
  }

  function titleFor(gameKey) {
    for (var i = 0; i < state.games.length; i += 1) {
      if (state.games[i].gameKey === gameKey) return state.games[i].title;
    }
    return gameKey;
  }

  var store = {
    server: server,
    state: state,
    viewport: viewport,

    ITEM_KINDS: ["item", "weapon", "armor"],

    // --- feedback ------------------------------------------------------------
    attachFeedback: function (api) {
      feedback.message = api.message || null;
      feedback.dialog = api.dialog || null;
    },
    log: log,
    ok: function (text) { toast("success", text); },
    info: function (text) { toast("info", text); },
    warn: function (text) { toast("warning", text); },
    fail: function (text) { toast("error", text); },

    // --- helpers -------------------------------------------------------------
    sleep: function (ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    },
    sessionFor: sessionFor,
    titleFor: titleFor,
    protectionTag: function (level) {
      return PROTECTION[level] || { label: "L" + level, type: "default" };
    },

    // --- bridge --------------------------------------------------------------

    // Strict: rejects. Use where the caller renders the error itself (console,
    // save-data tree) or needs to distinguish failure from "no game".
    send: function (gameKey, type, args) {
      if (!gameKey) return Promise.reject(new Error("未选择游戏"));
      return server.send(gameKey, type, args || {});
    },

    // Lenient: resolves to null and logs. The trainer fires dozens of these and
    // a dead bridge should degrade, not throw.
    cmd: function (type, args) {
      var gameKey = store.trainer && store.trainer.gameKey;
      if (!gameKey) {
        store.warn("请先选择一个已连接的游戏");
        return Promise.resolve(null);
      }
      return server.send(gameKey, type, args || {}).catch(function (error) {
        log("[命令失败] " + gameKey + " " + type + ": " + error.message);
        return null;
      });
    },

    readBridgeLog: server.readBridgeLog
  };

  store.liveGameOptions = computed(function () {
    return state.sessions.filter(function (s) { return s.alive; }).map(function (s) {
      return { label: titleFor(s.gameKey) + "（已连接）", value: s.gameKey };
    });
  });

  RMCH.store = store;
})();
