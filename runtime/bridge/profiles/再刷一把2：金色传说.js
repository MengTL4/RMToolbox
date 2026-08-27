// Profile for 再刷一把2：金色传说 (gameKey: 再刷一把2：金色传说).
// Demonstrates the RMCH profile API: game-specific commands and options on
// top of the generic bridge. The generic core works without any profile.

module.exports = function (api) {
  const { bridge, registerCommands, registerOptions, resolve, helpers, paths } = api;
  const { log, clampNumber } = helpers;

  registerOptions({
    // zs2-specific trainer extras (all default off).
    dropRate: bridge.options.dropRate
  });

  registerCommands({
    // Switch 520 in this game triggers the punishment common event; the
    // modkit-era guard keeps it off to avoid the "小黑屋" prison map.
    "zs2.prisonGuard": (args) => {
      const switches = resolve.switches();
      if (!switches || typeof switches.setValue !== "function") {
        throw new Error("game switches are unavailable");
      }
      const enabled = args.enabled === undefined ? true : !!args.enabled;
      if (enabled) {
        switches.setValue(520, false);
      }
      return { enabled, switch520: switches.value(520) };
    },

    // Convenience: batch heal + full MP for the whole battle party.
    "zs2.battleReady": () => {
      const members = helpers.partyBattleMembers();
      let healed = 0;
      members.forEach((actor) => {
        if (typeof actor.recoverAll === "function") actor.recoverAll();
        helpers.refreshActor(actor);
        healed += 1;
      });
      helpers.refreshMapAndWindows();
      return { healed, members: members.map(helpers.actorInfo) };
    }
  });

  log("zs2 profile registered", { commands: ["zs2.prisonGuard", "zs2.battleReady"] });
};
