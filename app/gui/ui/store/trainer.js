// Store slice: the trainer's live view of one game — party, actors, maps,
// cheat options — plus the deferred-load machinery every list depends on.

(function () {
  "use strict";

  var store = window.RMCH.store;
  var reactive = Vue.reactive;

  var trainer = reactive({
    gameKey: null,
    options: {},
    live: null,          // last bridge state push: { engine, inBattle, map, gold }
    gold: null,
    party: [],
    roster: [],
    actor: null,
    maps: [],
    mapQuery: "",
    transfer: { mapId: null, x: null, y: null },
    battle: null,
    loading: { party: false, roster: false, maps: false }
  });

  // A freshly-launched game answers commands long before its data layer and
  // party exist (worse on L1/L2/L3 titles), so every list load retries until it
  // returns something. `generation` invalidates in-flight retries when the user
  // switches games; slices ask `isCurrent()` rather than reading the counter.
  var generation = 0;

  function isCurrent(gen) {
    return gen === generation;
  }

  Object.assign(store, {
    trainer: trainer,

    // Retry a load until it yields something, giving up after `attempts`.
    // `alive()` is checked around every await so a game switch cancels cleanly.
    retryLoad: async function (alive, run, isEmpty, attempts, delayMs) {
      for (var attempt = 0; attempt < (attempts || 10); attempt += 1) {
        if (!alive()) return null;
        var payload = await run();
        if (!alive()) return null;
        if (payload && !isEmpty(payload)) return payload;
        await store.sleep(delayMs || 3000);
      }
      return null;
    },

    // Flip a loading flag for the lifetime of a promise.
    tracked: function (flags, key, promise) {
      flags[key] = true;
      return promise.finally(function () { flags[key] = false; });
    },

    noEntries: function (payload) { return !(payload.entries || []).length; },
    noTotal: function (payload) { return !payload.total; }
  });

  function resetTrainer() {
    trainer.options = {};
    trainer.live = null;
    trainer.gold = null;
    trainer.party = [];
    trainer.roster = [];
    trainer.actor = null;
    trainer.maps = [];
    trainer.battle = null;
    Object.keys(trainer.loading).forEach(function (key) { trainer.loading[key] = false; });
  }

  function selectGame(gameKey) {
    generation += 1;
    var gen = generation;
    var alive = function () { return isCurrent(gen); };

    trainer.gameKey = gameKey || null;
    resetTrainer();
    store.resetData();
    if (!trainer.gameKey) return;

    store.cmd("trainer.options.get", {}).then(function (payload) {
      if (payload && alive()) trainer.options = payload.options || {};
    });

    store.tracked(trainer.loading, "party",
      store.retryLoad(alive, function () { return store.cmd("party.info", {}); },
        function (p) { return !(p.members || []).length; })
    ).then(function (p) { if (p && alive()) trainer.party = p.members || []; });

    store.tracked(trainer.loading, "roster",
      store.retryLoad(alive, function () { return store.cmd("catalog.query", { kind: "actor", limit: 20000 }); },
        store.noTotal)
    ).then(function (p) { if (p && alive()) trainer.roster = p.entries || []; });

    store.tracked(trainer.loading, "maps",
      store.retryLoad(alive, function () { return store.cmd("map.list", {}); }, store.noEntries)
    ).then(function (p) { if (p && alive()) trainer.maps = p.entries || []; });

    store.primeData(alive);
  }

  // Re-pull everything a load / new-game invalidates.
  function reloadAfterSceneChange() {
    var gen = generation;
    setTimeout(function () {
      if (!isCurrent(gen)) return;
      refreshParty();
      store.reloadDataAfterSceneChange();
    }, 2000);
  }

  function refreshParty() {
    return store.cmd("party.info", {}).then(function (p) {
      if (p) trainer.party = p.members || [];
      return p;
    });
  }

  function loadRoster() {
    return store.tracked(trainer.loading, "roster",
      store.cmd("catalog.query", { kind: "actor", limit: 20000 }).then(function (p) {
        if (p) trainer.roster = p.entries || [];
        return p;
      }));
  }

  function loadMaps() {
    return store.tracked(trainer.loading, "maps",
      store.cmd("map.list", {}).then(function (p) {
        if (p) trainer.maps = p.entries || [];
        return p;
      }));
  }

  function setOptions(patch) {
    return store.cmd("trainer.options.set", { options: patch }).then(function (p) {
      if (p) trainer.options = p.options || {};
      return p;
    });
  }

  function openActor(id) {
    return store.cmd("actor.info", { id: id }).then(function (p) {
      if (p && p.actor) trainer.actor = p.actor;
      return p;
    });
  }

  function applyActor(payload) {
    if (payload && payload.actor) trainer.actor = payload.actor;
    return payload;
  }

  // Called by the bridge's state push (see store/library.js init).
  function applyLiveState(payload) {
    trainer.live = payload;
    if (payload.gold !== undefined && payload.gold !== null) trainer.gold = payload.gold;
    if (!payload.inBattle) trainer.battle = null;
    store.noteLiveMap(payload.map && payload.map.mapId);
  }

  Object.assign(store, {
    selectGame: selectGame,
    reloadAfterSceneChange: reloadAfterSceneChange,
    refreshParty: refreshParty,
    loadRoster: loadRoster,
    loadMaps: loadMaps,
    setOptions: setOptions,
    openActor: openActor,
    applyActor: applyActor,
    applyLiveState: applyLiveState
  });
})();
