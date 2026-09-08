// Bridge harness test: run runtime/bridge/page-bridge.js inside a vm sandbox
// with a mock RPG Maker MV game, drive commands through the JSONL queue and
// verify events, state and hook behaviour. No real game process involved.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { buildBridge } from "../core/bridge-bundler.mjs";

const require = createRequire(import.meta.url);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeMockGame(sandbox) {
  class Game_BattlerBase {
    constructor() {
      this._hp = 100;
      this._mp = 50;
      this._tp = 10;
    }
    setHp(v) { this._hp = v; }
    setMp(v) { this._mp = v; }
    setTp(v) { this._tp = v; }
    paySkillCost() {}
    canPaySkillCost() { return true; }
    skillMpCost() { return 5; }
    skillTpCost() { return 0; }
  }
  class Game_Actor extends Game_BattlerBase {
    constructor(id) {
      super();
      this._actorId = id;
      this._name = `Actor${id}`;
      this._level = 1;
      this._skills = [];
      this._exp = { 1: 0 };
      this._paramPlus = [0, 0, 0, 0, 0, 0, 0, 0];
      this.mhp = 200;
      this.mmp = 100;
    }
    actorId() { return this._actorId; }
    name() { return this._name; }
    refresh() {}
    maxLevel() { return 99; }
    changeLevel(level) { this._level = level; }
    gainExp(amount) { this._exp[1] += amount; }
    currentExp() { return this._exp[1]; }
    learnSkill(id) { this._skills.push(id); }
    forgetSkill(id) { this._skills = this._skills.filter((s) => s !== id); }
    recoverAll() { this._hp = 200; this._mp = 100; }
    skills() { return this._skills.map((id) => ({ id, name: `Skill${id}` })); }
    equips() { return []; }
    param(index) { return 10 + index; }
    nickname() { return this._nickname || ""; }
    setNickname(value) { this._nickname = value; }
    states() { return (this._states || []).map((id) => ({ id, name: `State${id}` })); }
    addState(id) { this._states = (this._states || []).concat(id); }
    removeState(id) { this._states = (this._states || []).filter((s) => s !== id); }
  }
  class Game_Player {
    constructor() {
      this._x = 3;
      this._y = 4;
      this._direction = 2;
      this._through = false;
      this._mapId = 1;
    }
    reserveTransfer(mapId, x, y, direction, fade) {
      this._transfer = { mapId, x, y, direction, fade };
    }
    isThrough() { return this._through; }
    setThrough(value) { this._through = value; }
  }

  const actors = [new Game_Actor(1), new Game_Actor(2)];
  const gold = { _gold: 0 };
  const party = {
    _gold: 0,
    _items: {},
    gold() { return this._gold; },
    gainGold(amount) { this._gold = Math.max(0, this._gold + amount); },
    gainItem(item, amount) {
      this._items[item.id] = (this._items[item.id] || 0) + amount;
    },
    // Closure-sealed games hide $dataItems but these still return the data
    // objects themselves — the item.* fallback path leans on them.
    items() { return [{ id: 1, name: "Potion", iconIndex: 176 }, { id: 2, name: "Ether", iconIndex: 200 }]; },
    weapons() { return [{ id: 1, name: "Sword", iconIndex: 1 }]; },
    armors() { return [{ id: 1, name: "Shield", iconIndex: 2 }]; },
    allMembers() { return actors; },
    members() { return actors; },
    battleMembers() { return actors.slice(0, 4); },
    addActor(id) { actors.push(new Game_Actor(id)); },
    removeActor(id) { /* noop for test */ },
    inBattle() { return false; }
  };
  const store = (initial) => ({
    _data: { ...initial },
    value(id) { return this._data[id]; },
    setValue(id, value) { this._data[id] = value; }
  });
  const switches = {
    _data: {},
    value(id) { return !!this._data[id]; },
    setValue(id, value) { this._data[id] = !!value; }
  };
  const variables = {
    _data: {},
    value(id) { return this._data[id] || 0; },
    setValue(id, value) { this._data[id] = value; }
  };
  const selfSwitches = {
    _data: {},
    value(key) { return !!this._data[String(key)]; },
    setValue(key, value) { this._data[String(key)] = !!value; }
  };

  sandbox.window = sandbox;
  sandbox.$gameParty = party;
  sandbox.$gameSwitches = switches;
  sandbox.$gameVariables = variables;
  sandbox.$gameSelfSwitches = selfSwitches;
  sandbox.$gameActors = { actor: (id) => actors.find((a) => a.actorId() === id) };
  sandbox.$gameMap = {
    _mapId: 1,
    _displayName: "Field",
    width() { return 20; },
    height() { return 15; },
    requestRefresh() {},
    mapId() { return this._mapId; },
    _interpreter: { _waitMode: "wait", clear() { this.cleared = true; this._waitMode = ""; } },
    _events: [
      undefined,
      {
        _eventId: 1, _x: 4, _y: 7, _pageIndex: 0,
        event() { return { name: "EV001", pages: [{ list: [{ code: 101 }, { code: 401 }] }] }; }
      }
    ],
    event(id) { return this._events[id] || null; }
  };
  sandbox.$gamePlayer = new Game_Player();
  sandbox.$gameTemp = { reserveCommonEvent() {} };
  // A non-empty troop matters: battle.info maps over the members, and a missing
  // name accessor there used to throw ReferenceError only once enemies existed.
  const enemies = [
    { _enemyId: 1, _hp: 40, mhp: 40, enemyId() { return 1; }, name() { return "Slime"; }, isAlive() { return this._hp > 0; }, setHp(v) { this._hp = v; }, isEnemy() { return true; }, die() { this._hp = 0; } },
    // Second enemy exposes no name() at all — the $dataEnemies fallback path.
    { _enemyId: 2, _hp: 10, mhp: 10, enemyId() { return 2; }, isAlive() { return this._hp > 0; }, setHp(v) { this._hp = v; }, isEnemy() { return true; }, die() { this._hp = 0; } }
  ];
  sandbox.$gameTroop = { members: () => enemies };
  sandbox.$dataEnemies = [null, { id: 1, name: "Slime" }, { id: 2, name: "Bat" }];
  sandbox.$gameSystem = {};
  sandbox.$gameScreen = {
    _pictures: [1, 2, 3],
    clearPictures() { this._pictures = []; },
    startFadeIn(duration) { this._fadeIn = duration; }
  };
  sandbox.$dataSystem = {
    gameTitle: "MockGame",
    switches: [null, "SW1", "SW2"],
    variables: [null, "V1", "V2"]
  };
  sandbox.$dataItems = [null, { id: 1, name: "Potion", iconIndex: 176 }, { id: 2, name: "Ether", iconIndex: 200 }];
  sandbox.$dataWeapons = [null, { id: 1, name: "Sword", iconIndex: 1 }];
  sandbox.$dataArmors = [null, { id: 1, name: "Shield", iconIndex: 2 }];
  sandbox.$dataSkills = [null, { id: 1, name: "Fire", iconIndex: 3 }, { id: 2, name: "Heal", iconIndex: 4 }];
  sandbox.$dataActors = [null, { id: 1, name: "Actor1" }, { id: 2, name: "Actor2" }];
  sandbox.$dataMapInfos = [null, { id: 1, name: "Map1" }, { id: 2, name: "Map2" }];
  sandbox.$dataCommonEvents = [null, { id: 1, name: "CE1" }];
  sandbox.Utils = { RPGMAKER_NAME: "MV", RPGMAKER_VERSION: "1.6.1" };
  sandbox.SceneManager = {
    updateMain() {},
    _scene: null,
    _stack: [],
    push(sceneClass) { this._stack.push(sceneClass); this._scene = new sceneClass(); },
    pop() { this._stack.pop(); },
    goto(sceneClass) { this._goto = sceneClass; }
  };
  sandbox.Scene_Map = class Scene_Map {};
  sandbox.Scene_Title = class Scene_Title {};
  sandbox.Scene_Item = class Scene_Item {};
  sandbox.Scene_Status = class Scene_Status {};
  // Minimal stand-ins for the two DataManager/JsonEx entry points the
  // save-contents tree editor round-trips through.
  sandbox.JsonEx = {
    maxDepth: 100,
    stringify(value) { return JSON.stringify(value); },
    parse(json) { return JSON.parse(json); }
  };
  sandbox.DataManager = {
    makeSaveContents() {
      return { gold: sandbox.$gameParty._gold, switches: sandbox.$gameSwitches._data, marker: "before" };
    },
    extractSaveContents(contents) { this._extracted = contents; },
    // The corrupt-global guard test (group 33) drives this through file
    // existence: a present global.rpgsave decodes to msgpack-nil and the game
    // throws; the missing-file path is the fresh-install one and returns [].
    loadGlobalInfo() {
      this._globalCalls = (this._globalCalls || 0) + 1;
      const globalFile = path.join(sandbox.process.env.RMCH_GAME_ROOT, "www", "save", "global.rpgsave");
      if (existsSync(globalFile)) throw new TypeError("Cannot convert undefined or null to object");
      return [];
    }
  };
  sandbox.BattleManager = { _phase: "init" };
  sandbox.Game_BattlerBase = Game_BattlerBase;
  sandbox.Game_Actor = Game_Actor;
  sandbox.Game_Player = Game_Player;
  sandbox.ConfigManager = { alwaysDash: false };
  return { actors, party, switches, variables, gold, enemies };
}

