// @rmch-iife-open
//
// Bridge prelude: the injection guard and the single mutable state object every
// other part reads. Nothing here touches the game or Node — those come next
// (05-node-io) and after (10-engine), so a failure has an obvious owner.
//
// All parts are fragments of ONE function body, concatenated by
// core/bridge-bundler.mjs. This file opens it; 90-startup.js closes it. The
// bundler asserts that pairing and syntax-checks each part on its own, so an
// unbalanced brace is a build error naming the file, not a blank game window.

(function () {
  if (window.location && String(window.location.href).includes("_generated_background_page.html")) return;
  if (window.__rmchBridge) return;

  const bridge = {
    version: "0.4.0",
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    processed: Object.create(null),
    originals: Object.create(null),

    // Trainer options. Persisted nowhere: the GUI is the source of truth and
    // re-sends them on connect.
    options: {
      expRate: 1,
      goldRate: 1,
      dropRate: 1,
      noSkillCost: false,
      oneHitKill: false,
      invincible: false,
      // "vitals locks" (上帝模式): HP/MP/TP held by method hooks + a guard tick.
      // Distinct from bridge.valueLocks below — see 45-vitals-locks.js.
      lockHp: false,
      lockHpMax: false,
      lockHpVal: 0,
      lockMp: false,
      lockMpVal: 0,
      lockTp: false,
      lockTpVal: 0,
      moveSpeedAdd: 0,
      gameSpeedMulti: 1,
      speedHoldCtrl: false,
      throughWalls: false,
      noEncounter: false,
      showFollowers: true,
      alwaysDash: false
    },

    // Re-entrancy counters. Each is owned by one suppression scope in
    // 20-values.js; a hook that honours a counter must say so in its own file.
    rateDepth: 0,
    suppressRates: 0,
    suppressNoCost: 0,
    suppressInvincible: 0,
    suppressLocks: 0,

    // "value locks" (数据锁定): arbitrary inventory/switch/variable/gold values
    // re-asserted every frame. The GUI owns persistence, the bridge owns the
    // live set — see 50-value-locks.js.
    valueLocks: {
      item: Object.create(null),      // id -> count
      weapon: Object.create(null),
      armor: Object.create(null),
      switch: Object.create(null),    // id -> boolean
      variable: Object.create(null),  // id -> number | string
      gold: null                      // number | null
    },
    lockStats: { applied: 0, lastAt: null, errors: 0 },

    rateStats: Object.create(null),
    battleStats: Object.create(null),
    hookTargets: [],
    hooksPatched: false,
    catalogCache: Object.create(null),
    lastError: null
  };
  window.__rmchBridge = bridge;

  // Command table. Each 6x-commands-*.js part assigns its domain onto this;
  // 69-router.js freezes it and defines execute(). Mirrors the GUI's
  // store-slice pattern (app/gui/ui/store/*.js) on purpose.
  const commandHandlers = Object.create(null);
