  // TH-renamed MV family (for example 重装归途). Publish live aliases before
  // hooks and commands resolve engine objects. Loading/new-game replaces the
  // source globals, so copying their current values would retain stale saves.
  function publishRenamedEngine() {
    const thFamily = typeof window.ThGem_Player === "function" && typeof window.ThSce_Map === "function" &&
      ("$thNewGmPl" in window) && ("$thNewGmPr" in window);
    const ftFamily = typeof window.Game_Player === "function" && typeof window.Scene_Map === "function" &&
      ("$ftGmPl" in window) && ("$ftGmPr" in window) && ("$newTkIt" in window);
    if (!thFamily && !ftFamily) return false;
    const aliases = thFamily ? {
      "$gameSystem": "$thNewGmSy", "$gameScreen": "$thNewGmSc",
      "$gameTimer": "$thNewGmTm", "$gameMessage": "$thNewGmMe",
      "$gameSwitches": "$thNewGmSw", "$gameVariables": "$thNewGmVr",
      "$gameSelfSwitches": "$thNewGmSeSw", "$gameActors": "$thNewGmAc",
      "$gameParty": "$thNewGmPr", "$gameTroop": "$thNewGmTr",
      "$gameMap": "$thNewGmMp", "$gamePlayer": "$thNewGmPl",
      "$dataActors": "$thNewDtAc", "$dataClasses": "$thNewDtCs",
      "$dataSkills": "$thNewDtSk", "$dataItems": "$thNewDtIt",
      "$dataWeapons": "$thNewDtWp", "$dataArmors": "$thNewDtAr",
      "$dataEnemies": "$thNewDtEn", "$dataTroops": "$thNewDtTr",
      "$dataStates": "$thNewDtSt", "$dataMap": "$thNewDtMp",
      "$dataMapInfos": "$thNewDtMpIf", "BattleManager": "ThBtData"
    } : {
      "$gamePlayer": "$ftGmPl", "$gameParty": "$ftGmPr", "$gameActors": "$ftGmAc",
      "$gameSwitches": "$ftGmSw", "$gameVariables": "$ftGmVr",
      "$dataActors": "$newTkAc", "$dataClasses": "$newTkCs", "$dataSkills": "$thTkSk",
      "$dataItems": "$newTkIt", "$dataWeapons": "$thTkWp", "$dataArmors": "$thTkAr",
      "$dataEnemies": "$newTkEn", "$dataTroops": "$thTkTr", "$dataStates": "$thTkSt",
      "$dataCommonEvents": "$thTkCom"
    };
    if (thFamily) Object.getOwnPropertyNames(window).forEach(function (name) {
      const match = /^(ThGem_|ThSce_|ThWin_)([A-Za-z0-9_]+)$/.exec(name);
      if (!match || typeof window[name] !== "function") return;
      const prefix = { ThGem_: "Game_", ThSce_: "Scene_", ThWin_: "Window_" }[match[1]];
      aliases[prefix + match[2]] = name;
    });
    Object.keys(aliases).forEach(function (name) {
      const source = aliases[name];
      // Existing globals belong to the game or its plugins. Never replace them.
      if (name in window || !(source in window)) return;
      Object.defineProperty(window, name, {
        configurable: true,
        get: function () { return window[source]; },
        set: function (value) { window[source] = value; }
      });
    });
    const manager = window.SceneManager;
    if (manager) {
      const methods = { goto: "thNewGoto", push: "thNewPush", pop: "thNewPop" };
      Object.keys(methods).forEach(function (name) {
        const source = methods[name];
        if (name in manager || typeof manager[source] !== "function") return;
        Object.defineProperty(manager, name, {
          configurable: true,
          get: function () { return manager[source]; },
          set: function (value) { manager[source] = value; }
        });
      });
    }
    return true;
  }
  publishRenamedEngine();