async function main() {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  buildBridge(projectRoot);
  const bridgeSource = readFileSync(path.join(projectRoot, "runtime", "bridge", "page-bridge.js"), "utf8");

  const tempGameRoot = mkdtempSync(path.join(tmpdir(), "rmch-game-"));
  const tempProjectRoot = mkdtempSync(path.join(tmpdir(), "rmch-project-"));
  const bridgeDir = path.join(tempProjectRoot, "runtime", "bridge-state", "mock-game");
  const commandPath = path.join(bridgeDir, "commands.jsonl");
  const eventPath = path.join(bridgeDir, "events.jsonl");
  const statePath = path.join(bridgeDir, "state.json");

  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.location = { href: "file:///game/www/index.html" };
  sandbox.console = console;
  sandbox.setTimeout = setTimeout;
  sandbox.setInterval = setInterval;
  sandbox.clearInterval = clearInterval;
  sandbox.clearTimeout = clearTimeout;
  sandbox.addEventListener = () => {};
  sandbox.require = require;
  sandbox.process = {
    ...process,
    env: {
      ...process.env,
      RMCH_GAME_ROOT: tempGameRoot,
      RMCH_PROJECT_ROOT: tempProjectRoot,
      RMCH_GAME_KEY: "mock-game",
      RMCH_WS_PORT: "59999",
      RMCH_WS_TOKEN: "unused"
    },
    cwd: () => tempGameRoot
  };
  sandbox.WebSocket = class {
    constructor() {
      setTimeout(() => {
        if (this.onclose) this.onclose();
      }, 0);
    }
    send() { return true; }
  };
  sandbox.XMLHttpRequest = undefined;
  sandbox.document = { createElement: () => ({ set textContent(v) {}, get textContent() { return ""; } }), documentElement: null };
  // Group-32 setup: pretend the page sits in an NW window that has never been
  // shown (protected games boot with "show": false and can stall there). The
  // startup watchdog must re-assert show() until the window reports visible.
  sandbox.document.visibilityState = "hidden";
  const mockWindow = { showCount: 0, show() { this.showCount += 1; } };
  sandbox.nw = { Window: { get: () => mockWindow } };
  sandbox.eval = eval;

  const mock = makeMockGame(sandbox);
  const context = vm.createContext(sandbox);
  vm.runInContext(bridgeSource, context, { filename: "page-bridge.js" });

  assert.ok(sandbox.__rmchBridge, "bridge must attach to window");
  assert.equal(sandbox.__rmchBridge.version, "0.4.0");

  let commandCounter = 0;
  const sendCommand = async (type, args = {}) => {
    commandCounter += 1;
    const commandId = `t${commandCounter}`;
    const line = JSON.stringify({ commandId, ts: Date.now(), type, args });
    const before = existsSync(eventPath)
      ? readFileSync(eventPath, "utf8").split(/\r?\n/).filter(Boolean).length
      : 0;
    writeFileSync(commandPath, line + "\n", { flag: "a" });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await sleep(100);
      if (!existsSync(eventPath)) continue;
      const lines = readFileSync(eventPath, "utf8").split(/\r?\n/).filter(Boolean);
      if (lines.length > before) {
        const events = lines.map((text) => JSON.parse(text));
        const found = events.find((e) => e.commandId === `file:${commandId}`);
        if (found) return found;
      }
    }
    throw new Error(`command ${type} did not produce an event within 5s`);
  };

  // 1. ping / basic state
  const ping = await sendCommand("ping");
  assert.equal(ping.ok, true, `ping failed: ${JSON.stringify(ping)}`);
  assert.equal(ping.payload.gameKey, "mock-game");
  assert.equal(ping.payload.engine.maker, "MV");

  // 2. gold add/set
  assert.equal((await sendCommand("gold.add", { amount: 500 })).payload.gold, 500);
  assert.equal((await sendCommand("gold.set", { value: 1234 })).payload.gold, 1234);

  // 3. switch / variable / self switch
  assert.equal((await sendCommand("switch.set", { id: 1, value: true })).payload.value, true);
  assert.equal(mock.switches.value(1), true);
  assert.equal((await sendCommand("variable.set", { id: 2, value: 777 })).payload.value, 777);
  assert.equal(mock.variables.value(2), 777);
  await sendCommand("selfSwitch.set", { mapId: 1, eventId: 5, letter: "A", value: true });

  // 4. item add
  const item = await sendCommand("item.add", { kind: "item", id: 1, amount: 9 });
  assert.equal(item.ok, true);
  assert.equal(mock.party._items[1], 9);

  // 4b. inventory list/set (MTool-style count editing)
  const inv = await sendCommand("item.list");
  assert.equal(inv.ok, true, `item.list failed: ${JSON.stringify(inv)}`);
  assert.equal(inv.payload.entries.length, 1);
  assert.equal(inv.payload.entries[0].kind, "item");
  assert.equal(inv.payload.entries[0].id, 1);
  assert.equal(inv.payload.entries[0].name, "Potion");
  assert.equal(inv.payload.entries[0].count, 9);
  const setMore = await sendCommand("item.set", { kind: "item", id: 1, count: 20 });
  assert.equal(setMore.payload.count, 20);
  assert.equal(mock.party._items[1], 20);
  const setZero = await sendCommand("item.set", { kind: "item", id: 1, count: 0 });
  assert.equal(setZero.payload.count, 0);
  const setRestore = await sendCommand("item.set", { kind: "item", id: 1, count: 9 });
  assert.equal(setRestore.payload.count, 9);
  assert.equal(mock.party._items[1], 9);

  // 4c. fractional container values (amplifier plugins) display as integers,
  //     and a sabotaged gainItem (再刷一把 ships a native no-op stub) is
  //     overridden by the writeback.
  mock.party._items[2] = 2.7;
  const invFrac = await sendCommand("item.list");
  const ether = invFrac.payload.entries.find((e) => e.id === 2);
  assert.equal(ether && ether.count, 3, "fractional count must round for display");
  delete mock.party._items[2];
  const realGainItem = mock.party.gainItem;
  mock.party.gainItem = function () {}; // native no-op stub
  const setStub = await sendCommand("item.set", { kind: "item", id: 1, count: 15 });
  assert.equal(setStub.payload.count, 15, "writeback must pin the count past a stub gainItem");
  assert.equal(mock.party._items[1], 15);
  const addStub = await sendCommand("item.add", { kind: "item", id: 1, amount: 2 });
  assert.equal(addStub.payload.count, 17, "item.add past a stub must land exactly");
  mock.party.gainItem = realGainItem;
  await sendCommand("item.set", { kind: "item", id: 1, count: 9 });

  // 5. actor edits
  const level = await sendCommand("actor.level.set", { id: 1, level: 30 });
  assert.equal(level.payload.actor.level, 30);
  const vitals = await sendCommand("actor.vitals.set", { id: 1, hp: 199, mp: 99 });
  assert.equal(vitals.payload.actor.hp, 199);
  const skill = await sendCommand("actor.skill.learn", { id: 1, skillId: 2 });
  assert.ok(skill.payload.actor.skills.some((s) => s.id === 2));

  // 6. party info/recover
  const party = await sendCommand("party.info");
  assert.equal(party.payload.gold, 1234);
  assert.equal(party.payload.members.length, 2);
  const recover = await sendCommand("party.recover");
  assert.equal(recover.payload.recovered, 2);

  // 7. catalogs
  const catalog = await sendCommand("catalog.query", { kind: "item", query: "pot" });
  assert.equal(catalog.payload.entries.length, 1);
  assert.equal(catalog.payload.entries[0].name, "Potion");
  const badCatalog = await sendCommand("catalog.query", { kind: "nonsense" });
  assert.equal(badCatalog.ok, false);

  // 8. switch/variable listing with values
  const switchList = await sendCommand("switch.list", { offset: 1, limit: 10 });
  assert.equal(switchList.payload.entries[0].name, "SW1");
  assert.equal(switchList.payload.entries[0].value, true);

  // 9. trainer options + no-cost hook
  const options = await sendCommand("trainer.options.set", { options: { noSkillCost: true, invincible: false } });
  assert.equal(options.payload.options.noSkillCost, true);
  const actor1 = mock.actors[0];
  assert.equal(actor1.skillMpCost({ mpCost: 5 }), 0, "noSkillCost must zero skillMpCost for actors");

  // 10. lock HP through the setHp hook
  await sendCommand("trainer.options.set", { options: { lockHp: true, lockHpVal: 150, noSkillCost: false } });
  actor1.setHp(10);
  assert.equal(actor1._hp, 150, "setHp must be forced back to the locked value");
  actor1.addParam = function () { this.refresh(); };
  const ignoredParam = await sendCommand("actor.param.add", { id: 1, paramId: 2, value: 10 });
  assert.equal(ignoredParam.ok, false, "a game-disabled addParam must not report success");
  delete actor1.addParam;
  const appliedParam = await sendCommand("actor.param.add", { id: 1, paramId: 2, value: 10 });
  assert.equal(appliedParam.ok, true, "native parameter fallback still applies changes");
  assert.equal(actor1._paramPlus[2], 10);

  // 11. battle reward rates on BattleManager mock
  sandbox.BattleManager._rewards = { exp: 100, gold: 200 };
  sandbox.BattleManager.makeRewards = function () { this._rewards = { exp: 100, gold: 200 }; };
  await sendCommand("trainer.options.set", { options: { expRate: 2, goldRate: 3, lockHp: false } });
  sandbox.BattleManager._phase = "battle";
  sandbox.BattleManager.makeRewards();
  assert.equal(sandbox.BattleManager._rewards.exp, 200, "exp rate must apply");
  assert.equal(sandbox.BattleManager._rewards.gold, 600, "gold rate must apply");
  sandbox.BattleManager._phase = "init";

  // 12. map transfer / through
  const unsafeTransfer = await sendCommand("map.transfer", { mapId: 2, x: 5, y: 6 });
  assert.equal(unsafeTransfer.ok, false, "transfer outside a map scene must be refused");
  sandbox.SceneManager._scene = new sandbox.Scene_Map();
  const transfer = await sendCommand("map.transfer", { mapId: 2, x: 5, y: 6 });
  assert.deepEqual(transfer.payload, { mapId: 2, x: 5, y: 6, direction: 2, fade: 0 });
  assert.equal(sandbox.$gamePlayer._transfer.mapId, 2);
  const through = await sendCommand("map.through.toggle");
  assert.equal(through.payload.through, true);
  await sendCommand("map.through.set", { value: false });
  // Stair events enable through, wait across bridge timer ticks, then move
  // across blocked tiles. An inactive trainer must preserve that state.
  const stairPlayer = sandbox.$gamePlayer;
  stairPlayer.setThrough(true);
  await sleep(1100);
  assert.equal(stairPlayer.isThrough(), true, "bridge timer must preserve stair-event through state");
  await sendCommand("map.through.set", { value: true });
  stairPlayer.setThrough(false);
  assert.equal(stairPlayer.isThrough(), true, "trainer through must remain effective after an event disables native through");
  assert.equal(stairPlayer._through, false, "trainer must not write through into game/save state");
  await sendCommand("map.through.set", { value: false });
  assert.equal(stairPlayer.isThrough(), false, "disabling trainer restores native collision immediately");
  stairPlayer.setThrough(true);
  await sendCommand("map.through.toggle");
  await sendCommand("map.through.toggle");
  assert.equal(stairPlayer.isThrough(), true, "toggling trainer must preserve a running event's native through");
  stairPlayer.setThrough(false);

  // 13. map list
  const maps = await sendCommand("map.list");
  assert.equal(maps.payload.total, 2);

  // 14. common event
  const ce = await sendCommand("commonEvent.run", { id: 1 });
  assert.equal(ce.ok, false, "whole event execution requires a current map and validated event revision");

  // 15. console.eval
  const evaluated = await sendCommand("console.eval", { code: "2 + 3" });
  assert.equal(evaluated.payload.result, 5);

  // 16. save list (empty save dir must not throw)
  const saves = await sendCommand("save.list");
  assert.equal(saves.ok, true);
  assert.equal(saves.payload.entries.length, 0);

  // 17. error propagation
  const failing = await sendCommand("actor.level.set", { id: 999, level: 5 });
  assert.equal(failing.ok, false);
  assert.match(failing.payload.error, /actor 999/);

  // 18. unknown command
  const unknown = await sendCommand("no.such.command");
  assert.equal(unknown.ok, false);
  assert.match(unknown.payload.error, /unknown command type/);

  // 19. state.json written with live data
  await sleep(1200);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.gameKey, "mock-game");
  assert.equal(state.gold, 1234);
  assert.equal(state.party.length, 2);
  assert.equal(state.options.expRate, 2);

  // 20. profile absence recorded
  assert.equal(state.profile.loaded, false);

  // --- MTool-parity commands -------------------------------------------------
  // The lock writeback lives in the SceneManager.updateMain hook, so each of
  // these ticks the frame by hand and then checks the game state was forced.
  const tick = () => sandbox.SceneManager.updateMain(1);

  // 21. item count lock survives the game taking the item away
  await sendCommand("item.set", { kind: "item", id: 1, count: 7 });
  const itemLock = await sendCommand("lock.set", { kind: "item", id: 1, value: 42 });
  assert.equal(itemLock.ok, true, itemLock.payload && itemLock.payload.error);
  assert.deepEqual(itemLock.payload, { kind: "item", id: 1, enabled: true, value: 42 });
  mock.party._items[1] = 0;                       // the game consumes it
  tick();
  assert.equal(mock.party._items[1], 42, "locked item count must be forced back");

  // 22. switch + variable locks
  await sendCommand("lock.set", { kind: "switch", id: 1, value: true });
  await sendCommand("lock.set", { kind: "variable", id: 1, value: 555 });
  mock.switches._data[1] = false;
  mock.variables._data[1] = 0;
  tick();
  assert.equal(mock.switches._data[1], true, "locked switch must be forced on");
  assert.equal(mock.variables._data[1], 555, "locked variable must be forced back");

  // 23. gold lock, then release
  await sendCommand("lock.set", { kind: "gold", value: 999 });
  mock.party._gold = 3;
  tick();
  assert.equal(mock.party._gold, 999, "locked gold must be forced back");
  await sendCommand("lock.set", { kind: "gold", enabled: false });
  mock.party._gold = 3;
  tick();
  assert.equal(mock.party._gold, 3, "released gold lock must stop writing");
  // Renamed/custom engines keep a second ledger in gainGold; raw field writes
  // invalidate it. Locks must use that same path, and only when gold differs.
  let ledgerGold = 3, ledgerCalls = 0;
  const oldGainGold = mock.party.gainGold;
  Object.defineProperty(mock.party, "_gold", { configurable: true, get() { return ledgerGold; }, set() { throw new Error("raw gold write invalidates ledger"); } });
  mock.party.gainGold = amount => { ledgerCalls++; ledgerGold += amount; };
  await sendCommand("lock.set", { kind: "gold", value: 500 });
  tick();
  assert.equal(ledgerGold, 500, "gold lock must preserve the game's gainGold bookkeeping");
  const callsAtTarget = ledgerCalls;
  tick();
  assert.equal(ledgerCalls, callsAtTarget, "unchanged locks must not repeatedly notify the game");
  await sendCommand("lock.set", { kind: "gold", enabled: false });
  Object.defineProperty(mock.party, "_gold", { configurable: true, writable: true, value: ledgerGold });
  mock.party.gainGold = oldGainGold;
  const oldGoldReader = mock.party.gold;
  mock.party._gold = "encoded:100";
  mock.party.gold = () => Number(String(mock.party._gold).split(":")[1]);
  mock.party.maxGold = () => 100;
  let cappedGoldCalls = 0;
  mock.party.gainGold = delta => { cappedGoldCalls++; mock.party._gold = "encoded:" + Math.max(0, Math.min(100, mock.party.gold() + delta)); };
  const cappedGold = await sendCommand("gold.set", { value: 500 });
  assert.equal(cappedGold.payload.gold, 100, "native encoded gold caps remain authoritative");
  assert.equal(mock.party._gold, "encoded:100");
  await sendCommand("lock.set", { kind: "gold", value: 500 });
  const callsAtCap = cappedGoldCalls;
  tick(); tick();
  assert.equal(cappedGoldCalls, callsAtCap, "an unreachable gold lock does not repeat native notifications");
  await sendCommand("lock.clear");
  mock.party.gold = oldGoldReader; mock.party.gainGold = oldGainGold; delete mock.party.maxGold;
  mock.party._gold = 100;

  // 24. bulk replace + snapshot round trip
  const replaced = await sendCommand("lock.replace", {
    locks: { item: { 2: 5 }, weapon: {}, armor: {}, switch: { 2: true }, variable: {}, gold: 77 }
  });
  assert.deepEqual(replaced.payload.locks.item, { 2: 5 }, "replace must drop the previous item locks");
  assert.equal(replaced.payload.locks.gold, 77);
  const listed = await sendCommand("lock.list");
  assert.deepEqual(listed.payload.locks.switch, { 2: true });
  const cleared = await sendCommand("lock.clear");
  assert.deepEqual(cleared.payload.locks.item, {});
  assert.equal(cleared.payload.locks.gold, null);
  mock.party._gold = 1234;                        // restore for anything downstream
  const plainItems = mock.party._items, plainGainItem = mock.party.gainItem;
  mock.party._items = { 1: "encoded:5" };
  mock.party.numItems = item => {
    const raw = mock.party._items[item.id];
    if (typeof raw === "number") throw new Error("raw inventory write invalidates encoding");
    return raw ? Number(raw.split(":")[1]) : 0;
  };
  mock.party.gainItem = (item, amount) => { mock.party._items[item.id] = "encoded:" + Math.max(0, mock.party.numItems(item) + amount); };
  const encodedSet = await sendCommand("item.set", { kind: "item", id: 1, count: 8 });
  assert.equal(encodedSet.payload.count, 8, "inventory updates read back through numItems");
  assert.equal(mock.party._items[1], "encoded:8", "inventory writes preserve encoded backing fields");
  const encodedAdd = await sendCommand("item.add", { kind: "item", id: 1, amount: 2 });
  assert.equal(encodedAdd.payload.count, 10);
  const encodedList = await sendCommand("item.list");
  assert.equal(encodedList.payload.entries.find(e => e.kind === "item" && e.id === 1).count, 10);
  await sendCommand("lock.set", { kind: "item", id: 1, value: 12 });
  tick();
  assert.equal(mock.party._items[1], "encoded:12", "inventory locks use the engine's write path");
  await sendCommand("lock.clear");
  mock.party.thTyZhNumGain = value => "encoded:" + value;
  mock.party.thTyZhNumGet = value => Number(String(value).split(":")[1]) || 0;
  delete mock.party._items[1];
  mock.party.gainItem = () => {};
  const refusedEmptySlot = await sendCommand("item.set", { kind: "item", id: 1, count: 5 });
  assert.equal(refusedEmptySlot.ok, false, "encoded inventory cannot fall back to writing raw empty slots");
  assert.equal(mock.party._items[1], undefined);
  delete mock.party.thTyZhNumGain; delete mock.party.thTyZhNumGet;
  mock.party._items = plainItems; mock.party.gainItem = plainGainItem; delete mock.party.numItems;
  const oldVariableValue = mock.variables.value, oldVariableSet = mock.variables.setValue;
  mock.variables._data[1] = "encoded:4";
  mock.variables.value = id => Number(String(mock.variables._data[id]).split(":")[1]) || 0;
  mock.variables.setValue = (id, value) => { mock.variables._data[id] = "encoded:" + value; };
  await sendCommand("lock.set", { kind: "variable", id: 1, value: 25 });
  tick();
  assert.equal(mock.variables._data[1], "encoded:25", "variable locks preserve engine encoding");
  await sendCommand("lock.clear");
  mock.variables.value = oldVariableValue; mock.variables.setValue = oldVariableSet; mock.variables._data[1] = 555;

  // 25. save-contents round trip (数据修改)
  const contents = await sendCommand("save.contents.get");
  assert.equal(contents.ok, true, contents.payload && contents.payload.error);
  assert.match(contents.payload.json, /"marker":"before"/);
  assert.equal(contents.payload.bytes, contents.payload.json.length);
  const tooBig = await sendCommand("save.contents.get", { limitBytes: 4 });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.payload.error, /over the 4 byte limit/);
  const applied = await sendCommand("save.contents.apply", {
    json: contents.payload.json.replace('"before"', '"after"'),
    reload: false
  });
  assert.equal(applied.ok, true, applied.payload && applied.payload.error);
  assert.equal(applied.payload.reloaded, false);
  assert.equal(sandbox.DataManager._extracted.marker, "after", "edited contents must reach extractSaveContents");

  // 26. scene push/pop
  const sceneInfo = await sendCommand("scene.info");
  assert.ok(sceneInfo.payload.available.includes("Scene_Item"), "Scene_Item must be offered");
  assert.ok(!sceneInfo.payload.available.includes("Scene_Equip"), "absent scenes must be filtered out");
  const pushed = await sendCommand("scene.push", { name: "Scene_Item" });
  assert.equal(pushed.payload.pushed, "Scene_Item");
  assert.equal(sandbox.SceneManager._stack.length, 1);
  const badScene = await sendCommand("scene.push", { name: "Scene_Nope" });
  assert.equal(badScene.ok, false);
  await sendCommand("scene.pop");
  assert.equal(sandbox.SceneManager._stack.length, 0);

  // 27. repair actions
  assert.equal(sandbox.$gameScreen._pictures.length, 3);
  await sendCommand("game.repair", { action: "clearPictures" });
  assert.equal(sandbox.$gameScreen._pictures.length, 0);
  await sendCommand("game.repair", { action: "fadeIn" });
  assert.equal(sandbox.$gameScreen._fadeIn, 24);
  await sendCommand("game.repair", { action: "clearCurrentEvent" });
  assert.equal(sandbox.$gameMap._interpreter.cleared, true);
  const badRepair = await sendCommand("game.repair", { action: "explode" });
  assert.equal(badRepair.ok, false);
  assert.match(badRepair.payload.error, /unsupported repair action/);

  // 28. map events
  const events = await sendCommand("map.events.list");
  assert.equal(events.payload.entries.length, 1);
  assert.deepEqual(events.payload.entries[0], {
    eventId: 1, name: "EV001", x: 4, y: 7, pageIndex: 0, pages: 1, commands: 2
  });
  const toEvent = await sendCommand("map.transferToEvent", { eventId: 1 });
  assert.deepEqual(toEvent.payload, { eventId: 1, x: 4, y: 7 });
  const noEvent = await sendCommand("map.transferToEvent", { eventId: 99 });
  assert.equal(noEvent.ok, false);

  // 29. actor detail extras used by the master-detail editor
  const nick = await sendCommand("actor.nickname.set", { id: 1, nickname: "Tester" });
  assert.equal(nick.payload.actor.nickname, "Tester");
  assert.deepEqual(nick.payload.actor.params, [10, 11, 12, 13, 14, 15, 16, 17]);
  const withState = await sendCommand("actor.state.add", { id: 1, stateId: 3 });
  assert.deepEqual(withState.payload.actor.states, [{ id: 3, name: "State3" }]);
  const withoutState = await sendCommand("actor.state.remove", { id: 1, stateId: 3 });
  assert.deepEqual(withoutState.payload.actor.states, []);

  // 30. battle.info over a non-empty troop. Regression guard: enemyNameOf was
  // called but never defined, so this threw ReferenceError for any real battle.
  sandbox.BattleManager._phase = "battle";
  const battleInfo = await sendCommand("battle.info");
  assert.equal(battleInfo.ok, true, battleInfo.error || "battle.info must not throw");
  assert.equal(battleInfo.payload.inBattle, true);
  assert.equal(battleInfo.payload.enemies.length, 2);
  assert.equal(battleInfo.payload.enemies[0].name, "Slime", "name() must be preferred");
  assert.equal(battleInfo.payload.enemies[1].name, "Bat", "$dataEnemies must be the fallback");
  assert.equal(battleInfo.payload.enemies[0].hp, 40);

  const hurt = await sendCommand("battle.enemy.setHp", { index: 0, value: 5 });
  assert.equal(hurt.payload.hp, 5);
  // MV die() clears states; alive/dead is determined by the death state.
  const deathStateEnemy = sandbox.$gameTroop.members()[0];
  deathStateEnemy._states = [];
  deathStateEnemy.die = function () { this._hp = 0; this._states = []; };
  deathStateEnemy.deathStateId = function () { return 1; };
  deathStateEnemy.addState = function (id) { this.die(); this._states.push(id); };
  deathStateEnemy.isAlive = function () { return this._states.indexOf(1) < 0; };
  // FT blocks ordinary state application for death, even with zero HP. Its
  // native addNewState is the forced-death path and still runs die().
  const guardedDeathEnemy = sandbox.$gameTroop.members()[1];
  guardedDeathEnemy._states = [];
  guardedDeathEnemy.die = function () { this._states = []; };
  guardedDeathEnemy.deathStateId = function () { return 1; };
  guardedDeathEnemy.addState = function () {};
  guardedDeathEnemy.addNewState = function (id) { this.die(); this._states.push(id); };
  guardedDeathEnemy.isAlive = function () { return this._states.indexOf(1) < 0; };
  const killed = await sendCommand("battle.killEnemies");
  assert.equal(killed.payload.killed, 2);
  assert.equal(killed.payload.remaining, 0);
  assert.equal(guardedDeathEnemy._hp, 0, "custom die() may only update states; forced defeat must also clear native HP");
  sandbox.BattleManager._phase = "init";

  // 31. suppressNoCost is honoured. withNoCostSuppressed used to bump a counter
  // that no hook read, so the profile API silently did nothing.
  await sendCommand("trainer.options.set", { options: { noSkillCost: true } });
  const actor = mock.actors[0];
  assert.equal(actor.canPaySkillCost(), true, "no-cost waives the check");
  assert.equal(actor.skillMpCost(), 0, "no-cost zeroes the MP cost");
  const bridgeObject = sandbox.window.__rmchBridge;
  bridgeObject.suppressNoCost += 1;
  try {
    assert.equal(actor.skillMpCost(), 5, "suppressNoCost must restore the real cost");
  } finally {
    bridgeObject.suppressNoCost -= 1;
  }
  assert.equal(actor.skillMpCost(), 0, "cost is waived again once the scope exits");
  await sendCommand("trainer.options.set", { options: { noSkillCost: false } });

  // 32. window-show watchdog: while the window has never been visible it
  // re-asserts show(); once the window reports visible it disarms for good,
  // so it never fights the user's own minimize later.
  await sleep(1700); // watchdog ticks every 1500ms
  assert.ok(mockWindow.showCount > 0, "watchdog must show a never-visible window");
  sandbox.document.visibilityState = "visible";
  await sleep(1700); // one tick to observe "visible" and disarm
  const shownBeforeDisarm = mockWindow.showCount;
  await sleep(1700);
  assert.equal(mockWindow.showCount, shownBeforeDisarm, "watchdog must disarm once the window is visible");

  // 33. A corrupt global save-info file can no longer brick New Game.
  // Regression: 再刷一把2 and 大千世界2 both crashed in
  // selectSavefileForNewGame → loadGlobalInfo ("Cannot convert undefined or
  // null to object") with a global.rpgsave that decodes to msgpack-nil. The
  // guard must catch the throw, quarantine the file (renamed, not deleted)
  // and retry down the missing-file path.
  const mockSaveDir = path.join(tempGameRoot, "www", "save");
  mkdirSync(mockSaveDir, { recursive: true });
  const globalFile = path.join(mockSaveDir, "global.rpgsave");
  writeFileSync(globalFile, "eJw7AAAAwQDB"); // the real 再刷一把2 payload: base64(zlib(msgpack nil))
  const guardWait = Date.now() + 5000;
  while (!sandbox.DataManager.loadGlobalInfo.__rmchPatched && Date.now() < guardWait) await sleep(100);
  assert.ok(sandbox.DataManager.loadGlobalInfo.__rmchPatched, "guard must patch loadGlobalInfo");
  const guardedInfo = sandbox.DataManager.loadGlobalInfo();
  assert.deepEqual(guardedInfo, [], "throwing loadGlobalInfo must degrade to []");
  assert.ok(!existsSync(globalFile), "corrupt global file must be quarantined");
  const quarantined = readdirSync(mockSaveDir).filter((name) => name.startsWith("global.rpgsave.corrupt-"));
  assert.equal(quarantined.length, 1, "quarantine must keep a renamed backup, not delete");
  assert.equal(sandbox.DataManager._globalCalls, 2, "guard must retry the original after quarantining");
  const infoAgain = sandbox.DataManager.loadGlobalInfo();
  assert.deepEqual(infoAgain, [], "missing-file path must now serve [] without drama");
  assert.equal(sandbox.DataManager._globalCalls, 3);

  // 34. Closure-sealed shell (nb-evalnwbin): no engine globals on window at
  // all. The save-contents capture (08-capture.js) must pick the live
  // singletons out of the next save/load and every resolver falls back to it.
  const savedGlobals = {};
  for (const name of [
    "$gameParty", "$gameSwitches", "$gameVariables", "$gameSelfSwitches",
    "$gameActors", "$gameMap", "$gamePlayer", "$gameScreen", "$gameSystem",
    "$gameTroop", "$gameTemp",
    "$dataSystem", "$dataItems", "$dataWeapons", "$dataArmors", "$dataSkills",
    "$dataActors", "$dataMapInfos", "$dataCommonEvents", "$dataEnemies",
    "SceneManager"
  ]) {
    savedGlobals[name] = sandbox[name];
    delete sandbox[name];
  }
  const sealedParty = await sendCommand("party.info");
  assert.equal(sealedParty.payload.gold, null, "without a capture the party is gone");
  const sealedGold = await sendCommand("gold.set", { value: 100 });
  assert.equal(sealedGold.ok, false, "gold.set must fail while nothing resolves");
  const sealedSwitches = await sendCommand("switch.list", {});
  assert.equal(sealedSwitches.ok, false, "switch.list must fail while $dataSystem and the store are both gone");

  // Simulate the game saving: saveContents holds the LIVE singletons and goes
  // through the realm's JSON.stringify, which the tap patched at startup.
  const sealedContents = {
    system: savedGlobals.$gameSystem,
    screen: savedGlobals.$gameScreen,
    timer: {},
    switches: mock.switches,
    variables: mock.variables,
    selfSwitches: savedGlobals.$gameSelfSwitches,
    actors: savedGlobals.$gameActors,
    party: mock.party,
    map: savedGlobals.$gameMap,
    player: savedGlobals.$gamePlayer
  };
  sandbox.__testContents = sealedContents;
  vm.runInContext("JSON.stringify(window.__testContents)", context);
  assert.ok(sandbox.__rmchCapture, "tap must capture saveContents on stringify");
  assert.equal(sandbox.__rmchCapture.party, mock.party, "capture must hold the live party object");

  const capturedGold = await sendCommand("gold.set", { value: 4321 });
  assert.equal(capturedGold.ok, true, `gold.set via capture failed: ${JSON.stringify(capturedGold)}`);
  assert.equal(mock.party._gold, 4321, "capture-backed party must be the live object");
  const info34 = await sendCommand("party.info");
  assert.equal(info34.payload.gold, 4321);
  assert.equal(info34.payload.members.length, 2);

  // Switches/variables: no $dataSystem → numbered, unnamed entries driven by
  // the captured store's own size. Group 3 left switch 1 = true.
  const swList34 = await sendCommand("switch.list", {});
  assert.equal(swList34.ok, true, `switch.list via capture failed: ${JSON.stringify(swList34)}`);
  assert.equal(swList34.payload.namesUnavailable, true);
  const sw1 = swList34.payload.entries.find((e) => e.id === 1);
  assert.equal(sw1 && sw1.value, true);
  assert.equal(sw1 && sw1.name, "", "no names without $dataSystem");
  assert.equal((await sendCommand("switch.set", { id: 2, value: true })).payload.value, true);
  assert.equal(mock.switches.value(2), true, "capture-backed switches must be the live store");
  assert.equal((await sendCommand("variable.set", { id: 3, value: 555 })).payload.value, 555);
  assert.equal(mock.variables.value(3), 555);

  // Items: $dataItems is gone, but the party's own items() returns the data
  // objects — owned items keep their names and stay editable. Group 4 left
  // item 1 at count 9.
  const inv34 = await sendCommand("item.list");
  const potion34 = inv34.payload.entries.find((e) => e.kind === "item" && e.id === 1);
  assert.equal(potion34 && potion34.name, "Potion", "owned item name comes from party.items()");
  assert.equal(potion34 && potion34.count, mock.party._items[1]);
  assert.equal((await sendCommand("item.set", { kind: "item", id: 1, count: 30 })).payload.count, 30);
  assert.equal(mock.party._items[1], 30);
  const unowned = await sendCommand("item.set", { kind: "item", id: 99, count: 1 });
  assert.equal(unowned.ok, false, "unowned item without a catalog must fail cleanly");

  // Map/player resolve through the capture too.
  const loc = await sendCommand("player.location");
  assert.equal(loc.payload.x, savedGlobals.$gamePlayer._x);
  assert.equal(loc.payload.y, savedGlobals.$gamePlayer._y);
  const mapInfo = await sendCommand("map.info");
  assert.equal(mapInfo.payload.mapId, 1);

  // A load REPLACES the singletons; the tap must refresh the capture (latest
  // save wins) rather than pin the pre-load objects.
  const replacementParty = { _gold: 77, _items: {}, gold() { return this._gold; }, gainGold(v) { this._gold += v; }, gainItem() {}, allMembers() { return []; }, members() { return []; }, battleMembers() { return []; }, inBattle() { return false; } };
  const contents2 = { ...sealedContents, party: replacementParty };
  sandbox.__testContents2 = contents2;
  vm.runInContext("JSON.stringify(window.__testContents2)", context);
  assert.equal(sandbox.__rmchCapture.party, replacementParty, "capture must refresh on the next save");
  assert.equal((await sendCommand("party.info")).payload.gold, 77);

  // 34b. gold fallback: sabotaged gainGold must not take gold.set/add down.
  // 傲世修仙录定制版 ships a gainGold that throws outside its own UI flow
  // ("constructor of null") and protected shells have shipped silent no-ops —
  // applyGoldDelta verifies the landing value and writes the container
  // directly when the polite path dies or lies.
  const throwingParty = { _gold: 100, _items: {}, gold() { return this._gold; }, gainGold() { throw new Error("Cannot read property 'constructor' of null"); }, gainItem() {}, allMembers() { return []; }, members() { return []; }, battleMembers() { return []; }, inBattle() { return false; } };
  sandbox.__testContents3 = { ...sealedContents, party: throwingParty };
  vm.runInContext("JSON.stringify(window.__testContents3)", context);
  assert.equal((await sendCommand("gold.add", { amount: 50 })).payload.gold, 150,
    "gold.add must fall back to a direct write when gainGold throws");
  assert.equal(throwingParty._gold, 150);
  assert.equal((await sendCommand("gold.set", { value: 200 })).payload.gold, 200,
    "gold.set must fall back to a direct write when gainGold throws");
  assert.equal(throwingParty._gold, 200);

  const silentParty = { _gold: 100, _items: {}, gold() { return this._gold; }, gainGold() {}, gainItem() {}, allMembers() { return []; }, members() { return []; }, battleMembers() { return []; }, inBattle() { return false; } };
  sandbox.__testContents4 = { ...sealedContents, party: silentParty };
  vm.runInContext("JSON.stringify(window.__testContents4)", context);
  assert.equal((await sendCommand("gold.add", { amount: 25 })).payload.gold, 125,
    "gold.add must fall back when gainGold silently no-ops");
  assert.equal(silentParty._gold, 125);

  // Hand the capture back to the party the later save-encoding assertions
  // expect (they pin its _gold at 77).
  vm.runInContext("JSON.stringify(window.__testContents2)", context);
  assert.equal(sandbox.__rmchCapture.party, replacementParty);

  // 35. Boot-time database capture. Sealed shells decrypt the $data* tables
  // inside their blob and parse them through the tapped JSON.parse; shape
  // classification fills __rmchDataTables, a debounced flush persists them to
  // catalog-cache.json, and catalog/system-name queries fall back to them.
  sandbox.__db = {
    items: JSON.stringify([null,
      { id: 1, name: "Elixir", iconIndex: 176, price: 50, itypeId: 1, consumable: true },
      { id: 2, name: "凤凰尾巴", iconIndex: 177, price: 100, itypeId: 2, consumable: true }
    ]),
    system: JSON.stringify({
      gameTitle: "sealed", currencyUnit: "G",
      switches: ["", "主线开关", "机关B"], variables: ["", "计数器"],
      terms: { basic: ["等级"] }
    }),
    maps: JSON.stringify([null,
      { id: 1, name: "起始之村", parentId: 0, order: 1 },
      { id: 2, name: "地下室", parentId: 1, order: 2 }
    ])
  };
  vm.runInContext("JSON.parse(window.__db.items); JSON.parse(window.__db.system); JSON.parse(window.__db.maps);", context);
  assert.ok(sandbox.__rmchDataTables, "db parse must fill __rmchDataTables");
  assert.equal(sandbox.__rmchDataTables.item[2].name, "凤凰尾巴");
  assert.equal(sandbox.__rmchDataTables.system.switches[1], "主线开关");
  assert.equal(sandbox.__rmchDataTables.mapInfo[2].name, "地下室");

  // Non-db shapes must not be classified: no null hole at [0], and mixed
  // element shapes are rejected even with the hole.
  vm.runInContext("JSON.parse('[{\"wtypeId\":1,\"params\":[]},{\"wtypeId\":2,\"params\":[]}]')", context);
  assert.ok(!sandbox.__rmchDataTables.weapon, "0-based array must not classify");
  vm.runInContext("JSON.parse('[null,{\"wtypeId\":1,\"params\":[]},{\"itypeId\":1,\"price\":3}]')", context);
  assert.ok(!sandbox.__rmchDataTables.weapon, "mixed-shape array must not classify");

  // Catalog/system-name/map queries fall back to the captured tables (the
  // window globals were deleted in group 34).
  const cat35 = await sendCommand("catalog.query", { kind: "item", limit: 20000 });
  assert.equal(cat35.payload.total, 2, `captured item catalog failed: ${JSON.stringify(cat35)}`);
  const sw35 = await sendCommand("switch.list", {});
  assert.equal(sw35.payload.namesUnavailable, false, "captured $dataSystem must restore names");
  assert.equal(sw35.payload.entries.find((e) => e.id === 1).name, "主线开关");
  const map35 = await sendCommand("map.list", {});
  assert.equal(map35.payload.total, 2, `captured mapInfo catalog failed: ${JSON.stringify(map35)}`);

  // The debounced flush persists the tables next to the state channel.
  await sleep(1500);
  const cachePath35 = path.join(bridgeDir, "catalog-cache.json");
  assert.ok(existsSync(cachePath35), "catalog-cache.json must be written");
  const cache35 = JSON.parse(readFileSync(cachePath35, "utf8"));
  assert.equal(cache35.tables.item[1].name, "Elixir");
  assert.equal(cache35.tables.system.variables[1], "计数器");

  // Flush merges over the existing cache (this boot's captures win) — a
  // mid-boot reload round must never shrink an earlier round's tables.
  writeFileSync(cachePath35, JSON.stringify({
    version: 1, capturedAt: "2026-01-01T00:00:00.000Z",
    tables: { weapon: [null, { id: 1, name: "OldBlade", wtypeId: 1, params: [0, 0, 0, 0, 0, 0, 0, 0] }] }
  }));
  vm.runInContext("JSON.parse('[null,{\"id\":1,\"name\":\"重甲\",\"atypeId\":1,\"etypeId\":2,\"price\":30}]')", context);
  await sleep(1500);
  const cache35b = JSON.parse(readFileSync(cachePath35, "utf8"));
  assert.equal(cache35b.tables.weapon[1].name, "OldBlade", "flush must keep disk-only kinds");
  assert.equal(cache35b.tables.armor[1].name, "重甲", "flush must add newly captured kinds");
  assert.equal(cache35b.tables.item[1].name, "Elixir", "flush must keep in-memory kinds");

  // A fresh bridge (no in-memory tables) lazy-loads the cache from disk on
  // the first catalog miss. The delete must run INSIDE the vm: properties the
  // bridge assigned live on the context global, invisible to an outside delete.
  vm.runInContext("delete window.__rmchDataTables; delete window.__rmchDataTablesLoaded;", context);
  const cat35b = await sendCommand("catalog.query", { kind: "item", limit: 20000 });
  assert.equal(cat35b.payload.total, 2, "catalog must come back from the disk cache");
  assert.ok(sandbox.__rmchDataTables, "lazy load must repopulate __rmchDataTables");

  // Live-preference: a DEAD JsonEx-encoded save copy (stringify side) must not
  // evict the live capture; a load-side parse always replaces.
  sandbox.__deadSave = JSON.parse(JSON.stringify({
    system: {}, screen: {}, timer: {}, switches: {}, variables: {},
    selfSwitches: {}, actors: {}, party: { _gold: 999 }, map: {}, player: {}
  }));
  vm.runInContext("JSON.stringify(window.__deadSave)", context);
  assert.equal(sandbox.__rmchCapture.party, replacementParty,
    "encoded save copy must not evict the live capture");
  vm.runInContext("JSON.parse(JSON.stringify(window.__deadSave))", context);
  assert.equal(sandbox.__rmchCapture.party._gold, 999,
    "load-side parse always replaces the capture");

  // 36. bootTap replay: the launch/dance bootstrap's holding tap piles
  // boot-time db parses into window.__rmchBootParsed before the canvas gate
  // lets the full bridge eval. A fresh bridge on that context must replay the
  // pile through the real classifier and flush it to catalog-cache.json.
  const tempGameRoot2 = mkdtempSync(path.join(tmpdir(), "rmch-game2-"));
  const tempProjectRoot2 = mkdtempSync(path.join(tmpdir(), "rmch-project2-"));
  const bridgeDir2 = path.join(tempProjectRoot2, "runtime", "bridge-state", "mock-game-2");
  const sandbox2 = {};
  sandbox2.window = sandbox2;
  sandbox2.location = { href: "file:///game/www/index.html" };
  sandbox2.console = console;
  sandbox2.setTimeout = setTimeout;
  sandbox2.setInterval = setInterval;
  sandbox2.clearInterval = clearInterval;
  sandbox2.clearTimeout = clearTimeout;
  sandbox2.addEventListener = () => {};
  sandbox2.require = require;
  sandbox2.process = {
    ...process,
    env: {
      ...process.env,
      RMCH_GAME_ROOT: tempGameRoot2,
      RMCH_PROJECT_ROOT: tempProjectRoot2,
      RMCH_GAME_KEY: "mock-game-2",
      RMCH_WS_PORT: "59998",
      RMCH_WS_TOKEN: "unused"
    },
    cwd: () => tempGameRoot2
  };
  sandbox2.WebSocket = class {
    constructor() { setTimeout(() => { if (this.onclose) this.onclose(); }, 0); }
    send() { return true; }
  };
  sandbox2.XMLHttpRequest = undefined;
  sandbox2.document = {
    createElement: () => ({ set textContent(v) {}, get textContent() { return ""; } }),
    documentElement: null,
    visibilityState: "visible"
  };
  sandbox2.nw = { Window: { get: () => ({ show() {} }) } };
  sandbox2.eval = eval;
  // The pile as the holding tap would have left it: two db tables, one
  // save-shaped object, and one hole-array that is NOT a db table.
  sandbox2.__rmchBootParsed = [
    [null,
      { id: 1, name: "回城卷轴", iconIndex: 176, price: 50, itypeId: 1, consumable: false },
      { id: 2, name: "龙血丹", iconIndex: 177, price: 300, itypeId: 2, consumable: true }
    ],
    {
      gameTitle: "sealed2", currencyUnit: "灵石",
      switches: ["", "剧情开关"], variables: ["", "境界"],
      terms: { basic: ["境界"] }
    },
    { system: {}, party: { _gold: 5 }, map: {}, player: {} },
    [null, { foo: 1 }, { bar: 2 }]
  ];
  const context2 = vm.createContext(sandbox2);
  vm.runInContext(bridgeSource, context2, { filename: "page-bridge.js" });
  assert.ok(sandbox2.__rmchBridge, "sandbox2 bridge must attach");
  assert.equal(sandbox2.__rmchBootParsed, null, "replay must release the pile");
  assert.ok(sandbox2.__rmchDataTables, "replay must fill __rmchDataTables");
  assert.equal(sandbox2.__rmchDataTables.item[2].name, "龙血丹");
  assert.equal(sandbox2.__rmchDataTables.system.switches[1], "剧情开关");
  assert.equal(Object.keys(sandbox2.__rmchDataTables).length, 2, "junk hole-array must not classify");
  assert.equal(sandbox2.__rmchCapture && sandbox2.__rmchCapture.party._gold, 5,
    "save-shaped pile entry must feed the capture");
  await sleep(1500);
  const cachePath36 = path.join(bridgeDir2, "catalog-cache.json");
  assert.ok(existsSync(cachePath36), "replayed tables must flush to catalog-cache.json");
  const cache36 = JSON.parse(readFileSync(cachePath36, "utf8"));
  assert.equal(cache36.tables.item[1].name, "回城卷轴");
  assert.equal(cache36.tables.system.variables[1], "境界");
  rmSync(tempGameRoot2, { recursive: true, force: true });
  rmSync(tempProjectRoot2, { recursive: true, force: true });

  rmSync(tempGameRoot, { recursive: true, force: true });
  rmSync(tempProjectRoot, { recursive: true, force: true });
  console.log("bridge harness test: PASS (36 groups)");
  process.exit(0);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
