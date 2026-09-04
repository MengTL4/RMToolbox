  // ---------------------------------------------------------------------------
  // Trainer hooks.
  //
  // patchMethod stashes every original in bridge.originals, so the whole
  // installation is reversible and a double-patch is impossible. Installers are
  // idempotent by design: patchTrainerHooks() is re-run on a timer while the
  // engine is still defining classes, and again on window load.
  //
  // Vitals (HP/MP/TP) locking lives in 45-vitals-locks.js and per-frame value
  // locking in 50-value-locks.js; this file owns rates, encounters, movement,
  // skill cost, the scene-update wrapper they share, and the corrupt
  // global-save-info guard.
  // ---------------------------------------------------------------------------

  function patchMethod(owner, name, key, wrapper) {
    if (!owner || typeof owner[name] !== "function") return false;
    if (owner[name].__rmchPatched) return true;
    if (!bridge.originals[key]) bridge.originals[key] = owner[name];
    const original = bridge.originals[key];
    const patched = function () {
      return wrapper.call(this, original, arguments);
    };
    Object.defineProperty(patched, "__rmchPatched", { value: true, configurable: true });
    owner[name] = patched;
    return true;
  }

  // --- options ----------------------------------------------------------------

  const RATE_OPTIONS = Object.freeze(["expRate", "goldRate", "dropRate"]);
  const NUMBER_OPTIONS = Object.freeze(["lockHpVal", "lockMpVal", "lockTpVal", "moveSpeedAdd", "gameSpeedMulti"]);
  const BOOL_OPTIONS = Object.freeze([
    "noSkillCost", "oneHitKill", "invincible",
    "lockHp", "lockHpMax", "lockMp", "lockTp",
    "speedHoldCtrl", "throughWalls", "noEncounter", "alwaysDash", "showFollowers"
  ]);

  function setTrainerOptions(options) {
    if (!options || typeof options !== "object") return { ...bridge.options };
    const given = (key) => Object.prototype.hasOwnProperty.call(options, key);

    RATE_OPTIONS.forEach((key) => {
      if (given(key)) bridge.options[key] = clampNumber(options[key], 0, 999, bridge.options[key]);
    });
    NUMBER_OPTIONS.forEach((key) => {
      if (!given(key)) return;
      // gameSpeedMulti multiplies frame time, so below 1 would run the game
      // backwards-ish; the rest may legitimately be negative (moveSpeedAdd).
      const min = key === "gameSpeedMulti" ? 1 : -9999;
      bridge.options[key] = clampNumber(options[key], min, 9999, bridge.options[key]);
    });
    BOOL_OPTIONS.forEach((key) => {
      if (given(key)) bridge.options[key] = toBool(options[key]);
    });

    patchTrainerHooks();
    applyWorldOptions();
    return { ...bridge.options };
  }

  // Options that map to plain game fields rather than method hooks. The game
  // writes these too, so 90-startup re-applies them on a timer.
  function applyWorldOptions() {
    try {
      const player = resolvePlayer();
      if (player && Object.prototype.hasOwnProperty.call(player, "_through")) {
        player._through = !!bridge.options.throughWalls;
      }
      const followers = resolveFollowers();
      if (followers && "_visible" in followers) {
        followers._visible = !!bridge.options.showFollowers;
      }
      const config = resolveConfigManager();
      if (config && "alwaysDash" in config) {
        config.alwaysDash = !!bridge.options.alwaysDash;
      }
    } catch (error) {
      noteError(error);
    }
  }

  // --- movement / encounters --------------------------------------------------

  function patchMoveSpeed() {
    let patched = false;
    playerPrototypeTargets().forEach((target) => {
      if (patchMethod(target.object, "realMoveSpeed", `${target.label}.realMoveSpeed`, function (original, args) {
        const base = Number(original.apply(this, args)) || 0;
        if (!bridge.options.moveSpeedAdd) return base;
        // RPG Maker treats speed as 1..6; outside that range animation breaks.
        return Math.max(1, Math.min(6, base + bridge.options.moveSpeedAdd));
      })) patched = true;
    });
    return patched;
  }

  function patchEncounter() {
    let patched = false;
    playerPrototypeTargets().forEach((target) => {
      if (patchMethod(target.object, "meetsEncounterConditions", `${target.label}.meetsEncounterConditions`, function (original, args) {
        if (bridge.options.noEncounter) return false;
        return original.apply(this, args);
      })) patched = true;
      if (patchMethod(target.object, "encounterProgressValue", `${target.label}.encounterProgressValue`, function (original, args) {
        if (bridge.options.noEncounter) return 0;
        return original.apply(this, args);
      })) patched = true;
    });
    return patched;
  }

  // --- scene update: game speed + value locks ---------------------------------

  // Both concerns share SceneManager.updateMain because patchMethod refuses to
  // wrap the same method twice. Keep them in this order: locks must be
  // re-asserted after the game's own frame has run, not before.
  function patchSceneUpdate() {
    const sceneManager = resolveSceneManager();
    if (!sceneManager) return false;
    return patchMethod(sceneManager, "updateMain", "SceneManager.updateMain", function (original, args) {
      const result = original.apply(this, args);
      if (bridge.options.speedHoldCtrl && bridge.keysHeld && (bridge.keysHeld.control || bridge.keysHeld[17])) {
        const delta = args && args[0];
        if (Number.isFinite(delta)) {
          const extra = delta * (clampNumber(bridge.options.gameSpeedMulti, 1, 20, 1) - 1);
          try { original.call(this, extra); } catch (_) {}
        }
      }
      applyValueLocks();
      return result;
    });
  }

  function hookKeyboard() {
    try {
      if (bridge.keysHooked) return true;
      const setControl = (held) => (domEvent) => {
        if (!bridge.keysHeld) bridge.keysHeld = Object.create(null);
        if (domEvent.key === "Control" || domEvent.keyCode === 17) bridge.keysHeld.control = held;
      };
      // Capture phase: the game installs its own keydown handler and may stop
      // propagation.
      window.addEventListener("keydown", setControl(true), true);
      window.addEventListener("keyup", setControl(false), true);
      bridge.keysHooked = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  // --- corrupt global save-info guard -----------------------------------------
  //
  // global.rpgsave / global.rmmzsave is a cache of slot metadata that
  // DataManager.loadGlobalInfo feeds to the title screen and to
  // selectSavefileForNewGame. A crashed write (or a poisoned Steam Cloud sync)
  // can leave the file decoding to null — 再刷一把2 shipped a 12-byte
  // base64(zlib(msgpack-nil)) global.rpgsave — and both stock engines and
  // custom save systems then die on Object.keys(null) the next time a new game
  // starts: the game is bricked until the file is removed by hand. Catch it
  // here: quarantine the file ONCE (renamed aside, never deleted) so the retry
  // takes the missing-file path every fresh install exercises, and fall back
  // to an empty info object if even that fails. Without the guard the toolbox
  // session survives but the game still crashes the moment the user launches
  // it on its own.
  let globalInfoQuarantined = false;

  function quarantineGlobalInfoFile() {
    // One shot even on failure: a save dir we cannot fix must not put the
    // guard into a rename loop on every frame.
    if (globalInfoQuarantined || !fs || !path) return null;
    globalInfoQuarantined = true;
    try {
      const dir = saveDirPath();
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      for (const name of ["global.rpgsave", "global.rmmzsave"]) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        const dest = `${file}.corrupt-${stamp}`;
        fs.renameSync(file, dest);
        log("corrupt global save info quarantined", { from: file, to: dest });
        return dest;
      }
    } catch (error) {
      noteError(error);
    }
    return null;
  }

  function patchGlobalInfoGuard() {
    const dataManager = resolveDataManager();
    if (!dataManager) return false;
    return patchMethod(dataManager, "loadGlobalInfo", "DataManager.loadGlobalInfo", function (original, args) {
      const callOriginal = () => original.apply(this, args);
      const sanitize = (info) => {
        if (info && typeof info === "object") return info;
        // Custom save systems can decode a present-but-corrupt file to null
        // instead of throwing; quarantine it too, then report empty.
        quarantineGlobalInfoFile();
        return [];
      };
      const recover = (error) => {
        noteError(error);
        if (quarantineGlobalInfoFile()) {
          // File gone: the original now takes its missing-file path.
          try { return sanitize(callOriginal()); } catch (retryError) { noteError(retryError); }
        }
        return [];
      };
      try {
        const result = callOriginal();
        return result && typeof result.then === "function"
          ? result.then(sanitize, recover)
          : sanitize(result);
      } catch (error) {
        return recover(error);
      }
    });
  }

  // --- battle rewards (exp / gold / drop rates) -------------------------------

  // Rewards are recomputed from a cached base, not multiplied in place: this
  // runs on both makeRewards and gainRewards, and multiplying twice would
  // compound the rate (the bug the zs2 modkit hit first).
  function applyRewards(manager) {
    const rewards = manager && manager._rewards;
    if (!rewards) return false;
    if (!rewards.__rmchBaseRewards) {
      const baseRewards = { exp: Number(rewards.exp || 0), gold: Number(rewards.gold || 0) };
      try {
        Object.defineProperty(rewards, "__rmchBaseRewards", { value: baseRewards, configurable: true });
      } catch (_) {
        rewards.__rmchBaseRewards = baseRewards;
      }
    }
    rewards.exp = Math.max(0, Math.floor(rewards.__rmchBaseRewards.exp * bridge.options.expRate));
    rewards.gold = Math.max(0, Math.floor(rewards.__rmchBaseRewards.gold * bridge.options.goldRate));
    bumpRateStat("battleRewards", {
      exp: rewards.exp,
      gold: rewards.gold,
      expRate: bridge.options.expRate,
      goldRate: bridge.options.goldRate
    });
    return true;
  }

  function patchBattleRewards(track) {
    resolveBattleManagers().forEach((target) => {
      track(patchMethod(target.object, "makeRewards", `${target.label}.makeRewards`, function (original, args) {
        const result = original.apply(this, args);
        applyRewards(this);
        return result;
      }), `${target.label}.makeRewards`);
      track(patchMethod(target.object, "gainRewards", `${target.label}.gainRewards`, function (original, args) {
        const scaled = applyRewards(this);
        // The rewards object is already scaled, so the per-actor gainExp /
        // party gainGold hooks below must not scale it a second time.
        return scaled
          ? withRatesSuppressed(() => original.apply(this, args))
          : original.apply(this, args);
      }), `${target.label}.gainRewards`);
    });
  }

  // gainExp / gainGold are also called outside battle (quest rewards, events),
  // where a trainer multiplier would look like corruption. Hence the
  // isInBattleRewardContext guard.
  function patchScaledGain(track, targets, methodName, rateKey, statName) {
    targets.forEach((target) => {
      track(patchMethod(target.object, methodName, `${target.label}.${methodName}`, function (original, args) {
        if (bridge.suppressRates > 0 || bridge.options[rateKey] === 1 || !isInBattleRewardContext()) {
          return original.apply(this, args);
        }
        const next = Array.prototype.slice.call(args);
        const base = Number(next[0] || 0);
        next[0] = scaledPositiveAmount(next[0], bridge.options[rateKey]);
        bumpRateStat(statName, { base, value: next[0], rate: bridge.options[rateKey] });
        return original.apply(this, next);
      }), `${target.label}.${methodName}`);
    });
  }

  function patchDropRate(track) {
    const targets = resolvePrototypeTargets("Game_Enemy", ["GameEnemy"])
      .concat(troopEnemyPrototypeTargets("runtime.troop"));
    targets.forEach((target) => {
      track(patchMethod(target.object, "dropItemRate", `${target.label}.dropItemRate`, function (original, args) {
        const base = Number(original.apply(this, args) || 0);
        const value = Math.max(0, base * bridge.options.dropRate);
        bumpRateStat("dropItemRate", { base, value, rate: bridge.options.dropRate });
        return value;
      }), `${target.label}.dropItemRate`);
    });
  }

  // --- skill cost -------------------------------------------------------------

  function patchSkillCost(track) {
    const targets = resolvePrototypeTargets("Game_BattlerBase", ["GameBattlerBase"])
      .concat(partyMemberPrototypeTargets("runtime.party"));
    // suppressNoCost lets a profile deliberately charge a cost while the option
    // is on (api.helpers.withNoCostSuppressed).
    const waived = (battler) => bridge.suppressNoCost <= 0
      && bridge.options.noSkillCost
      && isActorBattler(battler);

    targets.forEach((target) => {
      track(patchMethod(target.object, "canPaySkillCost", `${target.label}.canPaySkillCost`, function (original, args) {
        if (waived(this)) return true;
        return original.apply(this, args);
      }), `${target.label}.canPaySkillCost`);
      track(patchMethod(target.object, "paySkillCost", `${target.label}.paySkillCost`, function (original, args) {
        if (waived(this)) return;
        return original.apply(this, args);
      }), `${target.label}.paySkillCost`);
      track(patchMethod(target.object, "skillMpCost", `${target.label}.skillMpCost`, function (original, args) {
        if (waived(this)) return 0;
        return original.apply(this, args);
      }), `${target.label}.skillMpCost`);
      track(patchMethod(target.object, "skillTpCost", `${target.label}.skillTpCost`, function (original, args) {
        if (waived(this)) return 0;
        return original.apply(this, args);
      }), `${target.label}.skillTpCost`);
    });
  }

  // --- one-hit kill -----------------------------------------------------------

  function defeatEnemy(battler, source) {
    if (!battler || typeof battler.die !== "function") return false;
    try {
      battler.die();
      bumpBattleStat("oneHitKill", { source });
      return true;
    } catch (_) {
      return false;
    }
  }

  // --- master installer -------------------------------------------------------

  function patchTrainerHooks() {
    const hooked = [];
    const track = (ok, label) => { if (ok) hooked.push(label); };

    hookKeyboard();
    track(patchMoveSpeed(), "moveSpeed");
    track(patchSceneUpdate(), "sceneUpdate");
    track(patchEncounter(), "encounter");
    track(patchGlobalInfoGuard(), "globalInfoGuard");
    patchBattleRewards(track);
    patchScaledGain(
      track,
      resolvePrototypeTargets("Game_Actor", ["GameActor"]).concat(partyMemberPrototypeTargets("runtime.party")),
      "gainExp", "expRate", "actorGainExp"
    );
    patchScaledGain(
      track,
      resolvePrototypeTargets("Game_Party", ["GameParty"]),
      "gainGold", "goldRate", "partyGainGold"
    );
    patchDropRate(track);
    patchDamageHooks(track);
    patchVitalsSetters(track);
    patchSkillCost(track);

    bridge.hookTargets = Array.from(new Set(hooked));
    bridge.hooksPatched = hooked.length > 0;
    return { patched: bridge.hooksPatched, count: hooked.length };
  }
