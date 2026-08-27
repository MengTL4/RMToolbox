  // ---------------------------------------------------------------------------
  // Commands: gold, inventory, party, actors.
  //
  // House rule for every mutation here: go through the engine's own method when
  // it exists (gainGold, gainItem, changeLevel) and fall back to the private
  // field only when it does not. The method keeps the game's bookkeeping
  // consistent; the field is the escape hatch for games that removed it.
  // ---------------------------------------------------------------------------

  Object.assign(commandHandlers, {

    // --- gold -----------------------------------------------------------------

    "gold.add": (args) => {
      const party = requireParty();
      const amount = Math.floor(requireNumber(args.amount, "amount"));
      if (typeof party.gainGold === "function") withRatesSuppressed(() => party.gainGold(amount));
      else party._gold = Math.max(0, Number(party._gold || 0) + amount);
      return { gold: safeGold(party) };
    },

    "gold.set": (args) => {
      const party = requireParty();
      const value = Math.max(0, Math.floor(requireNumber(args.value, "value")));
      const current = safeGold(party) || 0;
      // Expressed as a delta so the engine's own clamping/notification runs.
      if (typeof party.gainGold === "function") withRatesSuppressed(() => party.gainGold(value - current));
      else party._gold = value;
      return { gold: safeGold(party) };
    },

    // --- catalogs -------------------------------------------------------------

    "catalog.query": (args) => {
      const kind = String(args.kind || "");
      if (!CATALOG_KINDS.includes(kind)) throw new Error(`unsupported catalog kind: ${kind}`);
      return catalogEntries(kind, { query: args.query, limit: clampNumber(args.limit, 1, 2000, 500) });
    },

    // --- inventory ------------------------------------------------------------

    "item.add": (args) => {
      const party = requireParty("gainItem");
      const kind = normalizeDropKind(args.kind || "item");
      if (!kind) throw new Error(`unsupported item kind: ${args.kind}`);
      const { id } = requireDataEntry(kind, args.id, "id");
      const amount = Math.floor(requireNumber(args.amount, "amount"));
      if (!Number.isFinite(amount) || amount === 0) throw new Error("amount must be a non-zero number");
      withRatesSuppressed(() => party.gainItem(runtimeDataTable(kind)[id], amount));
      return { kind, id, amount };
    },

    // MTool-style inventory view: everything the party currently owns, with counts.
    "item.list": () => {
      const party = requireParty();
      const entries = [];
      for (const [kind, prop] of INVENTORY_SLOTS) {
        const store = party[prop];
        if (!store) continue;
        for (const key of Object.keys(store)) {
          const count = Number(store[key]) || 0;
          if (count <= 0) continue;
          const id = Number(key);
          const entry = runtimeDataTable(kind)[id];
          entries.push({ kind, id, name: entry && entry.name || "", count });
        }
      }
      entries.sort((a, b) => (a.kind === b.kind ? a.id - b.id : a.kind.localeCompare(b.kind)));
      return { entries };
    },

    "item.set": (args) => {
      const party = requireParty("gainItem");
      const kind = normalizeDropKind(args.kind || "item");
      if (!kind) throw new Error(`unsupported item kind: ${args.kind}`);
      const { id } = requireDataEntry(kind, args.id, "id");
      const count = Math.max(0, Math.floor(requireNumber(args.count, "count")));
      const prop = inventorySlot(kind);
      const current = Number(party[prop] && party[prop][id]) || 0;
      const delta = count - current;
      // gainItem handles both directions (and clamps at 0 when equipped gear
      // can't be taken); report the resulting truth, not the request.
      if (delta !== 0) withRatesSuppressed(() => party.gainItem(runtimeDataTable(kind)[id], delta));
      return { kind, id, count: Number(party[prop] && party[prop][id]) || 0 };
    },

    // --- party ----------------------------------------------------------------

    "party.info": () => {
      const party = resolveParty();
      return {
        gold: safeGold(party),
        members: getPartyMembers(party).map(actorInfo),
        battleMembers: partyBattleMembers().map(actorInfo),
        maxBattleMembers: party && party.maxBattleMembers != null ? safeCall(() => party.maxBattleMembers()) : null
      };
    },

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
        refreshActor(actor);
      });
      refreshMapAndWindows();
      return { recovered: members.length, members: members.map(actorInfo) };
    },

    "party.addActor": (args) => {
      const party = requireParty("addActor");
      const { id } = requireDataEntry("actor", args.id, "actor id");
      party.addActor(id);
      refreshMapAndWindows();
      return { id, actor: actorInfo(requireActor(id)) };
    },

    "party.removeActor": (args) => {
      const party = requireParty("removeActor");
      const id = Math.floor(requireNumber(args.id, "id"));
      party.removeActor(id);
      refreshMapAndWindows();
      return { id };
    },

    // --- actors ---------------------------------------------------------------

    "actor.info": (args) => ({ actor: actorInfo(requireActor(requireNumber(args.id, "id"))) }),

    "actor.recover": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      if (typeof actor.recoverAll === "function") actor.recoverAll();
      refreshActor(actor);
      refreshMapAndWindows();
      return { actor: actorInfo(actor) };
    },

    "actor.level.set": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      let maxLevel = 999;
      try {
        if (typeof actor.maxLevel === "function") maxLevel = Math.max(1, Math.floor(Number(actor.maxLevel() || maxLevel)));
      } catch (_) {}
      const level = Math.min(maxLevel, Math.max(1, Math.floor(requireNumber(args.level, "level"))));
      // changeLevel(level, false) = no level-up message spam.
      if (typeof actor.changeLevel === "function") actor.changeLevel(level, false);
      else actor._level = level;
      refreshActor(actor);
      refreshMapAndWindows();
      return { actor: actorInfo(actor) };
    },

    "actor.exp.add": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const amount = Math.floor(requireNumber(args.amount, "amount"));
      if (typeof actor.gainExp === "function") withRatesSuppressed(() => actor.gainExp(amount));
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

    "actor.param.add": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const paramId = Math.floor(requireNumber(args.paramId, "paramId"));
      if (paramId < 0 || paramId > 7) throw new Error("paramId must be between 0 and 7");
      const value = Math.floor(requireNumber(args.value, "value"));
      if (typeof actor.addParam === "function") actor.addParam(paramId, value);
      else {
        actor._paramPlus = actor._paramPlus || [0, 0, 0, 0, 0, 0, 0, 0];
        actor._paramPlus[paramId] = Number(actor._paramPlus[paramId] || 0) + value;
      }
      refreshActor(actor);
      refreshMapAndWindows();
      return { actor: actorInfo(actor), paramId, value };
    },

    "actor.name.set": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const name = String(args.name || "");
      if (typeof actor.setName === "function") actor.setName(name);
      else actor._name = name;
      refreshMapAndWindows();
      return { actor: actorInfo(actor) };
    },

    "actor.nickname.set": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const nickname = String(args.nickname == null ? "" : args.nickname);
      if (typeof actor.setNickname === "function") actor.setNickname(nickname);
      else actor._nickname = nickname;
      refreshMapAndWindows();
      return { actor: actorInfo(actor) };
    },

    "actor.class.set": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const classId = Math.floor(requireNumber(args.classId, "classId"));
      if (typeof actor.changeClass !== "function") throw new Error("actor.changeClass is unavailable");
      actor.changeClass(classId, args.keepExp !== false);
      refreshActor(actor);
      refreshMapAndWindows();
      return { actor: actorInfo(actor) };
    },

    "actor.skill.learn": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const { id: skillId } = requireDataEntry("skill", args.skillId, "skillId");
      if (typeof actor.learnSkill !== "function") throw new Error("actor learnSkill is unavailable");
      actor.learnSkill(skillId);
      refreshActor(actor);
      refreshMapAndWindows();
      return { actor: actorInfo(actor), skillId };
    },

    "actor.skill.forget": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const { id: skillId } = requireDataEntry("skill", args.skillId, "skillId");
      if (typeof actor.forgetSkill !== "function") throw new Error("actor forgetSkill is unavailable");
      actor.forgetSkill(skillId);
      refreshActor(actor);
      refreshMapAndWindows();
      return { actor: actorInfo(actor), skillId };
    },

    "actor.state.add": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const stateId = Math.floor(requireNumber(args.stateId, "stateId"));
      if (typeof actor.addState !== "function") throw new Error("actor.addState is unavailable");
      actor.addState(stateId);
      refreshActor(actor);
      return { actor: actorInfo(actor) };
    },

    "actor.state.remove": (args) => {
      const actor = requireActor(requireNumber(args.id, "id"));
      const stateId = Math.floor(requireNumber(args.stateId, "stateId"));
      if (typeof actor.removeState !== "function") throw new Error("actor.removeState is unavailable");
      actor.removeState(stateId);
      refreshActor(actor);
      return { actor: actorInfo(actor) };
    }
  });
