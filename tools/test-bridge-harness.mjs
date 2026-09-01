// Bridge harness test: run runtime/bridge/page-bridge.js inside a vm sandbox
// with a mock RPG Maker MV game, drive commands through the JSONL queue and
// verify events, state and hook behaviour. No real game process involved.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
    extractSaveContents(contents) { this._extracted = contents; }
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
  const transfer = await sendCommand("map.transfer", { mapId: 2, x: 5, y: 6 });
  assert.deepEqual(transfer.payload, { mapId: 2, x: 5, y: 6, direction: 2, fade: 0 });
  assert.equal(sandbox.$gamePlayer._transfer.mapId, 2);
  const through = await sendCommand("map.through.toggle");
  assert.equal(through.payload.through, true);

  // 13. map list
  const maps = await sendCommand("map.list");
  assert.equal(maps.payload.total, 2);

  // 14. common event
  const ce = await sendCommand("commonEvent.run", { id: 1 });
  assert.equal(ce.payload.name, "CE1");

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
  const killed = await sendCommand("battle.killEnemies");
  assert.equal(killed.payload.killed, 2);
  assert.equal(killed.payload.remaining, 0);
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

  rmSync(tempGameRoot, { recursive: true, force: true });
  rmSync(tempProjectRoot, { recursive: true, force: true });
  console.log("bridge harness test: PASS (32 groups)");
  process.exit(0);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
