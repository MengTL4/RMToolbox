// Store slice: the 数据 tab — full item/weapon/armor catalogs with live counts,
// switches/variables, self switches, value locks, scenes, map events, and the
// runtime save-data tree.

(function () {
  "use strict";

  var store = window.RMCH.store;
  var reactive = Vue.reactive;
  var ITEM_KINDS = store.ITEM_KINDS;

  function emptyLocks() {
    return { item: {}, weapon: {}, armor: {}, switch: {}, variable: {}, gold: null };
  }

  var data = reactive({
    tab: "item",
    selected: {
      item: null, weapon: null, armor: null,
      switch: null, variable: null, actor: null, event: null
    },
    query: {
      item: "", weapon: "", armor: "",
      switch: "", variable: "", actor: "", event: ""
    },
    // Every entry the game defines (from $dataX), with the owned count merged in.
    catalog: { item: [], weapon: [], armor: [] },
    counts: { item: {}, weapon: {}, armor: {} },
    // Switch / variable lists, keyed the same way so one loader serves both.
    flags: { switch: [], variable: [] },
    // Self switches are map-scoped, so they live with the map view.
    selfSwitches: { mapId: null, entries: [] },
    events: [],            // common events
    mapEvents: [],         // events on the player's current map
    scenes: [],
    locks: emptyLocks(),
    lockStats: null,
    lockFileExists: false,
    tree: { json: null, bytes: 0, error: null, loading: false, applying: false },
    loading: {
      catalog: false, counts: false, flags: false, selfSwitches: false,
      events: false, mapEvents: false, locks: false
    }
  });

  function resetData() {
    ITEM_KINDS.forEach(function (kind) {
      data.catalog[kind] = [];
      data.counts[kind] = {};
    });
    Object.keys(data.selected).forEach(function (key) { data.selected[key] = null; });
    data.flags.switch = [];
    data.flags.variable = [];
    data.selfSwitches = { mapId: null, entries: [] };
    data.events = [];
    data.mapEvents = [];
    data.scenes = [];
    data.locks = emptyLocks();
    data.lockStats = null;
    data.lockFileExists = false;
    data.tree.json = null;
    data.tree.bytes = 0;
    data.tree.error = null;
    Object.keys(data.loading).forEach(function (key) { data.loading[key] = false; });
  }

  // Kicked off by selectGame: the catalogs come from $data* so they resolve as
  // soon as the game's data layer is up, with the same retry treatment.
  function primeData(alive) {
    store.tracked(data.loading, "catalog", Promise.all(ITEM_KINDS.map(function (kind) {
      return store.retryLoad(alive,
        function () { return store.cmd("catalog.query", { kind: kind, limit: 20000 }); },
        store.noTotal
      ).then(function (p) { if (p && alive()) data.catalog[kind] = p.entries || []; });
    })));

    store.tracked(data.loading, "flags", Promise.all(["switch", "variable"].map(function (kind) {
      return store.retryLoad(alive,
        function () { return store.cmd(kind === "switch" ? "switch.list" : "variable.list", { offset: 1, limit: 20000 }); },
        store.noEntries
      ).then(function (p) { if (p && alive()) data.flags[kind] = p.entries || []; });
    })));

    loadCounts();
    store.loadLocks();
    loadScenes();
    loadCommonEvents();

    try {
      data.lockFileExists = !!store.server.hasLocks(store.trainer.gameKey);
    } catch (_) {
      data.lockFileExists = false;
    }
  }

  function reloadDataAfterSceneChange() {
    loadCounts();
    loadFlags("switch");
    loadFlags("variable");
  }

  // Remember the map the player is on, so the self-switch view has a default.
  function noteLiveMap(mapId) {
    if (mapId != null && data.selfSwitches.mapId == null) data.selfSwitches.mapId = mapId;
  }

  // --- items ------------------------------------------------------------------

  function loadCatalog(kind) {
    return store.tracked(data.loading, "catalog",
      store.cmd("catalog.query", { kind: kind, limit: 20000 }).then(function (p) {
        if (p) data.catalog[kind] = p.entries || [];
        return p;
      }));
  }

  function loadCounts() {
    return store.tracked(data.loading, "counts",
      store.cmd("item.list", {}).then(function (p) {
        if (!p) return null;
        var next = { item: {}, weapon: {}, armor: {} };
        (p.entries || []).forEach(function (entry) {
          if (next[entry.kind]) next[entry.kind][entry.id] = entry.count;
        });
        ITEM_KINDS.forEach(function (kind) { data.counts[kind] = next[kind]; });
        return p;
      }));
  }

  function countOf(kind, id) {
    var table = data.counts[kind];
    return (table && table[id]) || 0;
  }

  function setItemCount(kind, id, count) {
    return store.cmd("item.set", { kind: kind, id: id, count: Math.max(0, Math.floor(count)) })
      .then(function (p) {
        if (p) data.counts[p.kind][p.id] = p.count;
        return p;
      });
  }

  // --- switches / variables / self switches ------------------------------------

  function loadFlags(kind) {
    return store.tracked(data.loading, "flags",
      store.cmd(kind === "switch" ? "switch.list" : "variable.list", { offset: 1, limit: 20000 })
        .then(function (p) {
          if (p) data.flags[kind] = p.entries || [];
          return p;
        }));
  }

  function setFlag(kind, id, value) {
    return store.cmd(kind === "switch" ? "switch.set" : "variable.set", { id: id, value: value })
      .then(function (p) {
        if (!p) return null;
        var list = data.flags[kind];
        for (var i = 0; i < list.length; i += 1) {
          if (list[i].id === p.id) { list[i].value = p.value; break; }
        }
        return p;
      });
  }

  // Only switches an event has actually written show up here — RPG Maker stores
  // self switches sparsely, keyed by "mapId,eventId,letter".
  function loadSelfSwitches(mapId) {
    var target = mapId != null ? mapId : data.selfSwitches.mapId;
    if (target == null) {
      data.selfSwitches.entries = [];
      return Promise.resolve(null);
    }
    data.selfSwitches.mapId = target;
    return store.tracked(data.loading, "selfSwitches",
      store.cmd("selfSwitch.list", { mapId: target }).then(function (p) {
        if (p) data.selfSwitches.entries = p.entries || [];
        return p;
      }));
  }

  function setSelfSwitch(row, value) {
    return store.cmd("selfSwitch.set", {
      mapId: data.selfSwitches.mapId, eventId: row.eventId, letter: row.letter, value: value
    }).then(function (p) {
      if (p) row.value = p.value;
      return p;
    });
  }

  // --- map / common events -----------------------------------------------------

  function loadMapEvents() {
    return store.tracked(data.loading, "mapEvents",
      store.cmd("map.events.list", {}).then(function (p) {
        if (p) data.mapEvents = p.entries || [];
        return p;
      }));
  }

  function loadCommonEvents() {
    return store.tracked(data.loading, "events",
      store.cmd("catalog.query", { kind: "commonEvent", limit: 20000 }).then(function (p) {
        if (p) data.events = p.entries || [];
        return p;
      }));
  }

  function loadScenes() {
    return store.cmd("scene.info", {}).then(function (p) {
      if (p) data.scenes = p.available || [];
      return p;
    });
  }

  Object.assign(store, {
    data: data,
    resetData: resetData,
    primeData: primeData,
    reloadDataAfterSceneChange: reloadDataAfterSceneChange,
    noteLiveMap: noteLiveMap,

    loadCatalog: loadCatalog,
    loadCounts: loadCounts,
    countOf: countOf,
    setItemCount: setItemCount,

    loadFlags: loadFlags,
    setFlag: setFlag,
    loadSelfSwitches: loadSelfSwitches,
    setSelfSwitch: setSelfSwitch,

    loadMapEvents: loadMapEvents,
    loadCommonEvents: loadCommonEvents,
    loadScenes: loadScenes
  });
})();
