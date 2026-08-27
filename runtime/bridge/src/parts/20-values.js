  // ---------------------------------------------------------------------------
  // Value coercion, argument guards, re-entrancy scopes, hook counters.
  //
  // Command args arrive as JSON from the GUI, so every number is "maybe a
  // string, maybe empty, maybe absent". loose* tolerates, require* throws with a
  // message the GUI shows verbatim.
  // ---------------------------------------------------------------------------

  function toBool(value) {
    return value === true || value === "true" || value === 1 || value === "1";
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function looseNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : (fallback || 0);
  }

  function requireNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${label || "value"} must be a number`);
    return number;
  }

  function requireId(value, label) {
    const id = Math.floor(requireNumber(value, label));
    if (id <= 0) throw new Error(`${label || "id"} must be positive`);
    return id;
  }

  // "Was this arg supplied at all?" — the GUI sends "" for a cleared field.
  function hasValue(value) {
    return value !== undefined && value !== null && value !== "";
  }

  function clampCurrentValue(value, maxValue, fallbackMax) {
    const raw = Math.floor(requireNumber(value, "value"));
    const max = Number.isFinite(Number(maxValue)) && Number(maxValue) > 0
      ? Number(maxValue)
      : fallbackMax;
    return Math.min(max, Math.max(0, raw));
  }

  // --- engine-object guards ---------------------------------------------------
  //
  // Commands used to repeat `const p = resolveParty(); if (!p) throw ...` a
  // couple of dozen times, with the message drifting between copies.

  function requireEngineObject(object, label, method) {
    if (!object) throw new Error(`${label} is unavailable`);
    if (method && typeof object[method] !== "function") {
      throw new Error(`${label}.${method} is unavailable`);
    }
    return object;
  }

  function requireParty(method) { return requireEngineObject(resolveParty(), "game party", method); }
  function requirePlayer(method) { return requireEngineObject(resolvePlayer(), "game player", method); }
  function requireMap(method) { return requireEngineObject(resolveMap(), "game map", method); }
  function requireSwitches() { return requireEngineObject(resolveSwitches(), "game switches", "setValue"); }
  function requireVariables() { return requireEngineObject(resolveVariables(), "game variables", "setValue"); }
  function requireSelfSwitches() { return requireEngineObject(resolveSelfSwitches(), "game self switches", "setValue"); }
  function requireSceneManager(method) { return requireEngineObject(resolveSceneManager(), "SceneManager", method); }
  function requireDataManager(method) { return requireEngineObject(resolveDataManager(), "DataManager", method); }

  function requireJsonEx(method) {
    return requireEngineObject(window.JsonEx, "JsonEx", method);
  }

  // --- re-entrancy scopes -----------------------------------------------------
  //
  // A trainer write must not be amplified by the trainer's own hooks: setting
  // gold to 10000 should not run through the goldRate multiplier. Each scope
  // bumps a counter that the matching hook checks. The counter it bumps and the
  // hook that reads it are named the same on purpose — if you add a scope here,
  // grep for its counter and make sure something honours it.

  function suppressionScope(counter) {
    return function (fn) {
      bridge[counter] += 1;
      try {
        return fn();
      } finally {
        bridge[counter] = Math.max(0, bridge[counter] - 1);
      }
    };
  }

  const withRatesSuppressed = suppressionScope("suppressRates");       // 40-hooks: rate multipliers
  const withLocksSuppressed = suppressionScope("suppressLocks");       // 45-vitals + 50-value-locks
  const withNoCostSuppressed = suppressionScope("suppressNoCost");     // 40-hooks: skill cost waiver
  const withInvincibleSuppressed = suppressionScope("suppressInvincible"); // 45-vitals: damage block

  // --- hook counters ----------------------------------------------------------
  //
  // Diagnostics only: "did the exp multiplier actually fire?" is otherwise
  // unanswerable from outside the game process.

  function bumpStat(table, name, payload) {
    table[name] = Number(table[name] || 0) + 1;
    if (payload) table.last = { name, ts: Date.now(), ...payload };
  }

  function bumpRateStat(name, payload) { bumpStat(bridge.rateStats, name, payload); }
  function bumpBattleStat(name, payload) { bumpStat(bridge.battleStats, name, payload); }

  function scaledPositiveAmount(amount, rate) {
    const number = Number(amount);
    if (!Number.isFinite(number) || number <= 0) return amount;
    return Math.max(0, Math.floor(number * rate));
  }

  // --- value shaping for the wire ---------------------------------------------

  // Calls a getter that may not exist / may throw / may return a live engine
  // object. Objects collapse to null because these feed JSON state snapshots,
  // where a Game_Actor reference would either explode or leak the whole graph.
  function safeCall(fn) {
    try {
      const value = fn();
      return typeof value === "object" && value !== null ? null : value;
    } catch (_) {
      return null;
    }
  }

  // console.eval results: depth- and width-limited so a stray `$gameMap` can't
  // serialise a megabyte of tilemap into the response.
  function compactRuntimeValue(value, depth) {
    if (value === null || value === undefined) return value;
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return value.length > 200 ? value.slice(0, 200) + "..." : value;
    if (typeof value === "function") return `[fn ${value.name || "anonymous"}]`;
    if (depth <= 0) return "[object]";
    if (Array.isArray(value)) {
      return {
        type: "array",
        length: value.length,
        items: value.slice(0, 20).map((item) => compactRuntimeValue(item, depth - 1))
      };
    }
    if (typeof value === "object") {
      const output = {};
      Object.keys(value).slice(0, 24).forEach((key) => {
        try {
          output[key] = compactRuntimeValue(value[key], depth - 1);
        } catch (error) {
          output[key] = { error: String(error && error.message || error) };
        }
      });
      return output;
    }
    return String(value);
  }
