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
  // Compare decoded values first, then use native methods only on change.
  // This preserves custom encoding without repeating refresh/obtained hooks
  // every frame while the locked value is already satisfied.
  // ---------------------------------------------------------------------------

  const LOCKABLE_KINDS = Object.freeze(["item", "weapon", "armor", "switch", "variable"]);

  // Locked values are normalised on the way in, once, so the per-frame loop is
  // a plain comparison. lock.set and lock.replace share this.
  function coerceLockValue(kind, value) {
    if (kind === "switch") return !!value;
    if (kind === "variable") return typeof value === "string" ? value : Math.floor(Number(value) || 0);
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

  function validateInventoryLock(kind, id, value) {
    if (kind !== "item" && kind !== "weapon" && kind !== "armor") return;
    const party = resolveParty();
    const custom = party && customInventory(party);
    if (!custom) return;
    const data = dataEntryLoose(kind, id, party);
    if (!data) throw new Error(`${kind} ${id} not found`);
    custom.validateLock(data, value);
  }

  function storedInventoryId(kind, raw) {
    if (kind !== "item" && kind !== "weapon" && kind !== "armor") return Math.floor(Number(raw));
    const text = String(raw);
    const prefix = { item: "I", weapon: "W", armor: "A" }[kind];
    if (prefix && new RegExp(`^${prefix}\\d+$`).test(text)) return text;
    const number = Number(raw);
    return Number.isFinite(number) ? Math.floor(number) : null;
  }

  function applyValueLocks() {
    const locks = bridge.valueLocks;
    if (!locks || bridge.suppressLocks > 0) return;

    try {
      if (locks.gold != null) {
        const party = resolveParty();
        if (party) {
          let want = Math.max(0, Math.floor(locks.gold));
          if (typeof party.maxGold === "function") {
            const max = Number(party.maxGold());
            if (Number.isFinite(max) && max >= 0) want = Math.min(want, max);
          }
          const current = safeGold(party) || 0;
          if (current !== want) applyGoldDelta(party, want - current, want);
        }
      }

      for (const [kind, prop] of INVENTORY_SLOTS) {
        const table = locks[kind];
        const ids = Object.keys(table);
        if (!ids.length) continue;
        const party = resolveParty();
        const store = party && party[prop];
        if (!party || (!store && !customInventory(party))) continue;
        for (const id of ids) {
          const itemId = storedInventoryId(kind, id);
          if (itemId == null) continue;
          const want = Math.max(0, Math.floor(Number(table[id]) || 0));
          validateInventoryLock(kind, itemId, want);
          const data = dataEntryLoose(kind, itemId, party);
          const current = inventoryCount(party, prop, itemId, data);
          if (current !== want) {
            if (data && typeof party.gainItem === "function") {
              withRatesSuppressed(() => changeInventory(party, data, want - current));
            }
            writeBackItemCount(party, prop, itemId, want, data);
          }
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
      const current = typeof store.value === "function" ? store.value(Number(id)) : data[id];
      if (current === table[id]) continue;
      if (typeof store.setValue === "function") store.setValue(Number(id), table[id]);
      else data[id] = table[id];
    }
  }
