// Sealed-launcher MZ games (e.g. 停不下来的轮回): the whole MZ engine is one
// obfuscated IIFE ("game.js") executed by a Vite launcher page after an md5
// check, so NO engine object is reachable by name — no window.$gameParty, no
// DataManager, nothing. The page is chrome-extension://<nw-app-id>/, content
// script injection works (the bridge boots), but the bridge's resolvers stay
// empty and every hook gives up after 60s.
//
// The way in: this game is a plain NW.js app, so --remote-debugging-port gives
// us Chrome DevTools Protocol, and CDP has Runtime.queryObjects — a heap scan
// by prototype. We scan every Object.prototype descendant, pick out the live
// engine singletons by their field shapes ($gameParty: _gold + _items;
// Game_Variables: setValue + _data array; ...), and PUBLISH them under their
// standard names on window. From that moment the generic bridge sees a normal
// MZ game; nothing else changes.
//
// Freshness: DataManager.createGameObjects REPLACES every $game* singleton on
// new game / load save. Publishing a raw reference would go stale after the
// first load. So the publish step also wraps each singleton's prototype
// `initialize` to re-publish `this` — the patch survives replacements (the
// prototype object is shared by every instance) and keeps window.* pointing at
// the live game forever.
//
// Runtime security note: Runtime.enable is safe here (plain NW.js — the
// Runtime.enable watchdog panic in core/tauri-cdp.mjs is a Tauri/WebView2
// behaviour, and the game survived a full queryObjects scan in testing).

