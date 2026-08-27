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
    return PUSHABLE_SCENES.filter((name) => typeof window[name] === "function");
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
      if (typeof player.processRouteEnd === "function") player.processRouteEnd();
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
      return {
        current: scene && scene.constructor && scene.constructor.name || null,
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
    }
  });
