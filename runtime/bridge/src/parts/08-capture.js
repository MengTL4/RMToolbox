  // ---------------------------------------------------------------------------
  // Save-contents capture.
  //
  // Closure-sealed shells (nb-evalnwbin) run the whole engine inside an eval'd
  // blob: $gameParty & friends never land on window, so every resolver in
  // 10-engine.js comes back null and the toolbox looks "empty". But the blob
  // shares this realm's intrinsics, and RMMV/MZ routes every save through
  // JSON.stringify (the live singletons) and every load through JSON.parse
  // (objects that extractSaveContents then installs AS the singletons — MV
  // revives them in place via JsonEx setPrototypeOf, MZ's reviver has already
  // run when our wrapper sees them). Patching both lets the bridge hold live
  // engine references the moment the player saves or loads once; 10-engine.js
  // resolvers consult the capture as their last fallback. Inert for normal
  // games: the capture is only written when something save-shaped passes
  // through, and nothing reads it before that.
  //
  // The same parse tap also catches the BOOT-TIME database load: sealed games
  // decrypt Items.json & friends inside the blob and hand the plaintext to
  // JSON.parse. Tables are recognized by shape, kept on window.__rmchDataTables
  // and flushed to catalog-cache.json so later attaches serve catalogs from
  // disk even when the bridge was injected long after boot.
  // ---------------------------------------------------------------------------

  function looksLikeSaveContents(value) {
    return !!(value && typeof value === "object" && !Array.isArray(value)
      && value.system && typeof value.system === "object"
      && (value.party || value.switches || value.variables)
      && (value.map || value.player));
  }

  // A save seen by the stringify tap is either the raw singleton container
  // (custom save paths — LIVE, methods intact) or MV JsonEx's encoded deep
  // copy (DEAD snapshot). A dead copy is still useful for reads when nothing
  // else exists, but must never evict a live capture.
  function captureLooksLive(contents) {
    try {
      const party = contents && contents.party;
      return !!(party && typeof party.gold === "function");
    } catch (_) {
      return false;
    }
  }

  // --- $data* table capture ---------------------------------------------------

  // Database arrays are 1-based with a null hole at index 0; that hole is the
  // cheapest discriminator against plugin/config arrays. Kind is decided by up
  // to three consistent samples. Order: the specific shapes before the looser
  // ones (an armor also has iconIndex/price, so `item`'s itypeId check etc.
  // carry the discrimination — every test names a field only its kind has).
  const DATA_TABLE_SIGNATURES = Object.freeze([
    ["weapon", (e) => e.wtypeId !== undefined && Array.isArray(e.params)],
    ["armor", (e) => e.atypeId !== undefined && e.etypeId !== undefined],
    ["skill", (e) => e.stypeId !== undefined && e.mpCost !== undefined],
    ["item", (e) => e.itypeId !== undefined && e.price !== undefined],
    ["state", (e) => e.restriction !== undefined && e.priority !== undefined],
    ["actor", (e) => e.classId !== undefined && e.nickname !== undefined],
    ["enemy", (e) => e.battlerName !== undefined && e.exp !== undefined],
    ["troop", (e) => Array.isArray(e.members) && Array.isArray(e.pages)],
    ["mapInfo", (e) => e.name !== undefined && e.parentId !== undefined && e.order !== undefined],
    ["commonEvent", (e) => Array.isArray(e.list) && e.trigger !== undefined && e.switchId !== undefined]
  ]);

  function classifyDataTable(value) {
    if (!value || typeof value !== "object") return null;
    if (!Array.isArray(value)) {
      // $dataSystem: the one non-array table. switch/variable NAME arrays are
      // what the 开关/变量 tabs are missing without it.
      if (Array.isArray(value.switches) && Array.isArray(value.variables)
        && (value.terms || value.currencyUnit !== undefined)) return "system";
      return null;
    }
    if (value.length < 2 || value[0] != null) return null;
    let matched = null;
    let samples = 0;
    for (let i = 1; i < value.length && samples < 3; i += 1) {
      const entry = value[i];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      samples += 1;
      const kind = DATA_TABLE_SIGNATURES.find((pair) => {
        try { return pair[1](entry); } catch (_) { return false; }
      });
      if (!kind) return null;
      if (matched && kind[0] !== matched) return null; // mixed array — not a db table
      matched = kind[0];
    }
    return samples > 0 ? matched : null;
  }

  function storeDataTable(kind, table) {
    const tables = window.__rmchDataTables || (window.__rmchDataTables = {});
    // First capture wins for a kind: the boot load is the authoritative one,
    // and a later plugin parse of similar shape must not clobber it.
    if (tables[kind]) return;
    tables[kind] = table;
    log("data table captured", { kind, size: table && table.length || 0 });
    scheduleDataFlush();
  }

  let dataFlushTimer = null;
  function scheduleDataFlush() {
    if (!fileIo || !bridgeDir || dataFlushTimer) return;
    dataFlushTimer = setTimeout(() => {
      dataFlushTimer = null;
      flushDataTables();
    }, 1000);
  }

  function catalogCachePath() {
    return (fileIo && bridgeDir) ? path.join(bridgeDir, "catalog-cache.json") : null;
  }

  function flushDataTables() {
    const file = catalogCachePath();
    if (!file) return;
    try {
      const tables = window.__rmchDataTables;
      if (!tables || !Object.keys(tables).length) return;
      ensureDir();
      // Merge over the existing cache (this boot's captures win): a bridge
      // injected mid-boot catches only the tables parsed after its arrival,
      // and a reload-capture round must never shrink what an earlier round
      // already secured.
      let existing = {};
      try {
        if (fs.existsSync(file)) {
          const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
          existing = (parsed && parsed.tables) || {};
        }
      } catch (_) {}
      const merged = Object.assign({}, existing, tables);
      const payload = { version: 1, capturedAt: new Date().toISOString(), tables: merged };
      fs.writeFileSync(file, JSON.stringify(payload), "utf8");
      log("catalog cache flushed", { kinds: Object.keys(merged) });
    } catch (error) { noteError(error); }
  }

  // Lazy load on first catalog miss: the cache can be several MB, and games
  // that expose $data* on window never need it parsed.
  function loadDataTablesCache() {
    if (window.__rmchDataTablesLoaded) return;
    window.__rmchDataTablesLoaded = true;
    const file = catalogCachePath();
    if (!file) return;
    try {
      if (!fs.existsSync(file)) return;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && parsed.tables && typeof parsed.tables === "object") {
        // Live captures (this boot's parse) take precedence over disk.
        window.__rmchDataTables = Object.assign({}, parsed.tables, window.__rmchDataTables || {});
        log("catalog cache loaded", { kinds: Object.keys(parsed.tables) });
      }
    } catch (error) { noteError(error); }
  }

  function capturedDataTable(kind) {
    try {
      if (!window.__rmchDataTables) loadDataTablesCache();
      const table = window.__rmchDataTables && window.__rmchDataTables[kind];
      if (table && (Array.isArray(table) || typeof table === "object")) return table;
    } catch (_) {}
    return null;
  }

  function installSaveCaptureTap() {
    if (window.__rmchSaveTap) return;
    window.__rmchSaveTap = true;
    // Shape probe, toggled by dropping an empty debug-json.flag file into the
    // bridge-state dir: logs each DISTINCT top-level key signature seen in
    // JSON.parse once (capped). Sealed shells route all their traffic through
    // this tap, and whether anything save-adjacent flows during normal play
    // decides if capture can ever happen without a manual save/load.
    let shapeProbe = null;
    try {
      shapeProbe = (fileIo && bridgeDir
        && fs.existsSync(path.join(bridgeDir, "debug-json.flag")))
        ? { seen: Object.create(null), count: 0 } : null;
    } catch (_) { shapeProbe = null; }
    const stats = bridge.jsonTapStats = { parses: 0, stringifies: 0 };
    const origParse = JSON.parse;
    const origStringify = JSON.stringify;
    JSON.parse = function (text, reviver) {
      const result = origParse.apply(this, arguments);
      stats.parses += 1;
      try {
        if (looksLikeSaveContents(result)) {
          // A load REPLACES the live singletons, so a stale capture would point
          // at dead objects — the parse side always wins (its result becomes
          // the live set once JsonEx decoding finishes).
          if (!window.__rmchCapture) {
            log("save contents captured", { side: "parse", live: captureLooksLive(result) });
          }
          window.__rmchCapture = result;
        } else {
          const kind = classifyDataTable(result);
          if (kind) storeDataTable(kind, result);
          else if (shapeProbe && result && typeof result === "object" && !Array.isArray(result)) {
            const keys = Object.keys(result);
            if (keys.length >= 6) {
              const sig = keys.slice(0, 24).sort().join(",").slice(0, 160);
              if (!shapeProbe.seen[sig] && shapeProbe.count < 40) {
                shapeProbe.seen[sig] = true;
                shapeProbe.count += 1;
                log("json shape", { keys: sig });
              }
            }
          }
        }
      } catch (_) {}
      return result;
    };
    JSON.stringify = function (value, replacer, space) {
      stats.stringifies += 1;
      try {
        if (looksLikeSaveContents(value)
          && (captureLooksLive(value) || !window.__rmchCapture)) {
          if (!window.__rmchCapture) {
            log("save contents captured", { side: "stringify", live: captureLooksLive(value) });
          }
          window.__rmchCapture = value;
        }
      } catch (_) {}
      return origStringify.apply(this, arguments);
    };
    // Some libraries sanity-check arity; keep the originals' signatures.
    try {
      Object.defineProperty(JSON.parse, "length", { value: 2 });
      Object.defineProperty(JSON.stringify, "length", { value: 3 });
    } catch (_) {}
  }

  function capturedEngine(key) {
    try {
      const capture = window.__rmchCapture;
      return (capture && capture[key]) || null;
    } catch (_) {
      return null;
    }
  }

  // The launch/dance bootstrap (core/attach.mjs, bootTap) installs a bare
  // JSON.parse holding-tap before any page script runs — well before the
  // canvas gate lets the full bridge eval. Database tables decrypted during
  // that window pile up in window.__rmchBootParsed; replay them through the
  // real classifier once the bridge is up.
  function replayBootCaptured() {
    try {
      const held = window.__rmchBootParsed;
      if (!Array.isArray(held) || !held.length) return;
      window.__rmchBootParsed = null;
      let replayed = 0;
      held.forEach((value) => {
        if (looksLikeSaveContents(value)) {
          window.__rmchCapture = value;
        } else {
          const kind = classifyDataTable(value);
          if (kind && !(window.__rmchDataTables && window.__rmchDataTables[kind])) {
            storeDataTable(kind, value);
            replayed += 1;
          }
        }
      });
      if (replayed) log("boot capture replayed", { kinds: replayed });
    } catch (error) { noteError(error); }
  }
