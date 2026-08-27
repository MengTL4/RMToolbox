  // ---------------------------------------------------------------------------
  // Value locks (数据锁定).
  //
  // NOT the same feature as 45-vitals-locks.js. An arbitrary set of
  // gold/item/switch/variable values, re-asserted once per frame from the
  // SceneManager.updateMain wrapper. The point is to beat the game itself: a
  // shop that charges gold, an event that consumes an item, a script that flips
  // a switch back. The GUI owns persistence (runtime/locks/<gameKey>.json), the
  // bridge owns the live set — so refreshing the GUI never drops a lock.
  //
  // Writes go to the backing store slot (party._items[3] = 99) rather than
  // through gainItem/setValue: this runs 60x a second, and re-entering the
  // game's own hooks that often is both slow and visible (refresh flicker,
  // "item obtained" side effects).
  // ---------------------------------------------------------------------------

  const LOCKABLE_KINDS = Object.freeze(["item", "weapon", "armor", "switch", "variable"]);

  // Locked values are normalised on the way in, once, so the per-frame loop is
  // a plain comparison. lock.set and lock.replace share this.
  function coerceLockValue(kind, value) {
    if (kind === "switch") return !!value;
    if (kind === "variable") return typeof value === "string" ? value : (Number(value) || 0);
    return Math.max(0, Math.floor(Number(value) || 0));
  }

  // Plain-object copy of the live set, safe to serialise over the wire.
  function snapshotValueLocks() {
    const out = { gold: bridge.valueLocks.gold };
    LOCKABLE_KINDS.forEach((kind) => {
      const table = bridge.valueLocks[kind];
      const copy = {};
      for (const id of Object.keys(table)) copy[id] = table[id];
      out[kind] = copy;
    });
    return out;
  }

  function applyValueLocks() {
    const locks = bridge.valueLocks;
    if (!locks || bridge.suppressLocks > 0) return;

    try {
      if (locks.gold != null) {
        const party = resolveParty();
        if (party) party._gold = Math.max(0, Math.floor(locks.gold));
      }

      for (const [kind, prop] of INVENTORY_SLOTS) {
        const table = locks[kind];
        const ids = Object.keys(table);
        if (!ids.length) continue;
        const party = resolveParty();
        const store = party && party[prop];
        if (!store) continue;
        for (const id of ids) {
          const want = Math.max(0, Math.floor(Number(table[id]) || 0));
          if (Number(store[id]) !== want) store[id] = want;
        }
      }

      // Game_Switches/_Variables._data is a sparse array indexed by id.
      writeLockedSlots(locks.switch, resolveSwitches());
      writeLockedSlots(locks.variable, resolveVariables());

      bridge.lockStats.applied += 1;
      bridge.lockStats.lastAt = Date.now();
    } catch (error) {
      bridge.lockStats.errors += 1;
      noteError(error);
    }
  }

  function writeLockedSlots(table, store) {
    const ids = Object.keys(table);
    if (!ids.length) return;
    const data = store && store._data;
    if (!data) return;
    for (const id of ids) {
      if (data[id] !== table[id]) data[id] = table[id];
    }
  }
