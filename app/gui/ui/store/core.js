// Store core: the reactive roots that every slice shares, the toast/log sink,
// and the two ways to talk to the bridge.
//
// ui/store/*.js each attach their own slice onto RMCH.store. Cross-slice calls
// are made through the assembled store object rather than direct references, so
// load order only has to satisfy "core first" — the rest resolves at call time.

import { getGuiHost } from '../../src/host';
import { createGameDrafts } from '../../src/state/drafts';

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  var reactive = Vue.reactive;
  var computed = Vue.computed;

  // NW resolves page-context require() against the document's directory, so
  // this is app/gui/host.cjs no matter how deep the requiring script sits.
  var server = getGuiHost();

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
    operations: {},      // last visible outcome per game
    selectionEpoch: 0,
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

  var useDraft = createGameDrafts(function () { return store.trainer.gameKey; });
  function selectedCommand(type, args, warn) {
    var key = store.trainer && store.trainer.gameKey;
    var epoch = state.selectionEpoch;
    if (!key || !sessionFor(key)) {
      if (warn) store.warn(key ? "当前游戏已断开，请先重新连接" : "请先选择游戏");
      return Promise.resolve(null);
    }
    return store.send(key, type, args).then(function (payload) {
      return epoch === state.selectionEpoch && key === store.trainer.gameKey && sessionFor(key) ? payload : null;
    }).catch(function (error) {
      log("[命令失败] " + key + " " + type + ": " + error.message);
      if (warn && epoch === state.selectionEpoch) store.warn("操作失败：" + error.message);
      return null;
    });
  }

  var store = {
    server: server,
    state: state,
    viewport: viewport,
    // Editable values are owned by game + field (including entry/actor IDs).
    // Live refreshes supply defaults, never overwrite an edited draft.
    useDraft: useDraft,
    gameDialog: function (dialog) {
      return { warning: function (options) {
        var epoch = state.selectionEpoch;
        var apply = options.onPositiveClick;
        return dialog.warning(Object.assign({}, options, { onPositiveClick: function () {
          if (epoch !== state.selectionEpoch || !store.currentConnected.value) {
            store.warn("当前游戏或连接已变化，请重新发起操作");
            return;
          }
          return apply && apply();
        } }));
      } };
    },

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
      if (!sessionFor(gameKey)) return Promise.reject(new Error("游戏已断开，请先重新连接"));
      return server.send(gameKey, type, args || {});
    },

    // Lenient: resolves to null and logs. The trainer fires dozens of these and
    // a dead bridge should degrade, not throw.
    cmd: function (type, args) {
      return selectedCommand(type, args, false);
    },

    // For user-initiated edits (数据页增删改): same lenient null contract as
    // cmd, but the failure also pops a warning — a silent null there reads
    // exactly like "点了没反应".
    cmdWarn: function (type, args) {
      return selectedCommand(type, args, true);
    },

    readBridgeLog: server.readBridgeLog
  };

  store.liveGameOptions = computed(function () {
    return state.sessions.filter(function (s) { return s.alive; }).map(function (s) {
      return { label: titleFor(s.gameKey) + "（已连接）", value: s.gameKey };
    });
  });
  store.currentConnected = computed(function () { return !!sessionFor(store.trainer && store.trainer.gameKey); });
  store.currentGameOptions = computed(function () {
    var options = store.liveGameOptions.value.slice();
    var key = store.trainer && store.trainer.gameKey;
    if (key && !sessionFor(key)) options.unshift({ label: titleFor(key) + "（已断开）", value: key });
    return options;
  });

  RMCH.store = store;
})();
