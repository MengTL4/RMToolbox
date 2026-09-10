  // ---------------------------------------------------------------------------
  // Commands: gold, inventory, party, actors.
  //
  // House rule for every mutation here: go through the engine's own method when
  // it exists (gainGold, gainItem, changeLevel) and fall back to the private
  // field only when it does not. The method keeps the game's bookkeeping
  // consistent; the field is the escape hatch for games that removed it.
  // ---------------------------------------------------------------------------

  function customInventory(party) {
    return typeof resolveCustomInventory === "function" ? resolveCustomInventory(party) : null;
  }

  function inventoryCount(party, prop, id, data) {
    const custom = customInventory(party);
    if (custom && data) return custom.count(data);
    if (data && typeof party.numItems === "function") return Number(party.numItems(data)) || 0;
    return Number(party[prop] && party[prop][id]) || 0;
  }

  function changeInventory(party, data, delta) {
    const custom = customInventory(party);
    if (custom) {
      try { return custom.change(data, delta); }
      finally { refreshMapAndWindows(); }
    }
    return party.gainItem(data, delta);
  }

  function hasEncodedNumberStore(object) {
    return typeof object.thTyZhNumGain === "function" && typeof object.thTyZhNumGet === "function";
  }

  // Verify through the engine: custom games may encode container values.
  // Keep the numeric fallback for stubbed gainItem implementations only.
  function writeBackItemCount(party, prop, id, want, data) {
    if (customInventory(party)) {
      const actual = inventoryCount(party, prop, id, data);
      if (actual !== want) {
        throw new Error(`当前物品数量为 ${actual}，未达到目标 ${want}；请检查背包容量或物品类型限制`);
      }
      return;
    }
    const store = party[prop];
    if (!store) return;
    const now = inventoryCount(party, prop, id, data);
    if (now === want) return;
    if (hasEncodedNumberStore(party) || (store[id] != null && typeof store[id] !== "number")) {
      throw new Error("游戏没有应用目标物品数量，已保留游戏的自定义库存数据");
    }
    if (want > 0) store[id] = want;
    else delete store[id];
    const map = resolveMap();
    if (map && typeof map.requestRefresh === "function") {
      try { map.requestRefresh(); } catch (_) {}
    }
  }

  // Closure-sealed shells (nb-evalnwbin) hide the $data tables, so catalog
  // lookups fail even for items the party already owns. The party's own
  // items()/weapons()/armors() return those very data objects though — fall
  // back to them so owned items stay editable. Adding an item the party does
  // NOT own still needs the catalog and fails with a clear error.
  function ownedItemData(party, kind, id) {
    try {
      const fn = kind === "item" ? "items" : kind === "weapon" ? "weapons" : "armors";
      if (typeof party[fn] === "function") {
        const list = party[fn]() || [];
        for (let i = 0; i < list.length; i += 1) {
          if (list[i] && list[i].id === id) return list[i];
        }
      }
    } catch (_) {}
    return null;
  }

  function dataEntryLoose(kind, id, party) {
    const table = runtimeDataTable(kind);
    if (table[id]) return table[id];
    return ownedItemData(party, kind, id);
  }

  function inventoryId(value, party, kind) {
    // Native independent-item plugins allocate kind-prefixed instance IDs
    // (I###/W###/A###). Accept only an instance actually owned by this party,
    // never an arbitrary key that merely happens to look like an ID.
    const prefix = { item: "I", weapon: "W", armor: "A" }[kind];
    if (prefix && typeof value === "string" && new RegExp(`^${prefix}\\d+$`).test(value) && ownedItemData(party, kind, value)) return value;
    return requireId(value, "id");
  }

  // Custom engines sometimes replace gainGold with a shell that throws or
  // silently no-ops outside their own UI flow (傲世修仙录定制版: the override
  // dies on "Cannot read property 'constructor' of null"). Run the engine path
  // first so clamping/notification still work, but verify the landing value
  // and fall back to a direct container write — same contract as item.set's
  // gainItem verification. A partial move means the engine clamped (kept).
  function applyGoldDelta(party, delta, absolute) {
    const fallback = absolute != null ? absolute : Math.max(0, (safeGold(party) || 0) + delta);
    const plainStore = !hasEncodedNumberStore(party) && (party._gold == null || typeof party._gold === "number");
    const nativeFtGold = typeof isNativeFramePacingTarget === "function" && isNativeFramePacingTarget() &&
      typeof party.thNewGainGold === "function";
    if (typeof party.gainGold !== "function") {
      if (!plainStore) throw new Error("游戏缺少金币修改接口，已保留自定义金币数据");
      party._gold = fallback;
      return;
    }
    const before = safeGold(party) || 0;
    try {
      withRatesSuppressed(() => {
        // FT's native mode is explicit, just like its two-argument gainExp.
        if (nativeFtGold) party.gainGold(delta, true);
        else party.gainGold(delta);
      });
    } catch (error) {
      if (!plainStore || nativeFtGold) throw error;
      party._gold = fallback;
      return;
    }
    if (plainStore && !nativeFtGold && delta !== 0 && (safeGold(party) || 0) === before) party._gold = fallback;
  }

  Object.assign(commandHandlers, {

    // --- gold -----------------------------------------------------------------

    // 增加金币；负数为扣除。倍率在内部被抑制，所以加多少就是多少。
    "gold.add": (args) => {
      const party = requireParty();
      const amount = Math.floor(requireNumber(args.amount, "amount"));
      applyGoldDelta(party, amount);
      return { gold: safeGold(party) };
    },

    // 把金币设成指定数量（最小 0）。按差值走引擎自身的接口，保留游戏的上限与提示。
    "gold.set": (args) => {
      const party = requireParty();
      const value = Math.max(0, Math.floor(requireNumber(args.value, "value")));
      const current = safeGold(party) || 0;
      // Expressed as a delta so the engine's own clamping/notification runs.
      applyGoldDelta(party, value - current, value);
      return { gold: safeGold(party) };
    },

    // --- catalogs -------------------------------------------------------------

    // 按名字或 ID 搜索物品/武器/防具/技能/状态等目录，用于找到要改的 ID。
    "catalog.query": (args) => {
      const kind = String(args.kind || "");
      if (!CATALOG_KINDS.includes(kind)) throw new Error(`unsupported catalog kind: ${kind}`);
      return catalogEntries(kind, { query: args.query, limit: clampNumber(args.limit, 1, LIST_LIMIT_MAX, 500) });
    },

    // --- inventory ------------------------------------------------------------

    // 增加道具。amount 可负；结果为 0 时从背包移除。
    "item.add": (args) => {
      const party = requireParty("gainItem");
      const kind = normalizeDropKind(args.kind || "item");
      if (!kind) throw new Error(`unsupported item kind: ${args.kind}`);
      const id = inventoryId(args.id, party, kind);
      const data = dataEntryLoose(kind, id, party);
      if (!data) throw new Error(`${kind} ${id} not found`);
      const amount = Math.floor(requireNumber(args.amount, "amount"));
      if (!Number.isFinite(amount) || amount === 0) throw new Error("amount must be a non-zero number");
      const prop = inventorySlot(kind);
      const want = Math.max(0, inventoryCount(party, prop, id, data) + amount);
      withRatesSuppressed(() => changeInventory(party, data, amount));
      writeBackItemCount(party, prop, id, want, data);
      return { kind, id, amount, count: inventoryCount(party, prop, id, data) };
    },

    // MTool-style inventory view: everything the party currently owns, with counts.
    "item.list": () => {
      const party = requireParty();
      const custom = customInventory(party);
      if (custom) return { entries: custom.entries() };
      const entries = [];
      for (const [kind, prop] of INVENTORY_SLOTS) {
        const store = party[prop];
        if (!store) continue;
        for (const key of Object.keys(store)) {
          // Counts are integers by engine contract; amplifier plugins in some
          // games stash fractions (2.5 件装备) in the container. Rounding here
          // is display-only — the in-memory value is left untouched.
          const id = Number(key);
          const entry = runtimeDataTable(kind)[id] || ownedItemData(party, kind, id);
          const count = Math.round(inventoryCount(party, prop, id, entry));
          if (count <= 0) continue;
          entries.push({ kind, id, name: entry && entry.name || "", count });
        }
      }
      entries.sort((a, b) => (a.kind === b.kind ? a.id - b.id : a.kind.localeCompare(b.kind)));
      return { entries };
    },

    // 把某件道具的数量设为固定值（0 表示移除）。
    "item.set": (args) => {
      const party = requireParty("gainItem");
      const kind = normalizeDropKind(args.kind || "item");
      if (!kind) throw new Error(`unsupported item kind: ${args.kind}`);
      const id = inventoryId(args.id, party, kind);
      const data = dataEntryLoose(kind, id, party);
      if (!data) throw new Error(`${kind} ${id} not found`);
      const count = Math.max(0, Math.floor(requireNumber(args.count, "count")));
      const prop = inventorySlot(kind);
      const current = inventoryCount(party, prop, id, data);
      const delta = count - current;
      // gainItem first so a working engine keeps its bookkeeping; the writeback
      // then pins the exact count when gainItem is stubbed or scaled.
      if (delta !== 0) withRatesSuppressed(() => changeInventory(party, data, delta));
      writeBackItemCount(party, prop, id, count, data);
      return { kind, id, count: inventoryCount(party, prop, id, data) };
    },

    // --- party ----------------------------------------------------------------

    // 队伍总览：金币、同行成员、参战成员与最大参战人数。
    "party.info": () => {
      const party = resolveParty();
      return {
        gold: safeGold(party),
        members: getPartyMembers(party).map(actorInfo),
        battleMembers: partyBattleMembers().map(actorInfo),
        maxBattleMembers: party && party.maxBattleMembers != null ? safeCall(() => party.maxBattleMembers()) : null
      };
    },

    // 全队恢复到满 HP / MP / TP 并清除状态。
    "party.recover": () => {
      const members = getPartyMembers(resolveParty());
      members.forEach((actor) => {
        if (typeof actor.recoverAll === "function") actor.recoverAll();
        else {
          withLocksSuppressed(() => {
            setBattlerHp(actor, Number(readStat(actor, "mhp", "_mhp")) || 9999);
            if (typeof actor.setMp === "function") actor.setMp(Number(readStat(actor, "mmp", "_mmp")) || 9999);
          });
        }
        if (isNativeFramePacingTarget() && typeof actor.setMp === "function") {
          withLocksSuppressed(() => actor.setMp(Number(readStat(actor, "mmp", "_mmp")) || 0));
        }
        refreshActor(actor);
      });
      refreshMapAndWindows();
      return { recovered: members.length, members: members.map(actorInfo) };
    },

    // 把某角色加入队伍；id 是 $dataActors 里的角色 ID。
    "party.addActor": (args) => {
      const party = requireParty("addActor");
      const { id } = requireDataEntry("actor", args.id, "actor id");
      party.addActor(id);
      refreshMapAndWindows();
      return { id, actor: actorInfo(requireActor(id)) };
    },

    // 把某角色移出队伍（不影响角色自身数据）。
    "party.removeActor": (args) => {
      const party = requireParty("removeActor");
      const id = Math.floor(requireNumber(args.id, "id"));
      party.removeActor(id);
      refreshMapAndWindows();
      return { id };
    },

    // --- actors ---------------------------------------------------------------

    // 单个角色的详细状态：等级、经验、HP/MP/TP、属性、技能与状态。
    "actor.info": (args) => ({ actor: actorInfo(requireActor(requireNumber(args.id, "id"))) }),

    // 单个角色回满。注意部分游戏的原生 recoverAll 不含 MP，这里会一并补上。
    "actor.recover": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      if (typeof actor.recoverAll === "function") actor.recoverAll();
      // FT's recoverAll restores HP/states only. The toolbox full recovery also
      // restores its exposed MP value through the native setter.
      if (isNativeFramePacingTarget() && typeof actor.setMp === "function") {
        withLocksSuppressed(() => actor.setMp(Number(readStat(actor, "mmp", "_mmp")) || 0));
      }
      refreshActor(actor);
      refreshMapAndWindows();
      return { actor: actorInfo(actor) };
    },

    // 设置等级（上限取角色 maxLevel，默认 999），经验与属性按引擎规则重算。
    "actor.level.set": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      let maxLevel = 999;
      try {
        if (typeof actor.maxLevel === "function") maxLevel = Math.max(1, Math.floor(Number(actor.maxLevel() || maxLevel)));
      } catch (_) {}
      const level = Math.min(maxLevel, Math.max(1, Math.floor(requireNumber(args.level, "level"))));
      // FT uses per-level EXP and updates its native level record only through
      // thTyChangeExp/levelNewUp. Stock changeLevel leaves that record stale.
      if (typeof isNativeFramePacingTarget === "function" && isNativeFramePacingTarget() &&
          typeof actor.thTyChangeExp === "function" && typeof actor.levelNewUp === "function") {
        if (level < actor.level) throw new Error("当前游戏的原生等级接口不支持降级");
        withRatesSuppressed(() => {
          while (actor.level < level) {
            const before = actor.level, threshold = Number(actor.nextLevelExp());
            if (!Number.isFinite(threshold) || threshold <= 0) throw new Error("游戏升级经验阈值无效");
            actor.thTyChangeExp(threshold, false, true);
            if (actor.level <= before || actor.level > level) throw new Error("游戏未按原生等级规则完成升级");
          }
        });
      } else if (typeof actor.changeLevel === "function") actor.changeLevel(level, false);
      else actor._level = level;
      refreshActor(actor);
      refreshMapAndWindows();
      return { actor: actorInfo(actor) };
    },

    // 增加经验值，允许因此升级（不会降级）。
    "actor.exp.add": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const amount = Math.floor(requireNumber(args.amount, "amount"));
      if (typeof actor.gainExp === "function") withRatesSuppressed(() => {
        // FT's gainExp(exp, nativeMode) replaces the stock one-argument API.
        // Its omitted/false branch calls an unavailable function; true performs the
        // native EXP update, including its own level bookkeeping.
        if (typeof isNativeFramePacingTarget === "function" && isNativeFramePacingTarget() &&
            typeof actor.thTyChangeExp === "function") actor.gainExp(amount, true);
        else actor.gainExp(amount);
      });
      else if (typeof actor.changeExp === "function" && typeof actor.currentExp === "function") {
        actor.changeExp(actor.currentExp() + amount, false);
      } else {
        actor._exp = actor._exp || {};
        const classId = actor._classId || 0;
        actor._exp[classId] = Number(actor._exp[classId] || 0) + amount;
      }
      refreshActor(actor);
      refreshMapAndWindows();
      return { actor: actorInfo(actor), amount };
    },

    // 设置 HP / MP / TP；只处理传入的字段，数值自动夹在 0..上限 之间。
    "actor.vitals.set": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      // Vitals locks would immediately undo these writes, hence the suppression.
      const write = (value, max, fallbackMax, setter, field) => {
        if (!hasValue(value)) return;
        const next = clampCurrentValue(value, max, fallbackMax);
        withLocksSuppressed(() => {
          if (typeof actor[setter] === "function") actor[setter](next);
          else actor[field] = next;
        });
      };
      write(args.hp, readStat(actor, "mhp", "_mhp"), 999999999, "setHp", "_hp");
      write(args.mp, readStat(actor, "mmp", "_mmp"), 999999999, "setMp", "_mp");
      write(args.tp, 100, 100, "setTp", "_tp");
      refreshActor(actor);
      refreshMapAndWindows();
      return { actor: actorInfo(actor) };
    },

    // 给基础属性加点：paramId 0..7 依次为 最大HP/最大MP/攻击/防御/魔攻/魔防/敏捷/幸运。
    "actor.param.add": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const paramId = Math.floor(requireNumber(args.paramId, "paramId"));
      if (paramId < 0 || paramId > 7) throw new Error("paramId must be between 0 and 7");
      const value = Math.floor(requireNumber(args.value, "value"));
      const readParam = () => [
        typeof actor.param === "function" ? actor.param(paramId) : null,
        typeof actor.paramPlus === "function" ? actor.paramPlus(paramId) : null,
        actor._paramPlus && actor._paramPlus[paramId]
      ];
      const before = readParam();
      if (typeof actor.addParam === "function") actor.addParam(paramId, value);
      else {
        actor._paramPlus = actor._paramPlus || [0, 0, 0, 0, 0, 0, 0, 0];
        actor._paramPlus[paramId] = Number(actor._paramPlus[paramId] || 0) + value;
      }
      if (typeof thParameterMethods !== "undefined" && thParameterMethods.has(actor.paramPlus) &&
          before.every((entry, index) => entry === readParam()[index])) {
        actor._paramPlus = actor._paramPlus || [0, 0, 0, 0, 0, 0, 0, 0];
        actor._paramPlus[paramId] = Number(actor._paramPlus[paramId] || 0) + value;
      }
      refreshActor(actor);
      const after = readParam();
      if (value !== 0 && before.every((entry, index) => entry === after[index])) {
        throw new Error("游戏没有应用这次数值变化，可能受自定义属性规则或上限限制");
      }
      refreshMapAndWindows();
      return { actor: actorInfo(actor), paramId, value };
    },

    // 改名。
    "actor.name.set": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const name = String(args.name || "");
      if (typeof actor.setName === "function") actor.setName(name);
      else actor._name = name;
      refreshMapAndWindows();
      return { actor: actorInfo(actor) };
    },

    // 设置称号（仅带称号系统的游戏有效）。
    "actor.nickname.set": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const nickname = String(args.nickname == null ? "" : args.nickname);
      if (typeof actor.setNickname === "function") actor.setNickname(nickname);
      else actor._nickname = nickname;
      refreshMapAndWindows();
      return { actor: actorInfo(actor) };
    },

    // 转职；keepExp 默认 true 保留当前经验。原生规则决定职业的游戏会明确拒绝。
    "actor.class.set": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const classId = requireId(args.classId, "classId");
      const classes = runtimeDataTable("class");
      if (classes.length && !classes[classId]) throw new Error(`class ${classId} not found`);
      if (typeof actor.changeClass !== "function") throw new Error("actor.changeClass is unavailable");
      if (isNativeFramePacingTarget() && actor._thExpFxgGetNum && typeof actor.currentExp === "function") {
        const party = resolveParty();
        if (!party || typeof party.fhZhNumGain !== "function") throw new Error("当前游戏的职业经验初始化接口不可用");
        // Native changeClass copies the numeric experience but omits its
        // per-class record. Use the same writer as native gainExp before the
        // class switch validates the target's experience.
        const exp = args.keepExp !== false ? actor.currentExp() : Number(actor._exp && actor._exp[classId]) || 0;
        party.fhZhNumGain(exp, 1, actor, classId);
      }
      actor.changeClass(classId, args.keepExp !== false);
      refreshActor(actor);
      refreshMapAndWindows();
      const info = actorInfo(actor);
      if (info.classId != null && info.classId !== classId) {
        if (typeof actor._zwEnsureClass_Multi === "function") {
          throw new Error("该角色的职业由原生专武规则决定，暂不支持直接切换到所选职业");
        }
        throw new Error(`职业切换未生效：请求 ${classId}，实际 ${info.classId}`);
      }
      return { actor: info };
    },

    // 学会技能；skillId 必须是 $dataSkills 里存在的技能。
    "actor.skill.learn": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const { id: skillId } = requireDataEntry("skill", args.skillId, "skillId");
      if (typeof actor.learnSkill !== "function") throw new Error("actor learnSkill is unavailable");
      actor.learnSkill(skillId);
      refreshActor(actor);
      refreshMapAndWindows();
      return { actor: actorInfo(actor), skillId };
    },

    // 遗忘技能。
    "actor.skill.forget": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const { id: skillId } = requireDataEntry("skill", args.skillId, "skillId");
      if (typeof actor.forgetSkill !== "function") throw new Error("actor forgetSkill is unavailable");
      actor.forgetSkill(skillId);
      refreshActor(actor);
      refreshMapAndWindows();
      return { actor: actorInfo(actor), skillId };
    },

    // 附加状态；stateId 是 $dataStates 里的 ID。
    "actor.state.add": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const stateId = Math.floor(requireNumber(args.stateId, "stateId"));
      if (typeof actor.addState !== "function") throw new Error("actor.addState is unavailable");
      // Each manual command is a new native action. Otherwise removedStates
      // from a prior remove can make isStateAddable reject a later re-add.
      if (typeof actor.clearResult === "function") actor.clearResult();
      actor.addState(stateId);
      refreshActor(actor);
      return { actor: actorInfo(actor) };
    },

    // 解除状态。
    "actor.state.remove": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const stateId = Math.floor(requireNumber(args.stateId, "stateId"));
      if (typeof actor.removeState !== "function") throw new Error("actor.removeState is unavailable");
      if (typeof actor.clearResult === "function") actor.clearResult();
      actor.removeState(stateId);
      refreshActor(actor);
      return { actor: actorInfo(actor) };
    }
  });