import { appendFileSync, mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { openCdpSession, listTargets } from "./cdp-client.mjs";

export class SealedSeedError extends Error {}

export const SEED_TIMEOUT_MS = Number(process.env.RMCH_SEED_TIMEOUT_MS || 45 * 60 * 1000);
const POLL_MS = 2500;
const CDP_DEAD_GRACE_MS = 90000;

// The in-page half. Runs via Runtime.callFunctionOn with `this` = the
// queryObjects result array (every Object.prototype descendant, ~10^5 objects).
// Shape-test order matters: managers and data tables are the most specific,
// plain singletons the most generic. Everything sits in per-object try/catch —
// the heap is full of hostile objects (proxies, detached frames, natives).
export const SEALED_SEED_FN = `function () {
  const found = {
    party: [], map: [], vars: [], switches: [], selfSwitches: [], actors: [],
    system: [], temp: [], screen: [], troop: [], player: [], message: [],
    sceneManager: [], dataManager: [], configManager: [], storageManager: [],
    battleManager: [], jsonEx: [], imageManager: [], scenes: [], constructors: [],
    dataItems: [], dataWeapons: [], dataArmors: [], dataSkills: [], dataStates: [],
    dataActors: [], dataClasses: [], dataEnemies: [], dataTroops: [], dataMapInfos: [],
    dataCommonEvents: [], dataSystem: []
  };
  for (const x of this) {
    if (!x) continue;
    try {
      const kind = typeof x;
      if (kind === "function") {
        // Scene constructors are closure-sealed too. Without them the bridge
        // can edit party data but cannot finish a load or enter native menus.
        const proto = x.prototype;
        if (proto && typeof proto.create === "function" && typeof proto.start === "function") found.scenes.push(x);
        if (proto && typeof proto.initialize === "function" &&
            (/^Game_[A-Za-z0-9_]+$/.test(x.name || "") ||
             typeof proto.executeCommand === "function" || typeof proto.isActor === "function" ||
             typeof proto.isMoving === "function" || typeof proto.isItem === "function" ||
             typeof proto.setValue === "function" || typeof proto.gainGold === "function")) found.constructors.push(x);
        // Most MZ "managers" are functions with statics (SceneManager,
        // DataManager, JsonEx, ImageManager, BattleManager, StorageManager —
        // the latter two could be either form; the family under test ships
        // them as functions). Without these branch checks they would be
        // skipped and every manager-shaped resolver in the bridge stays dead.
        if ("_scene" in x && "_stack" in x && typeof x.run === "function") found.sceneManager.push(x);
        else if ("_databaseFiles" in x && typeof x.isDatabaseLoaded === "function") found.dataManager.push(x);
        else if ((typeof x.saveObject === "function" && typeof x.loadObject === "function") ||
                 (typeof x.localFileDirectoryPath === "function" && typeof x.save === "function" && typeof x.load === "function")) found.storageManager.push(x);
        else if (typeof x.startBattle === "function" && typeof x.isBattleTest === "function") found.battleManager.push(x);
        else if (x.maxDepth !== undefined && typeof x.stringify === "function" && typeof x._encode === "function") found.jsonEx.push(x);
        else if (typeof x.loadSystem === "function" && typeof x.loadFace === "function") found.imageManager.push(x);
        continue;
      }
      if (kind !== "object") continue;
      if (Array.isArray(x)) {
        if (x.length > 1 && x[0] == null && x[1] && typeof x[1] === "object" && typeof x[1].id === "number") {
          const e = x[1];
          // This family's $dataItems has no atypeId (custom schema): itypeId
          // alone identifies the item table; weapons/armors follow.
          if (e.itypeId !== undefined) found.dataItems.push(x);
          else if (e.wtypeId !== undefined) found.dataWeapons.push(x);
          else if (e.stypeId !== undefined) found.dataSkills.push(x);
          else if (e.atypeId !== undefined) found.dataArmors.push(x);
          else if (e.autoRemovalTiming !== undefined) found.dataStates.push(x);
          else if (e.profile !== undefined) found.dataActors.push(x);
          else if (Array.isArray(e.expParams) && Array.isArray(e.learnings)) found.dataClasses.push(x);
          else if (e.battlerName !== undefined && e.exp !== undefined) found.dataEnemies.push(x);
          else if (Array.isArray(e.members) && Array.isArray(e.pages)) found.dataTroops.push(x);
          else if (e.list !== undefined && e.trigger !== undefined) found.dataCommonEvents.push(x);
          else if (e.parentId !== undefined && e.order !== undefined) found.dataMapInfos.push(x);
        }
        continue;
      }
      if (typeof x.startBattle === "function" && typeof x.isBattleTest === "function") found.battleManager.push(x);
      else if (x._phase !== undefined && x._troopId !== undefined) found.battleManager.push(x);
      else if (typeof x.setValue === "function" && Array.isArray(x._data)) {
        // Game_Switches and Game_Variables share the same shape and both boot
        // with an empty _data, so the reliable discriminator is the
        // out-of-range read: switches coerce to boolean (false), variables
        // return 0 (verified live on 停不下来的轮回).
        let probe;
        try { probe = x.value(999999); } catch (_) { probe = undefined; }
        if (probe === false) found.switches.push(x);
        else if (probe === 0) found.vars.push(x);
        else if (x._data.length === 0 || typeof x._data[0] === "boolean") found.switches.push(x);
        else found.vars.push(x);
      } else if (typeof x.setValue === "function" && x._data && !Array.isArray(x._data)) found.selfSwitches.push(x);
      else if (typeof x.actor === "function" && Array.isArray(x._data)) found.actors.push(x);
      else if (x._mapId !== undefined && Array.isArray(x._events)) found.map.push(x);
      else if (x._gold !== undefined && x._items !== undefined) found.party.push(x);
      else if (x._versionId !== undefined && x._framesOnSave !== undefined) found.system.push(x);
      else if (x._isPlaytest !== undefined && Array.isArray(x._commonEventQueue)) found.temp.push(x);
      else if (x._brightness !== undefined && Array.isArray(x._flashColor)) found.screen.push(x);
      else if (x._troopId !== undefined && x._phase === undefined) found.troop.push(x);
      else if (x._vehicleType !== undefined && x._followers !== undefined) found.player.push(x);
      else if (Array.isArray(x._texts) && Array.isArray(x._choices) && typeof x.isBusy === "function" && typeof x.add === "function") found.message.push(x);
      else if (x.alwaysDash !== undefined && x.bgmVolume !== undefined) found.configManager.push(x);
      else if (x.gameTitle !== undefined && Array.isArray(x.switches) && Array.isArray(x.variables)) found.dataSystem.push(x);
    } catch (_) {}
  }

  const summary = { published: [], patched: [], warnings: [], counts: {} };
  for (const key of Object.keys(found)) summary.counts[key] = found[key].length;
  const nativeScene = found.sceneManager[0] && found.sceneManager[0]._scene;
  if (nativeScene && (nativeScene.constructor.name === "Scene_Boot" ||
      typeof nativeScene.loadSystemImages === "function" && typeof nativeScene.checkPlayerLocation === "function")) {
    // Boot plugins are still processing metadata. Publishing captured copies
    // now can make those plugins observe tables before their notes are ready.
    summary.partial = true;
    summary.waitingForBoot = true;
    return summary;
  }
  const publish = (name, value) => {
    if (!value) return;
    try {
      window[name] = value;
      if (summary.published.indexOf(name) === -1) summary.published.push(name);
    } catch (e) { summary.warnings.push(name + ": " + e.message); }
  };
  // Singleton buckets must hold exactly one; duplicates mean the shape test
  // overlapped something else and taking the first is a guess worth reporting.
  const takeSingleton = (label) => {
    const list = found[label] || [];
    if (list.length > 1) summary.warnings.push(label + ": " + list.length + " candidates, took first");
    return list[0] || null;
  };
  // JSON capture caches and reset templates can be content-equal but fail
  // DataManager's identity-based inventory predicates. Prefer the live table.
  const takeFirst = (label) => {
    const list = found[label] || [];
    const predicate = { dataItems: "isItem", dataWeapons: "isWeapon", dataArmors: "isArmor", dataSkills: "isSkill" }[label];
    const manager = found.dataManager[0];
    if (predicate && manager && typeof manager[predicate] === "function") {
      const native = list.find(table => {
        const entry = table.find(item => item && typeof item === "object");
        try { return !!entry && manager[predicate](entry); } catch (_) { return false; }
      });
      if (native) return native;
    }
    return list[0] || null;
  };
  const singletonAliases = [
    ["$gameParty", "party"], ["$gameMap", "map"], ["$gameVariables", "vars"],
    ["$gameSwitches", "switches"], ["$gameSelfSwitches", "selfSwitches"],
    ["$gameActors", "actors"], ["$gameSystem", "system"], ["$gameTemp", "temp"],
    ["$gameScreen", "screen"], ["$gameTroop", "troop"], ["$gamePlayer", "player"], ["$gameMessage", "message"]
  ];
  for (const entry of singletonAliases) publish(entry[0], takeSingleton(entry[1]));
  for (const entry of [["$dataItems", "dataItems"], ["$dataWeapons", "dataWeapons"],
      ["$dataArmors", "dataArmors"], ["$dataSkills", "dataSkills"], ["$dataStates", "dataStates"],
      ["$dataActors", "dataActors"], ["$dataClasses", "dataClasses"], ["$dataEnemies", "dataEnemies"], ["$dataTroops", "dataTroops"],
      ["$dataMapInfos", "dataMapInfos"], ["$dataCommonEvents", "dataCommonEvents"],
      ["$dataSystem", "dataSystem"]]) {
    publish(entry[0], takeFirst(entry[1]));
  }
  for (const entry of [["SceneManager", "sceneManager"], ["DataManager", "dataManager"],
      ["ConfigManager", "configManager"], ["StorageManager", "storageManager"],
      ["BattleManager", "battleManager"], ["JsonEx", "jsonEx"], ["ImageManager", "imageManager"]]) {
    publish(entry[0], takeSingleton(entry[1]));
  }
  // Exact engine names take precedence over inferred superclass signatures.
  for (const scene of found.scenes) {
    if (/^Scene_[A-Za-z0-9_]+$/.test(scene.name || "") && typeof window[scene.name] !== "function") publish(scene.name, scene);
  }
  for (const scene of found.scenes) {
    const proto = scene.prototype;
    const signatures = [
      ["Scene_Map", "onMapLoaded", "processMapTouch"],
      ["Scene_Battle", "createPartyCommandWindow", "startActorCommandSelection"],
      ["Scene_Item", "createCategoryWindow", "onCategoryOk"],
      ["Scene_Skill", "createSkillTypeWindow", "refreshActor"],
      ["Scene_Equip", "createSlotWindow", "onSlotOk"],
      ["Scene_Status", "createProfileWindow", "createStatusWindow"],
      ["Scene_Menu", "commandPersonal", "commandFormation"],
      ["Scene_Title", "commandNewGame", "commandContinue"],
      ["Scene_Save", "onSaveSuccess", "onSaveFailure"],
      ["Scene_Load", "onLoadSuccess", "onLoadFailure"],
      ["Scene_Options", "createOptionsWindow", "maxCommands"],
      ["Scene_Debug", "createRangeWindow", "createEditWindow"],
      ["Scene_GameEnd", "commandToTitle", "createCommandWindow"]
    ];
    for (const signature of signatures) {
      if (typeof proto[signature[1]] === "function" && typeof proto[signature[2]] === "function" &&
          typeof window[signature[0]] !== "function") publish(signature[0], scene);
    }
  }
  // JsonEx restores prototype names that need not have a current singleton
  // (followers, vehicles, interpreters, items and actions among others).
  for (const ctor of found.constructors) {
    if (ctor.name && typeof window[ctor.name] !== "function") publish(ctor.name, ctor);
    if (typeof ctor.prototype.executeCommand === "function" && typeof ctor.prototype.command101 === "function") publish("Game_Interpreter", ctor);
    if (typeof ctor.prototype.setAttack === "function" && typeof ctor.prototype.executeHpDamage === "function") publish("Game_Action", ctor);
    if (typeof ctor.prototype.enemyId === "function" && typeof ctor.prototype.makeDropItems === "function") publish("Game_Enemy", ctor);
  }

  // The shape scan alone cannot pick the LIVE singleton generation: this game
  // family leaves older generations (loop snapshots / save previews) alive in
  // the heap, and "first candidate" once picked a frozen clone. The game's
  // own DataManager.makeSaveContents returns the closure-live set — prefer it
  // whenever it answers, keeping the shape picks as fallback only.
  try {
    const dataManager = window.DataManager;
    if (dataManager && typeof dataManager.makeSaveContents === "function") {
      const contents = dataManager.makeSaveContents();
      if (contents && typeof contents === "object") {
        const contentsAliases = {
          system: "$gameSystem", screen: "$gameScreen", temp: "$gameTemp",
          map: "$gameMap", player: "$gamePlayer", party: "$gameParty",
          actors: "$gameActors", switches: "$gameSwitches",
          variables: "$gameVariables", selfSwitches: "$gameSelfSwitches"
        };
        for (const key of Object.keys(contentsAliases)) {
          const value = contents[key];
          if (value && typeof value === "object") publish(contentsAliases[key], value);
        }
        summary.liveSet = true;
      }
    }
  } catch (e) { summary.warnings.push("makeSaveContents: " + e.message); }

  // Constructors under their MZ names so the bridge's resolvePrototypeTargets
  // path works on top of its runtime prototype-chain fallbacks.
  try {
    const data = (window.$gameActors && window.$gameActors._data) || [];
    let actor = null;
    for (let i = 0; i < data.length; i++) { if (data[i]) { actor = data[i]; break; } }
    const fromInstance = [
      ["Game_Party", "$gameParty"], ["Game_Actors", "$gameActors"], ["Game_Actor", actor && "actor"],
      ["Game_Map", "$gameMap"], ["Game_Player", "$gamePlayer"], ["Game_Troop", "$gameTroop"],
      ["Game_Screen", "$gameScreen"], ["Game_Temp", "$gameTemp"], ["Game_System", "$gameSystem"],
      ["Game_Switches", "$gameSwitches"], ["Game_Variables", "$gameVariables"],
      ["Game_SelfSwitches", "$gameSelfSwitches"]
    ];
    for (const entry of fromInstance) {
      const source = entry[1] === "actor" ? actor : window[entry[1]];
      if (source && source.constructor) publish(entry[0], source.constructor);
    }
  } catch (e) { summary.warnings.push("constructors: " + e.message); }

  // Freshness: wrap each singleton prototype's initialize so a replacement
  // (new game / load save re-creates every $game*) re-publishes itself. The
  // prototype object is shared by every instance of the class, so one patch
  // per class is enough for the whole game session.
  for (const entry of singletonAliases) {
    const alias = entry[0];
    const instance = window[alias];
    if (!instance || typeof instance !== "object") continue;
    const proto = Object.getPrototypeOf(instance);
    if (!proto || typeof proto.initialize !== "function") continue;
    if (proto.__rmchFreshPatched) continue;
    const original = proto.initialize;
    Object.defineProperty(proto, "__rmchFreshOriginal", { value: original, configurable: true });
    Object.defineProperty(proto, "initialize", {
      value: function () {
        const result = original.apply(this, arguments);
        try { window[alias] = this; } catch (_) {}
        return result;
      },
      writable: true, configurable: true, enumerable: false
    });
    Object.defineProperty(proto, "__rmchFreshPatched", { value: alias, configurable: true });
    summary.patched.push(alias);
  }

  // Second freshness path: DataManager.extractSaveContents (the game's own
  // load AND the bridge's save.contents.apply) assigns the DECODED objects to
  // the closure variables directly — no constructor runs, so the initialize
  // patches above never fire. Wrapping extractSaveContents and re-reading
  // makeSaveContents afterwards re-publishes the live set exactly once per
  // real load. (Wrapping JsonEx._decode was tried first and rejected: save
  // PREVIEWS also decode full object trees, and those must not hijack the
  // published references.)
  try {
    const dataManager = window.DataManager;
    if (dataManager && typeof dataManager.extractSaveContents === "function" && !dataManager.__rmchExtractPatched) {
      const originalExtract = dataManager.extractSaveContents;
      const republishAll = function (extracted) {
        try {
          let contents = extracted;
          // Some MV plugins add map.displayName to save metadata. During a
          // load the map is not available yet, though extraction has already
          // installed these decoded singletons successfully.
          try { contents = dataManager.makeSaveContents ? dataManager.makeSaveContents() : extracted; } catch (_) {}
          if (!contents) return;
          const contentsAliases = {
            system: "$gameSystem", screen: "$gameScreen", temp: "$gameTemp",
            map: "$gameMap", player: "$gamePlayer", party: "$gameParty",
            actors: "$gameActors", switches: "$gameSwitches",
            variables: "$gameVariables", selfSwitches: "$gameSelfSwitches"
          };
          for (const key of Object.keys(contentsAliases)) {
            const value = contents[key];
            if (value && typeof value === "object") window[contentsAliases[key]] = value;
          }
        } catch (_) {}
      };
      const wrappedExtract = function () {
        const result = originalExtract.apply(this, arguments);
        republishAll(arguments[0]);
        return result;
      };
      Object.defineProperty(dataManager, "extractSaveContents", {
        value: wrappedExtract, writable: true, configurable: true, enumerable: false
      });
      Object.defineProperty(dataManager, "__rmchExtractPatched", { value: true, configurable: true });
      summary.patched.push("DataManager.extractSaveContents");
    }
  } catch (e) { summary.warnings.push("extract patch: " + e.message); }

  // Only the full core set counts as seeded. A partial hit (e.g. only data
  // tables exist because the game has not entered a session yet) stays
  // unmarked so the seeder keeps polling and re-publishes everything later;
  // re-publishing is safe because the freshness patches are idempotent.
  summary.partial = !(window.$gameParty && window.$gameMap && window.$gameSystem);
  if (!summary.partial) {
    window.__rmchSealed = {
      seeded: true,
      at: Date.now(),
      published: summary.published,
      patched: summary.patched
    };
  }
  return summary;
}`;

// NW's built-in debugger transport can query its own game page even when a
// sealed launcher rejects command-line debugging flags. It uses the same heap
// publisher as the external CDP route, without exposing a listening port.
export function buildSelfSeedBootstrap() {
  return `(async function () {
    if (window.__rmchSelfSeeder || !window.chrome && typeof chrome === 'undefined') return;
    if (!chrome.debugger || !chrome.debugger.getTargets) return;
    const status = window.__rmchSelfSeeder = { attempts: 0, state: 'starting' };
    const invoke = (method, ...args) => new Promise((resolve, reject) => {
      chrome.debugger[method](...args, result => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message)); else resolve(result);
      });
    });
    const attempt = async () => {
      let target, attached = false;
      status.attempts += 1;
      try {
        const targets = await invoke('getTargets');
        const own = targets.find(t => t.type === 'page' && t.url === location.href);
        if (!own || own.attached) throw new Error('game debugger target unavailable');
        target = { targetId: own.id };
        await invoke('attach', target, '1.3');
        attached = true;
        const post = (method, params) => invoke('sendCommand', target, method, params);
        const proto = await post('Runtime.evaluate', { expression: 'Object.prototype', objectGroup: 'rmch-seed' });
        const heap = await post('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId, objectGroup: 'rmch-seed' });
        const result = await post('Runtime.callFunctionOn', {
          objectId: heap.objects.objectId, functionDeclaration: ${JSON.stringify(SEALED_SEED_FN)}, returnByValue: true
        });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'seed failed');
        status.summary = result.result && result.result.value;
        status.state = window.__rmchSealed && window.__rmchSealed.seeded ? 'seeded' : 'waiting';
      } catch (error) {
        status.state = 'waiting';
        status.error = String(error.message || error);
      } finally {
        if (attached) {
          try { await invoke('sendCommand', target, 'Runtime.releaseObjectGroup', { objectGroup: 'rmch-seed' }); } catch (_) {}
          try { await invoke('detach', target); } catch (_) {}
        }
      }
      if (status.state !== 'seeded' && status.attempts < 120) setTimeout(attempt, 2500);
    };
    await attempt();
  })()`;
}

// Quick page-state probe + the seed call. Used by runSeededSeeder and by tests.
// Returns one of:
//   { status: "no-cdp" }              — CDP endpoint not up (game not running yet)
//   { status: "booting" }             — page exists, game not booted / no page yet
//   { status: "launcher", text }      — bundled launcher UI visible, start button
//                                       text is not the plain start (e.g. updating)
//   { status: "clicked-start" }       — auto-clicked the launcher's start button
//   { status: "waiting-objects" }     — game booted but engine singletons not live yet
//   { status: "seeded", summary }     — published; done
//   { status: "already-seeded" }      — a previous seed is in place
export async function seedAttempt(cdpPort) {
  let targets;
  try {
    targets = await listTargets(cdpPort, 2000);
  } catch (error) {
    return { status: "no-cdp", error: error.message };
  }
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) return { status: "booting" };

  const session = await openCdpSession({ port: cdpPort });
  try {
    const state = await session.evaluate(`(function () {
      if (window.__rmchSealed && window.__rmchSealed.seeded) return "already-seeded";
      if (typeof document === "undefined" || !document.body) return "booting";
      if (window.__PIXI_APP__) return "game";
      var button = document.querySelector(".action");
      if (button) return "launcher:" + String(button.textContent || "").trim();
      return "booting";
    })()`, 8000);

    if (state === "already-seeded") return { status: "already-seeded" };
    if (state === "booting") return { status: "booting" };
    if (String(state).startsWith("launcher")) {
      const text = String(state).slice("launcher:".length);
      // The bundled launcher gates the game behind a start button (plus an
      // optional self-update). Auto-click the plain start button so an RMCH
      // launch goes straight into the game; anything else (update in flight)
      // is left alone.
      if (text.indexOf("开始游戏") !== -1) {
        await session.evaluate(
          "var b = document.querySelector('.action'); b && b.click(); 'clicked'", 8000
        );
        return { status: "clicked-start" };
      }
      return { status: "launcher", text };
    }

    // Game booted: scan the heap. The singletons only exist once the game
    // entered a session (new game or a loaded save) — before that the scan
    // legitimately finds nothing and the caller keeps polling.
    await session.call("Runtime.enable", {}, 10000);
    const proto = await session.call("Runtime.evaluate", {
      expression: "Object.prototype",
      objectGroup: "rmch-seed",
      returnByValue: false
    }, 10000);
    if (!proto.result || !proto.result.objectId) throw new SealedSeedError("Object.prototype handle missing");
    const query = await session.call("Runtime.queryObjects", {
      prototypeObjectId: proto.result.objectId,
      objectGroup: "rmch-seed"
    }, 120000);
    if (!query.objects || !query.objects.objectId) throw new SealedSeedError("queryObjects returned no object id");

    const result = await session.call("Runtime.callFunctionOn", {
      objectId: query.objects.objectId,
      functionDeclaration: SEALED_SEED_FN,
      returnByValue: true
    }, 120000);
    if (result.exceptionDetails) {
      throw new SealedSeedError("seed threw: " + JSON.stringify(result.exceptionDetails).slice(0, 400));
    }
    const summary = result.result.value;
    if (!summary || !summary.published || !summary.published.length || summary.partial) {
      return { status: "waiting-objects", counts: summary && summary.counts };
    }
    return { status: "seeded", summary };
  } finally {
    // Closing the session releases the rmch-seed object group (the ~10^5-object
    // query array) — without this the page leaks the whole snapshot.
    try { session.close(); } catch (_) {}
  }
}

