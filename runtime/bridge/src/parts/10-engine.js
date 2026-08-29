  // ---------------------------------------------------------------------------
  // Engine object resolution.
  //
  // RMCH never assumes `$gameParty` is reachable by name: obfuscated/bundled
  // games (L1-L3) rename globals but keep an alias table at `TK.$`. Every
  // engine access in the bridge goes through a resolver here, so adding support
  // for another alias scheme means editing this file only.
  // ---------------------------------------------------------------------------

  function callAlias(name) {
    try {
      const tk = window.TK && window.TK.$;
      const fn = tk && tk[name];
      if (typeof fn === "function") return fn();
      return null;
    } catch (_) {
      return null;
    }
  }

  function tkValue(name) {
    try {
      const tk = window.TK && window.TK.$;
      return tk && tk[name] || null;
    } catch (_) {
      return null;
    }
  }

  // --- $game* singletons ------------------------------------------------------

  function resolveParty() { return callAlias("gameParty") || window.$gameParty || null; }
  function resolveSystem() { return callAlias("gameSystem") || window.$gameSystem || null; }
  function resolveVariables() { return callAlias("gameVariables") || window.$gameVariables || null; }
  function resolveSwitches() { return callAlias("gameSwitches") || window.$gameSwitches || null; }
  function resolveSelfSwitches() { return callAlias("gameSelfSwitches") || window.$gameSelfSwitches || null; }
  function resolveActors() { return callAlias("gameActors") || window.$gameActors || null; }
  function resolveTroop() { return callAlias("gameTroop") || window.$gameTroop || null; }
  function resolveTemp() { return callAlias("gameTemp") || window.$gameTemp || null; }
  function resolveMap() { return callAlias("gameMap") || window.$gameMap || null; }
  function resolvePlayer() { return callAlias("gamePlayer") || window.$gamePlayer || null; }
  function resolveScreen() { return callAlias("gameScreen") || window.$gameScreen || null; }

  function resolveFollowers() {
    const player = resolvePlayer();
    return player && player._followers || null;
  }

  // --- managers ---------------------------------------------------------------

  function resolveSceneManager() {
    return tkValue("SceneMrg") || tkValue("SceneManager") || window.SceneManager || null;
  }

  function resolveSceneMap() {
    return tkValue("SceneMap") || tkValue("Scene_Map") || window.Scene_Map || null;
  }

  function resolveConfigManager() {
    return tkValue("ConfigMrg") || tkValue("ConfigManager") || window.ConfigManager || null;
  }

  function resolveDataManager() {
    return tkValue("DataMrg") || window.DataManager || null;
  }

  function resolveStorageManager() {
    return tkValue("StorageMrg") || window.StorageManager || null;
  }

  function resolveImageManager() {
    return tkValue("ImageMrg") || tkValue("ImageManager") || window.ImageManager || null;
  }

  function resolveBattleManagers() {
    return uniqueTargets([
      { label: "TK.$.BattleMrg", object: tkValue("BattleMrg") },
      { label: "TK.$.BattleManager", object: tkValue("BattleManager") },
      { label: "window.BattleManager", object: window.BattleManager }
    ]);
  }

  // --- $data* tables ----------------------------------------------------------

  // kind -> [TK.$ alias getter, window global]. One table instead of the two
  // parallel maps this used to keep, which could (and did) drift apart.
  const DATA_TABLES = Object.freeze({
    item: ["dataItems", "$dataItems"],
    weapon: ["dataWeapons", "$dataWeapons"],
    armor: ["dataArmors", "$dataArmors"],
    skill: ["dataSkills", "$dataSkills"],
    state: ["dataStates", "$dataStates"],
    actor: ["dataActors", "$dataActors"],
    enemy: ["dataEnemies", "$dataEnemies"],
    troop: ["dataTroops", "$dataTroops"],
    mapInfo: ["dataMapInfos", "$dataMapInfos"],
    commonEvent: ["dataCommonEvents", "$dataCommonEvents"],
    system: ["dataSystem", "$dataSystem"]
  });

  function resolveData(kind) {
    const names = DATA_TABLES[kind];
    if (!names) return null;
    return callAlias(names[0]) || window[names[1]] || null;
  }

  function runtimeDataTable(kind) {
    const runtime = resolveData(kind);
    return Array.isArray(runtime) ? runtime : [];
  }

  // $dataSystem.switches/variables are 1-based name arrays; their length is the
  // editor-declared ceiling, which is what "id out of range" should mean.
  function systemListLimit(kind) {
    try {
      const system = resolveData("system");
      if (!system) return 0;
      if (kind === "variables") return Number(system.variables && system.variables.length || 0);
      if (kind === "switches") return Number(system.switches && system.switches.length || 0);
    } catch (_) {}
    return 0;
  }

  // --- hook targets -----------------------------------------------------------

  // Patch targets are deduplicated by identity, not by label: an alias table
  // and a window global routinely point at the same object, and patching it
  // twice would stack wrappers.
  function uniqueTargets(targets) {
    const seen = [];
    return targets.filter((target) => {
      if (!target || !target.object || seen.includes(target.object)) return false;
      seen.push(target.object);
      return true;
    });
  }

  function resolvePrototypeTargets(globalName, aliases) {
    const candidates = [{ label: `window.${globalName}`, object: window[globalName] }];
    (aliases || []).forEach((name) => candidates.push({ label: `TK.$.${name}`, object: tkValue(name) }));
    return uniqueTargets(candidates
      .map((candidate) => {
        const ctor = candidate.object;
        return ctor && ctor.prototype ? { label: `${candidate.label}.prototype`, object: ctor.prototype } : null;
      }));
  }

  // Bundled games sometimes expose no constructor at all — the only handle on
  // the class is a live instance, so walk its prototype chain instead.
  function runtimePrototypeChainTargets(label, object, maxDepth) {
    const targets = [];
    try {
      let prototype = object && Object.getPrototypeOf(object);
      let depth = 1;
      while (prototype && prototype !== Object.prototype && depth <= maxDepth) {
        targets.push({ label: `${label}.prototype${depth}`, object: prototype });
        prototype = Object.getPrototypeOf(prototype);
        depth += 1;
      }
    } catch (_) {}
    return targets;
  }

  // flatMap one level without Array.prototype.flatMap: MV games on NW.js 0.29
  // (Chromium 65) do not have it, and this runs on the hook hot path for every
  // engine generation.
  function flatMapOne(list, fn) {
    const out = [];
    list.forEach((item, index) => {
      const mapped = fn(item, index);
      for (let i = 0; i < mapped.length; i += 1) out.push(mapped[i]);
    });
    return out;
  }

  function partyMemberPrototypeTargets(label) {
    return flatMapOne(getPartyMembers(resolveParty()), (actor, index) => {
      const actorId = actorIdOf(actor) || index + 1;
      return runtimePrototypeChainTargets(`${label}.actor${actorId}`, actor, 5);
    });
  }

  function troopEnemyPrototypeTargets(label) {
    return flatMapOne(troopEnemies(false), (enemy, index) => {
      let enemyId = index + 1;
      try {
        enemyId = typeof enemy.enemyId === "function" ? enemy.enemyId() : enemy._enemyId || enemyId;
      } catch (_) {}
      return runtimePrototypeChainTargets(`${label}.enemy${enemyId}`, enemy, 5);
    });
  }

  // The player is patched from two angles for the same reason as above.
  // patchMoveSpeed and patchEncounter both want this list.
  function playerPrototypeTargets() {
    const player = resolvePlayer();
    return uniqueTargets([
      { label: "window.Game_Player.prototype", object: window.Game_Player && window.Game_Player.prototype },
      { label: "runtime player chain", object: player && Object.getPrototypeOf(player) }
    ]);
  }

  // --- save directory ---------------------------------------------------------

  function saveDirPath() {
    // Prefer the game's own StorageManager directory; fall back to scanning
    // the common layouts (www/save, save).
    try {
      const storage = resolveStorageManager();
      if (storage && typeof storage.localFileDirectoryPath === "function") {
        const dir = storage.localFileDirectoryPath();
        if (dir) return String(dir);
      }
    } catch (_) {}
    for (const candidate of [path.join(gameRoot, "www", "save"), path.join(gameRoot, "save")]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return path.join(gameRoot, "www", "save");
  }
