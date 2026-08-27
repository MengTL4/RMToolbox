  // ---------------------------------------------------------------------------
  // Vitals locks (上帝模式: 无敌 / 锁HP·MP·TP).
  //
  // NOT the same feature as 50-value-locks.js. This one holds a battler's
  // HP/MP/TP through two mechanisms, because neither alone is enough:
  //   1. setHp/setMp/setTp hooks — catch the engine's own writes.
  //   2. a 100ms guard tick — catch plugins that assign `actor._hp` directly.
  // Both honour bridge.suppressLocks so a deliberate trainer write still lands.
  // ---------------------------------------------------------------------------

  // Null means "not locked". lockHpMax tracks the (possibly buffed) max, so it
  // is re-read every time rather than cached.
  function lockedHpValue(battler) {
    if (bridge.options.lockHpMax) return Number(readStat(battler, "mhp", "_mhp")) || 0;
    if (bridge.options.lockHpVal > 0) return bridge.options.lockHpVal;
    return null;
  }

  function lockedVitalValue(option) {
    const value = Number(bridge.options[option]) || 0;
    return value > 0 ? value : null;
  }

  // Shared body of the three setter hooks: rewrite the argument to the locked
  // value instead of blocking the call, so the engine's own bookkeeping
  // (death checks, gauge refresh) still runs.
  function enforceVital(battler, original, args, locked, statName) {
    if (bridge.suppressLocks > 0 || locked == null) return original.apply(battler, args);
    const requested = Number(args[0]);
    if (Number.isFinite(requested) && requested !== locked) {
      bumpBattleStat(statName, { from: requested, to: locked });
      return original.call(battler, locked);
    }
    return original.apply(battler, args);
  }

  function shouldBlockHpDecrease(battler, value) {
    if (bridge.suppressInvincible <= 0 && bridge.options.invincible) {
      // Invincibility is battle-only on purpose: out of battle, HP loss is
      // usually a scripted story beat and blocking it wedges events.
      if (isActorBattler(battler) && isInBattle()) {
        const next = Number(value);
        if (Number.isFinite(next) && next < battlerHp(battler)) return true;
      }
    }
    if (bridge.options.lockHp && isActorBattler(battler)) {
      const locked = lockedHpValue(battler);
      const next = Number(value);
      if (locked != null && Number.isFinite(next) && next < locked) return true;
    }
    return false;
  }

  // --- hooks ------------------------------------------------------------------

  function patchVitalsSetters(track) {
    const targets = uniqueTargets(
      resolvePrototypeTargets("Game_Battler", ["GameBattler"])
        .concat(resolvePrototypeTargets("Game_BattlerBase", ["GameBattlerBase"]))
        .concat(resolvePrototypeTargets("Game_Actor", ["GameActor"]))
        .concat(partyMemberPrototypeTargets("runtime.party"))
    );
    targets.forEach((target) => {
      track(patchMethod(target.object, "setHp", `${target.label}.setHp`, function (original, args) {
        if (shouldBlockHpDecrease(this, args[0])) {
          const keep = bridge.options.lockHp ? lockedHpValue(this) : battlerHp(this);
          bumpBattleStat("invincibleBlockHp", { source: target.label, value: args[0], current: keep });
          return original.call(this, keep);
        }
        if (bridge.options.lockHp && isActorBattler(this)) {
          return enforceVital(this, original, args, lockedHpValue(this), "lockHp");
        }
        return original.apply(this, args);
      }), `${target.label}.setHp`);

      track(patchMethod(target.object, "setMp", `${target.label}.setMp`, function (original, args) {
        if (bridge.options.lockMp && isActorBattler(this)) {
          return enforceVital(this, original, args, lockedVitalValue("lockMpVal"), "lockMp");
        }
        return original.apply(this, args);
      }), `${target.label}.setMp`);

      track(patchMethod(target.object, "setTp", `${target.label}.setTp`, function (original, args) {
        if (bridge.options.lockTp && isActorBattler(this)) {
          return enforceVital(this, original, args, lockedVitalValue("lockTpVal"), "lockTp");
        }
        return original.apply(this, args);
      }), `${target.label}.setTp`);
    });
  }

  // Game_Action.apply is where damage is dealt. Snapshot HP before, restore
  // after: a plugin's custom damage formula may bypass setHp entirely.
  function patchDamageHooks(track) {
    resolvePrototypeTargets("Game_Action", ["GameAction"]).forEach((target) => {
      track(patchMethod(target.object, "apply", `${target.label}.apply`, function (original, args) {
        const subject = typeof this.subject === "function" ? this.subject() : null;
        const targetBattler = args && args[0];
        const hpSnapshot = (bridge.options.invincible || bridge.options.lockHp) && isActorBattler(targetBattler)
          ? battlerHp(targetBattler)
          : null;
        const result = original.apply(this, args);
        if (hpSnapshot != null) restoreLockedHp(targetBattler, hpSnapshot, `${target.label}.apply`);
        if (bridge.options.oneHitKill && isActorBattler(subject) && isEnemyBattler(targetBattler)) {
          defeatEnemy(targetBattler, `${target.label}.apply`);
        }
        return result;
      }), `${target.label}.apply`);

      track(patchMethod(target.object, "executeHpDamage", `${target.label}.executeHpDamage`, function (original, args) {
        const targetBattler = args && args[0];
        const value = Number(args && args[1] || 0);
        const shielded = bridge.options.invincible
          || (bridge.options.lockHp && lockedHpValue(targetBattler) != null);
        if (value > 0 && isActorBattler(targetBattler) && shielded) {
          const next = Array.prototype.slice.call(args);
          next[1] = 0;
          bumpBattleStat("invincibleDamage", { source: target.label, value });
          return original.apply(this, next);
        }
        return original.apply(this, args);
      }), `${target.label}.executeHpDamage`);
    });
  }

  function restoreLockedHp(battler, snapshot, source) {
    if (!isActorBattler(battler) || !Number.isFinite(snapshot)) return false;
    let target = snapshot;
    if (bridge.options.lockHp) {
      const locked = lockedHpValue(battler);
      if (locked != null) target = Math.max(target, locked);
    }
    const current = battlerHp(battler);
    if (current >= target) return false;
    setBattlerHp(battler, target);
    refreshActor(battler);
    bumpBattleStat("lockedHpRestore", { source, from: current, to: target });
    return true;
  }

  // --- guard tick -------------------------------------------------------------

  // MP and TP share one shape; HP does not, because lockHpMax makes its target
  // value dynamic and setBattlerHp has its own fallback path.
  const GUARDED_VITALS = Object.freeze([
    { option: "lockMp", valueOption: "lockMpVal", getter: "mp", field: "_mp", setter: "setMp" },
    { option: "lockTp", valueOption: "lockTpVal", getter: "tp", field: "_tp", setter: "setTp" }
  ]);

  function preserveVitalsTick() {
    try {
      if (bridge.suppressLocks > 0) return;
      partyBattleMembers().forEach((actor) => {
        // Note: invincibility needs no tick — it only ever blocks a decrease,
        // and the setHp/executeHpDamage hooks already cover that.
        if (bridge.options.lockHp) {
          const locked = lockedHpValue(actor);
          if (locked != null && battlerHp(actor) !== locked) setBattlerHp(actor, locked);
        }
        GUARDED_VITALS.forEach((spec) => {
          if (!bridge.options[spec.option]) return;
          const want = lockedVitalValue(spec.valueOption);
          if (want == null) return;
          const current = Number(actor[spec.getter] == null ? actor[spec.field] : actor[spec.getter]) || 0;
          if (current === want) return;
          withLocksSuppressed(() => {
            if (typeof actor[spec.setter] === "function") actor[spec.setter](want);
            else actor[spec.field] = want;
          });
        });
      });
    } catch (error) {
      noteError(error);
    }
  }
