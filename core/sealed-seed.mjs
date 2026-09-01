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
const SEALED_SEED_FN = `function () {
  const found = {
    party: [], map: [], vars: [], switches: [], selfSwitches: [], actors: [],
    system: [], temp: [], screen: [], troop: [], player: [],
    sceneManager: [], dataManager: [], configManager: [], storageManager: [],
    battleManager: [], jsonEx: [], imageManager: [],
    dataItems: [], dataWeapons: [], dataArmors: [], dataSkills: [], dataStates: [],
    dataActors: [], dataEnemies: [], dataTroops: [], dataMapInfos: [],
    dataCommonEvents: [], dataSystem: []
  };
  for (const x of this) {
    if (!x) continue;
    try {
      const kind = typeof x;
      if (kind === "function") {
        // Most MZ "managers" are functions with statics (SceneManager,
        // DataManager, JsonEx, ImageManager, BattleManager, StorageManager —
        // the latter two could be either form; the family under test ships
        // them as functions). Without these branch checks they would be
        // skipped and every manager-shaped resolver in the bridge stays dead.
        if ("_scene" in x && "_stack" in x && typeof x.run === "function") found.sceneManager.push(x);
        else if ("_databaseFiles" in x && typeof x.isDatabaseLoaded === "function") found.dataManager.push(x);
        else if (typeof x.saveObject === "function" && typeof x.loadObject === "function") found.storageManager.push(x);
        else if (typeof x.startBattle === "function" && typeof x.isBattleTest === "function") found.battleManager.push(x);
        else if (x.maxDepth !== undefined && typeof x.stringify === "function" && typeof x._encode === "function") found.jsonEx.push(x);
        else if (typeof x.loadSystem === "function" && typeof x.loadFace === "function") found.imageManager.push(x);
        continue;
      }
      if (kind !== "object") continue;
      if (Array.isArray(x)) {
        if (x.length > 1 && x[1] && typeof x[1] === "object") {
          const e = x[1];
          // This family's $dataItems has no atypeId (custom schema): itypeId
          // alone identifies the item table; weapons/armors follow.
          if (e.itypeId !== undefined) found.dataItems.push(x);
          else if (e.wtypeId !== undefined) found.dataWeapons.push(x);
          else if (e.stypeId !== undefined) found.dataSkills.push(x);
          else if (e.atypeId !== undefined) found.dataArmors.push(x);
          else if (e.autoRemovalTiming !== undefined) found.dataStates.push(x);
          else if (e.profile !== undefined) found.dataActors.push(x);
          else if (e.battlerName !== undefined && e.exp !== undefined) found.dataEnemies.push(x);
          else if (e.members !== undefined && e.turns !== undefined) found.dataTroops.push(x);
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
      else if (x.alwaysDash !== undefined && x.bgmVolume !== undefined) found.configManager.push(x);
      else if (x.gameTitle !== undefined && Array.isArray(x.switches) && Array.isArray(x.variables)) found.dataSystem.push(x);
    } catch (_) {}
  }

  const summary = { published: [], patched: [], warnings: [], counts: {} };
  for (const key of Object.keys(found)) summary.counts[key] = found[key].length;
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
  // Data-table buckets may legitimately hold duplicates: this game family
  // keeps byte-identical template clones of the item/weapon/armor databases
  // (the 轮回-reset copies). Content-equal, so the first is fine.
  const takeFirst = (label) => {
    const list = found[label] || [];
    return list[0] || null;
  };
  const singletonAliases = [
    ["$gameParty", "party"], ["$gameMap", "map"], ["$gameVariables", "vars"],
    ["$gameSwitches", "switches"], ["$gameSelfSwitches", "selfSwitches"],
    ["$gameActors", "actors"], ["$gameSystem", "system"], ["$gameTemp", "temp"],
    ["$gameScreen", "screen"], ["$gameTroop", "troop"], ["$gamePlayer", "player"]
  ];
  for (const entry of singletonAliases) publish(entry[0], takeSingleton(entry[1]));
  for (const entry of [["$dataItems", "dataItems"], ["$dataWeapons", "dataWeapons"],
      ["$dataArmors", "dataArmors"], ["$dataSkills", "dataSkills"], ["$dataStates", "dataStates"],
      ["$dataActors", "dataActors"], ["$dataEnemies", "dataEnemies"], ["$dataTroops", "dataTroops"],
      ["$dataMapInfos", "dataMapInfos"], ["$dataCommonEvents", "dataCommonEvents"],
      ["$dataSystem", "dataSystem"]]) {
    publish(entry[0], takeFirst(entry[1]));
  }
  for (const entry of [["SceneManager", "sceneManager"], ["DataManager", "dataManager"],
      ["ConfigManager", "configManager"], ["StorageManager", "storageManager"],
      ["BattleManager", "battleManager"], ["JsonEx", "jsonEx"], ["ImageManager", "imageManager"]]) {
    publish(entry[0], takeSingleton(entry[1]));
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
      const republishAll = function () {
        try {
          const contents = dataManager.makeSaveContents ? dataManager.makeSaveContents() : null;
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
        republishAll();
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
// singletons exist, then exits. Gives up on timeout or when the CDP endpoint
// has been gone long enough to mean the game closed.
export async function runSeededSeeder({ cdpPort, log }) {
  const startedAt = Date.now();
  let lastCdpErrorAt = 0;
  let seedAttempts = 0;
  let clicks = 0;
  for (;;) {
    if (Date.now() - startedAt > SEED_TIMEOUT_MS) {
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
        log("seeded", attempt.summary);
        return { status: "seeded", summary: attempt.summary };
      case "already-seeded":
        log("already seeded by an earlier run");
        return { status: "already-seeded" };
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
