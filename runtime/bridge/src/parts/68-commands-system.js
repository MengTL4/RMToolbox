  // ---------------------------------------------------------------------------
  // Commands: scene navigation and recovery.
  //
  // These exist because a trainer breaks games. Forcing a switch mid-cutscene
  // leaves the interpreter waiting forever; a bad transfer leaves the screen
  // faded out. 修复错误 is the "get me moving again" toolbox, and it deliberately
  // uses the engine's own clear/goto paths rather than reconstructing state.
  // ---------------------------------------------------------------------------

  // Scenes worth pushing from the trainer. Filtered at call time to the ones
  // this game actually defines: MZ drops some, plugins add others.
  const PUSHABLE_SCENES = Object.freeze([
    "Scene_Item", "Scene_Skill", "Scene_Equip", "Scene_Status", "Scene_Menu",
    "Scene_Save", "Scene_Load", "Scene_Options", "Scene_Debug", "Scene_Shop",
    "Scene_Name", "Scene_GameEnd"
  ]);

  function availableScenes() {
    publishNativeMenuScenes();
    return PUSHABLE_SCENES.filter((name) => {
      if (typeof window[name] !== "function") return false;
      // This TH release retains the Debug class name but removes its entire
      // window creation body. Entering it terminates the native game; it is not
      // an available menu. Toolbox switch/variable editing remains independent.
      if (name === "Scene_Debug" && window.ThSce_Debug === window[name]) {
        const create = window[name].prototype && window[name].prototype.create;
        if (typeof create === "function" && /\{ThSce_MenuBase\.prototype\.create\.call\(this\);?\}$/.test(
          Function.prototype.toString.call(create).replace(/\s/g, ""))) return false;
      }
      return true;
    });
  }

  function publishNativeMenuScenes() {
    // TK releases rename these constructors but keep the native menu handlers.
    // Capture the constructor passed by the handler synchronously; no scene is
    // instantiated, pushed or rendered while discovering the native target.
    const toolkit = window.TK && window.TK.$;
    const manager = toolkit && toolkit.SceneMrg, Menu = window.Scene_Menu;
    if (!manager || typeof manager.push !== "function" || typeof Menu !== "function") return;
    for (const [name, symbol, signature] of [
      ["Scene_Item", "item", "createItemWindow"],
      ["Scene_Skill", "skill", "createSkillTypeWindow"],
      ["Scene_Equip", "equip", "createSlotWindow"]
    ]) {
      if (typeof window[name] === "function") continue;
      const method = symbol === "item" ? "commandItem" : "onPersonalOk";
      if (typeof Menu.prototype[method] !== "function") continue;
      const menu = Object.create(Menu.prototype);
      menu._commandWindow = {currentSymbol: () => symbol};
      menu._statusWindow = {index: () => 0};
      const original = manager.push;
      let captured;
      try {
        manager.push = ctor => { captured = ctor; };
        menu[method]();
      } catch (_) { captured = null; }
      finally { manager.push = original; }
      if (typeof captured === "function" && captured.prototype && typeof captured.prototype[signature] === "function") {
        window[name] = captured;
      }
    }
  }

  // action -> handler. A table rather than a switch so `game.repair` can report
  // the supported set, and adding one is a single entry.
  const REPAIR_ACTIONS = Object.freeze({
    clearPictures: () => {
      const screen = requireEngineObject(resolveScreen(), "Game_Screen", "clearPictures");
      screen.clearPictures();
    },

    // Clears the map interpreter and every event's own interpreter: a stuck
    // "wait for movement" on one event blocks the whole map.
    clearCurrentEvent: () => {
      const map = requireMap();
      const interpreter = map._interpreter;
      if (!interpreter || typeof interpreter.clear !== "function") {
        throw new Error("map interpreter is unavailable");
      }
      interpreter.clear();
      if (map._events) {
        map._events.forEach((mapEvent) => {
          try {
            if (mapEvent && mapEvent._interpreter && typeof mapEvent._interpreter.clear === "function") {
              mapEvent._interpreter.clear();
            }
          } catch (_) {}
        });
      }
    },

    clearMoveRoute: () => {
      const player = requirePlayer("forceMoveRoute");
      if (player._moveRoute && typeof player.processRouteEnd === "function") player.processRouteEnd();
      player._moveRouteForcing = false;
      player._waitCount = 0;
    },

    // Also clears the interpreter's wait mode: a fade-out usually comes paired
    // with a wait the script never releases.
    fadeIn: () => {
      const screen = resolveScreen();
      const map = resolveMap();
      if (screen && typeof screen.startFadeIn === "function") screen.startFadeIn(24);
      if (map && map._interpreter) map._interpreter._waitMode = "";
    },

    gotoTitle: () => {
      const sceneManager = requireSceneManager("goto");
      if (typeof window.Scene_Title !== "function") throw new Error("Scene_Title is unavailable");
      sceneManager.goto(window.Scene_Title);
    },

    gotoMap: () => {
      const sceneManager = requireSceneManager("goto");
      const sceneMap = resolveSceneMap();
      if (!sceneMap) throw new Error("Scene_Map is unavailable");
      sceneManager.goto(sceneMap);
    }
  });

  Object.assign(commandHandlers, {

    // --- scenes ---------------------------------------------------------------

    "scene.info": () => {
      const sceneManager = resolveSceneManager();
      const scene = sceneManager && sceneManager._scene;
      const stack = sceneManager && Array.isArray(sceneManager._stack) ? sceneManager._stack : [];
      const ctor = scene && scene.constructor;
      const canonical = ctor && ["Scene_Map", "Scene_Title", "Scene_Battle", "Scene_Boot", ...PUSHABLE_SCENES]
        .find(name => window[name] === ctor);
      return {
        current: canonical || ctor && ctor.name || null,
        stackDepth: stack.length,
        available: availableScenes()
      };
    },

    "scene.push": (args) => {
      const name = String(args.name || "");
      // Whitelisted: pushing an arbitrary window global would be a crash
      // generator, and the GUI only ever offers what scene.info reported.
      if (!availableScenes().includes(name)) {
        throw new Error(`scene is unavailable: ${name || "(empty)"}`);
      }
      // Native menus normally select an actor before opening these views.
      // TH's item view reads the persisted selection directly, so the getter's
      // fallback alone is insufficient when a new save still has actor ID 0.
      if (["Scene_Item", "Scene_Skill", "Scene_Equip", "Scene_Status"].includes(name)) {
        const party = resolveParty();
        if (party && typeof party.menuActor === "function" && typeof party.setMenuActor === "function") {
          const actor = party.menuActor();
          if (!actor) throw new Error("当前没有可用于此菜单的队伍角色");
          party.setMenuActor(actor);
          // FT's native personal-menu handler also selects a party position.
          // Scene_Equip consumes it while creating the battle-sprite background,
          // before its own actor window exists (a fresh save has no index yet).
          if (isNativeFramePacingTarget() && typeof party.members === "function") {
            const index = party.members().indexOf(actor);
            if (index < 0) throw new Error("当前菜单角色已不在队伍中");
            party._TkSpIndex = index;
          }
        }
      }
      requireSceneManager("push").push(window[name]);
      return { pushed: name };
    },

    "scene.pop": () => {
      requireSceneManager("pop").pop();
      return { popped: true };
    },

    // --- repair (修复错误) ----------------------------------------------------

    "game.repair": (args) => {
      const action = String(args.action || "");
      const handler = REPAIR_ACTIONS[action];
      if (!handler) {
        throw new Error(`unsupported repair action: ${action || "(empty)"} ` +
          `(supported: ${Object.keys(REPAIR_ACTIONS).join(", ")})`);
      }
      handler();
      return { action, done: true };
    },

    "game.newGame": () => {
      const dataManager = requireDataManager("setupNewGame");
      const sceneManager = requireSceneManager("goto");
      const sceneMap = resolveSceneMap();
      if (!sceneMap) throw new Error("Scene_Map is unavailable");
      dataManager.setupNewGame();
      sceneManager.goto(sceneMap);
      return { started: true };
    },

    // Closure-sealed shells only: the launch flow's catalog dance (attach.mjs
    // ensureSealedCatalog) asks the bridge to reload the page so the boot-time
    // database load flows through the JSON tap with the bridge guaranteed
    // present. The attach layer re-injects into the new context — without it
    // this command would simply kill the bridge, so it is never exposed to the
    // GUI directly.
    "system.rebootCapture": () => {
      log("reboot capture requested");
      try { flushDataTables(); } catch (_) {}
      setTimeout(() => {
        try { location.reload(); } catch (error) { noteError(error); }
      }, 50);
      return { reloading: true };
    }
  });
