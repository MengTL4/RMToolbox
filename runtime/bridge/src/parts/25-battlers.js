  // ---------------------------------------------------------------------------
  // Battlers, party, troop.
  //
  // The recurring hazard: MV exposes hp/level/name as prototype METHODS, MZ as
  // GETTERS, and plugin-heavy games override either. readStat() accepts all
  // three shapes and every accessor here is built on it, so nothing in the
  // bridge should ever read `actor.hp` directly.
  // ---------------------------------------------------------------------------

  function readStat(object, name, fallbackField) {
    try {
      const value = object[name];
      if (typeof value === "function") return value.call(object);
      if (value !== undefined && value !== null) return value;
      return fallbackField ? object[fallbackField] : null;
    } catch (_) {
      return fallbackField ? object[fallbackField] : null;
    }
  }

  function safeGold(party) {
    if (!party) return null;
    try {
      if (typeof party.gold === "function") return party.gold();
      if (typeof party._gold === "number") return party._gold;
    } catch (_) {}
    return null;
  }

  // --- battler identity -------------------------------------------------------

  function isActorBattler(battler) {
    try {
      if (!battler) return false;
      if (typeof battler.isActor === "function") return !!battler.isActor();
      return actorIdOf(battler) != null;
    } catch (_) {
      return false;
    }
  }

  function isEnemyBattler(battler) {
    try {
      return !!(battler && typeof battler.isEnemy === "function" && battler.isEnemy());
    } catch (_) {
      return false;
    }
  }

  function battlerHp(battler) {
    if (!battler) return 0;
    return Math.max(0, Number(readStat(battler, "hp", "_hp")) || 0);
  }

  function setBattlerHp(battler, value) {
    if (!battler) return;
    withLocksSuppressed(() => {
      if (typeof battler.setHp === "function") battler.setHp(value);
      else battler._hp = value;
    });
  }

  // --- battle state -----------------------------------------------------------

  function isInBattle() {
    try {
      const managers = resolveBattleManagers();
      const battle = managers[0] && managers[0].object;
      if (battle && battle._phase && battle._phase !== "init") return true;
    } catch (_) {}
    return false;
  }

  // Rate multipliers apply to battle rewards only — scaling a quest reward or a
  // shop refund by expRate would be indistinguishable from a bug.
  function isInBattleRewardContext() {
    if (bridge.rateDepth > 0) return true;
    try {
      const party = resolveParty();
      if (party && typeof party.inBattle === "function" && party.inBattle()) return true;
    } catch (_) {}
    return isInBattle();
  }

  // --- party ------------------------------------------------------------------

  function getPartyMembers(party) {
    if (!party) return [];
    try {
      if (typeof party.allMembers === "function") return party.allMembers().filter(Boolean);
      if (typeof party.members === "function") return party.members().filter(Boolean);
    } catch (_) {}
    return [];
  }

  function partyBattleMembers() {
    const party = resolveParty();
    if (!party) return [];
    try {
      if (typeof party.battleMembers === "function") return party.battleMembers().filter(Boolean);
    } catch (_) {}
    return getPartyMembers(party).slice(0, 4);
  }

  function requireActor(actorId) {
    const actors = resolveActors();
    let actor = null;
    try {
      if (actors && typeof actors.actor === "function") actor = actors.actor(actorId);
    } catch (_) {}
    // Game_Actors._data is an array in stock RPG Maker but a sparse object in
    // some bundled games.
    if (!actor && actors) {
      const data = actors._data;
      if (Array.isArray(data)) actor = data[actorId];
      else if (data && typeof data === "object") actor = data[actorId];
    }
    if (!actor) throw new Error(`actor ${actorId} is unavailable`);
    return actor;
  }

  function actorIdOf(actor) {
    if (!actor) return null;
    try {
      if (typeof actor.actorId === "function") return actor.actorId();
      return actor._actorId || null;
    } catch (_) {
      return null;
    }
  }

  function actorNameOf(actor) {
    if (!actor) return "";
    try {
      if (typeof actor.name === "function") return actor.name();
      const data = typeof actor.actor === "function" ? actor.actor() : null;
      return data && data.name || actor._name || "";
    } catch (_) {
      return "";
    }
  }

  // --- troop ------------------------------------------------------------------

  function troopEnemies(aliveOnly) {
    const troop = resolveTroop();
    if (!troop) return [];
    let members = [];
    try {
      if (typeof troop.members === "function") members = troop.members().filter(Boolean);
    } catch (_) {}
    if (aliveOnly) {
      members = members.filter((enemy) => {
        try {
          return typeof enemy.isAlive === "function" ? enemy.isAlive() : battlerHp(enemy) > 0;
        } catch (_) {
          return true;
        }
      });
    }
    return members;
  }

  function enemyNameOf(enemy) {
    if (!enemy) return "";
    try {
      if (typeof enemy.name === "function") return String(enemy.name() || "");
      const data = typeof enemy.enemy === "function" ? enemy.enemy() : null;
      if (data && data.name) return String(data.name);
      const id = typeof enemy.enemyId === "function" ? enemy.enemyId() : enemy._enemyId;
      const entry = id ? runtimeDataTable("enemy")[id] : null;
      return entry && entry.name ? String(entry.name) : "";
    } catch (_) {
      return "";
    }
  }

  // --- refresh ----------------------------------------------------------------

  function refreshActor(actor) {
    try {
      if (actor && typeof actor.refresh === "function") actor.refresh();
    } catch (_) {}
  }

  // After a trainer write the on-screen windows still show the old numbers.
  // Refreshing every window the scene owns is blunt but engine-agnostic.
  function refreshMapAndWindows() {
    try {
      const map = resolveMap();
      if (map && typeof map.requestRefresh === "function") map.requestRefresh();
    } catch (_) {}
    try {
      const scene = resolveSceneManager() && resolveSceneManager()._scene;
      if (scene) {
        for (const key of Object.keys(scene)) {
          const child = scene[key];
          if (child && typeof child.refresh === "function") {
            try { child.refresh(); } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }

  // --- actor snapshot ---------------------------------------------------------

  // One actor as plain JSON, for the state snapshot and the 数据 tab's detail
  // editor. Every field is guarded independently: a game that breaks `states()`
  // should still report level and HP, not collapse the whole record to null.
  function actorInfo(actor) {
    if (!actor) return null;

    // arrayField is the id-only fallback (`_skills`, `_states`); omit it where
    // there is no meaningful one (equips are objects, not ids).
    const entryList = (methodName, arrayField) => {
      try {
        if (typeof actor[methodName] === "function") {
          return actor[methodName]().filter(Boolean).map((entry) => ({ id: entry.id, name: entry.name }));
        }
        if (arrayField && Array.isArray(actor[arrayField])) {
          return actor[arrayField].map((id) => ({ id, name: "" }));
        }
      } catch (_) {}
      return [];
    };

    let params = null;
    try {
      if (typeof actor.param === "function") {
        params = [];
        for (let index = 0; index < 8; index += 1) params.push(Number(actor.param(index)) || 0);
      }
    } catch (_) { params = null; }

    let className = null;
    try {
      const klass = typeof actor.currentClass === "function" ? actor.currentClass() : null;
      className = klass && klass.name || null;
    } catch (_) { className = null; }

    return {
      id: actorIdOf(actor),
      name: actorNameOf(actor),
      nickname: typeof actor.nickname === "function" ? safeCall(() => actor.nickname()) : null,
      classId: Number(actor._classId) || null,
      className,
      level: readStat(actor, "level", "_level"),
      maxLevel: typeof actor.maxLevel === "function" ? safeCall(() => actor.maxLevel()) : null,
      exp: typeof actor.currentExp === "function" ? safeCall(() => actor.currentExp()) : null,
      nextLevelExp: typeof actor.nextLevelExp === "function" ? safeCall(() => actor.nextLevelExp()) : null,
      hp: readStat(actor, "hp", "_hp"),
      mhp: readStat(actor, "mhp", "_mhp"),
      mp: readStat(actor, "mp", "_mp"),
      mmp: readStat(actor, "mmp", "_mmp"),
      tp: readStat(actor, "tp", "_tp"),
      maxTp: typeof actor.maxTp === "function" ? safeCall(() => actor.maxTp()) : null,
      params,
      paramPlus: Array.isArray(actor._paramPlus) ? actor._paramPlus.slice() : null,
      skills: entryList("skills", "_skills"),
      states: entryList("states", "_states"),
      equips: entryList("equips")
    };
  }
