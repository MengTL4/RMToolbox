  // FT's TH-BaseSet compares playtime (rendered frames / 60) with wall time.
  // TDDP renders at display refresh rate, so a 144 Hz screen trips its warning
  // even at the toolbox's default speed. Pace only this observed combination.
  // Keep the authored Drill gear and TDDP's wall-clock logic accumulator intact.
  function isNativeFramePacingTarget() {
    if (!("$ftGmPl" in window) || !("$ftGmPr" in window) || !("$newTkIt" in window) ||
        typeof window.Game_Player !== "function" || typeof window.Scene_Map !== "function") return false;
    const plugins = window.$plugins;
    if (!Array.isArray(plugins) || !["TH-BaseSet", "TDDP_FluidTimestep"].every(function (name) {
      return plugins.some(function (plugin) { return plugin && plugin.status === true && plugin.name === name; });
    })) return false;
    return true;
  }

  function patchNativeFramePacing() {
    if (!isNativeFramePacingTarget()) return false;
    const manager = resolveSceneManager();
    if (!manager || typeof manager.requestUpdate !== "function" ||
        !window.performance || typeof window.performance.now !== "function") return false;
    const interval = 1000 / 60;
    let last = null;
    return patchMethod(manager, "update", "SceneManager.update.framePacing", function (original, args) {
      const now = window.performance.now();
      if (last !== null && now >= last && now - last < interval - 0.001) {
        // Use the game's scheduler, including its stopped-state check. Do not
        // create a second RAF loop or modify global timers / requestAnimationFrame.
        return this.requestUpdate();
      }
      if (last === null || now < last || now - last > 1000) last = now;
      else last += Math.max(1, Math.floor((now - last + 0.001) / interval)) * interval;
      return original.apply(this, args);
    });
  }