// Long-running seeder loop for the detached process (tools/seed-sealed.mjs):
// waits for the game, auto-starts the bundled launcher, seeds once the engine
// singletons exist — then keeps running as a watchdog. A page reload (F5) or a
// game crash-restart wipes every published global INCLUDING the freshness
// patches, and the old one-shot seeder was long gone by then, leaving the
// bridge with "DataManager is unavailable" for the rest of the session. The
// watchdog re-seeds whenever __rmchSealed disappears — auto-clicking the
// launcher's start button again, same as the initial launch contract — and
// exits only when the CDP endpoint has been gone long enough to mean the game
// closed.
export async function runSeededSeeder({ cdpPort, log }) {
  const startedAt = Date.now();
  let lastCdpErrorAt = 0;
  let seedAttempts = 0;
  let clicks = 0;
  let seededOnce = false;
  for (;;) {
    if (!seededOnce && Date.now() - startedAt > SEED_TIMEOUT_MS) {
      log("seed timed out", { minutes: Math.round((Date.now() - startedAt) / 60000) });
      return { status: "timeout" };
    }
    let attempt;
    try {
      attempt = await seedAttempt(cdpPort);
    } catch (error) {
      attempt = { status: "error", error: error.message };
    }
    switch (attempt.status) {
      case "seeded":
        if (seededOnce) {
          log("re-seeded after page reload", { published: attempt.summary && attempt.summary.published });
        } else {
          log("seeded", attempt.summary);
          seededOnce = true;
          log("watchdog armed: re-seeding automatically if the page reloads");
        }
        break;
      case "already-seeded":
        if (!seededOnce) {
          log("already seeded by an earlier run");
          seededOnce = true;
        }
        break;
      case "clicked-start":
        clicks += 1;
        log("auto-clicked launcher start button", { clicks });
        break;
      case "launcher":
        if (clicks < 3) log("launcher visible without a start button", { text: attempt.text });
        break;
      case "waiting-objects":
        seedAttempts += 1;
        if (seedAttempts % 10 === 1) log("game booted, waiting for engine singletons (enter a save or start a game)");
        break;
      case "no-cdp":
        if (!lastCdpErrorAt) lastCdpErrorAt = Date.now();
        if (Date.now() - lastCdpErrorAt > CDP_DEAD_GRACE_MS) {
          log("CDP endpoint gone, game probably closed");
          return { status: "game-closed" };
        }
        break;
      case "error":
        log("seed attempt failed", { error: attempt.error });
        lastCdpErrorAt = 0;
        break;
      default:
        lastCdpErrorAt = 0;
        break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

export function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

export function appendSeedLog(projectRoot, gameKey, message, extra) {
  try {
    const dir = path.join(projectRoot, "runtime", "bridge-state", gameKey);
    mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${message}${extra ? " " + JSON.stringify(extra) : ""}\n`;
    appendFileSync(path.join(dir, "seed.log"), line, "utf8");
  } catch (_) {}
}
