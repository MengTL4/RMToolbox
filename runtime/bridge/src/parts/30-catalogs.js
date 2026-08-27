  // ---------------------------------------------------------------------------
  // Catalogs and map data.
  //
  // Item/skill/map lists are read from the game's LIVE data tables, never by
  // decrypting data files: an L1/L2 game decrypts its own JSON at boot, and by
  // the time the bridge is asked for a catalog the plaintext is sitting in
  // memory. Cost: queries before the game finishes loading see a short table,
  // which is what the cache-invalidation rule below exists to survive.
  // ---------------------------------------------------------------------------

  const CATALOG_KINDS = Object.freeze([
    "item", "weapon", "armor", "skill", "state",
    "actor", "enemy", "troop", "mapInfo", "commonEvent"
  ]);

  // Party inventory kind -> Game_Party storage field. Three call sites needed
  // this mapping (item.list, item.set, value-lock writeback) and each used to
  // spell it out inline.
  const INVENTORY_SLOTS = Object.freeze([
    ["item", "_items"],
    ["weapon", "_weapons"],
    ["armor", "_armors"]
  ]);

  function inventorySlot(kind) {
    const found = INVENTORY_SLOTS.find((pair) => pair[0] === kind);
    return found ? found[1] : null;
  }

  function normalizeDropKind(kind) {
    const value = String(kind || "item").toLowerCase();
    return inventorySlot(value) ? value : null;
  }

  function catalogEntries(kind, { query = "", limit = 500 } = {}) {
    const table = runtimeDataTable(kind);
    let cached = bridge.catalogCache[kind];
    // The cache is only valid while the backing table keeps its shape: a
    // catalog queried mid-boot (or before an L1/L2 game decrypts its data)
    // would otherwise freeze the empty list in place for the whole session.
    if (!cached || cached.tableLength !== table.length || !cached.entries.length) {
      const entries = [];
      for (let id = 1; id < table.length; id += 1) {
        const entry = table[id];
        if (!entry) continue;
        entries.push({
          id,
          name: entry.name || "",
          iconIndex: entry.iconIndex != null ? entry.iconIndex : null,
          note: entry.note != null ? String(entry.note).slice(0, 300) : ""
        });
      }
      cached = { tableLength: table.length, entries };
      if (entries.length) bridge.catalogCache[kind] = cached;
    }
    let entries = cached.entries;
    if (query) {
      const lower = String(query).toLowerCase();
      entries = entries.filter((entry) => entry.name.toLowerCase().includes(lower) || String(entry.id) === lower);
    }
    return {
      total: entries.length,
      entries: entries.slice(0, limit).map((entry) => ({ ...entry }))
    };
  }

  function requireDataEntry(kind, id, label) {
    const number = requireId(id, label || `${kind} id`);
    const table = runtimeDataTable(kind);
    const entry = table && table[number];
    if (!entry) throw new Error(`${kind} ${number} not found`);
    return { id: number, entry };
  }

  // --- switches / variables listing -------------------------------------------

  // $dataSystem holds the names, $gameSwitches/$gameVariables hold the values;
  // the GUI wants them zipped, paged.
  function listSystemEntries(kind, args) {
    const system = resolveData("system");
    if (!system) throw new Error("$dataSystem is unavailable");
    const names = kind === "switches" ? system.switches : system.variables;
    if (!Array.isArray(names)) throw new Error(`system ${kind} list is unavailable`);
    const store = kind === "switches" ? resolveSwitches() : resolveVariables();
    const offset = Math.max(0, Math.floor(looseNumber(args.offset, 0)));
    const limit = Math.max(1, Math.min(2000, Math.floor(looseNumber(args.limit, 200))));
    const entries = [];
    const end = Math.min(names.length, offset + limit);
    for (let id = Math.max(1, offset); id < end; id += 1) {
      let value = null;
      try {
        value = store && typeof store.value === "function" ? store.value(id) : null;
      } catch (_) {}
      entries.push({ id, name: names[id] || "", value });
    }
    return { total: Math.max(0, names.length - 1), offset, limit, entries };
  }

  // --- maps -------------------------------------------------------------------

  function currentMapInfo() {
    const map = resolveMap();
    const player = resolvePlayer();
    const mapInfoTable = runtimeDataTable("mapInfo");
    let name = "";
    try {
      const mapId = map && map._mapId;
      const info = mapId != null && mapInfoTable[mapId];
      name = info && info.name || "";
    } catch (_) {}
    return {
      mapId: map ? map._mapId : null,
      mapName: name,
      displayName: map && map._displayName || "",
      x: player ? player._x : null,
      y: player ? player._y : null,
      direction: player ? player._direction : null,
      width: map ? safeCall(() => map.width()) : null,
      height: map ? safeCall(() => map.height()) : null
    };
  }

  function mapList() {
    const table = runtimeDataTable("mapInfo");
    const entries = [];
    for (let id = 1; id < table.length; id += 1) {
      const info = table[id];
      if (!info) continue;
      entries.push({
        id,
        name: info.name || "",
        parentId: info.parentId != null ? info.parentId : null,
        order: info.order != null ? info.order : null
      });
    }
    return { total: entries.length, entries };
  }
