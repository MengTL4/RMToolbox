import assert from "node:assert/strict";
import vm from "node:vm";
import {
  SEALED_SEED_FN,
  buildSelfSeedBootstrap
} from "../core/sealed-seed.mjs";
function Scene_Base() {}
Scene_Base.prototype.create = function () {};
Scene_Base.prototype.start = function () {};
function Scene_Map() {}
Scene_Map.prototype = Object.create(Scene_Base.prototype);
Scene_Map.prototype.constructor = Scene_Map;
Scene_Map.prototype.onMapLoaded = function () {};
Scene_Map.prototype.processMapTouch = function () {};
function Scene_Item() {}
Scene_Item.prototype = Object.create(Scene_Base.prototype);
Scene_Item.prototype.constructor = Scene_Item;
const troops = [
  null,
  { id: 1, name: "native troop", members: [{ enemyId: 1 }], pages: [] }
];
const classes = [
  null,
  {
    id: 1,
    name: "native class",
    expParams: [30, 20, 30, 30],
    learnings: [],
    params: []
  }
];
function Game_Interpreter() {}
Game_Interpreter.prototype.initialize = function () {};
Game_Interpreter.prototype.executeCommand = function () {};
Game_Interpreter.prototype.command101 = function () {};
Object.defineProperty(Scene_Map, "name", { value: "_0xmap" });
Object.defineProperty(Game_Interpreter, "name", { value: "_0xinterpreter" });
const window = {};
const message = {
  _texts: [],
  _choices: [],
  isBusy() {
    return false;
  },
  add() {}
};
const seed = vm.runInNewContext("(" + SEALED_SEED_FN + ")", {
  window,
  console
});
seed.call([Scene_Map, Scene_Item, Game_Interpreter, troops, classes, message]);
assert.equal(
  window.Scene_Map,
  Scene_Map,
  "sealed native map constructor must be available for load/new game"
);
assert.equal(
  window.Scene_Item,
  Scene_Item,
  "sealed native menu constructor must be available"
);
assert.equal(
  window.$dataTroops,
  troops,
  "native troop records have pages, not a turns field"
);
assert.equal(
  window.$dataClasses,
  classes,
  "sealed class table is required for class selection and validation"
);
assert.equal(
  window.Game_Interpreter,
  Game_Interpreter,
  "save prototypes must resolve even without a live singleton"
);
assert.equal(
  window._0xinterpreter,
  Game_Interpreter,
  "JsonEx resolves the actual obfuscated constructor name"
);
assert.equal(
  window.$gameMessage,
  message,
  "native message state is available for dialogue-aware commands"
);
console.log("sealed scene and troop publication PASS");
function HiddenEnd() {}
HiddenEnd.prototype = Object.create(Scene_Base.prototype);
HiddenEnd.prototype.constructor = HiddenEnd;
HiddenEnd.prototype.commandToTitle = () => {};
HiddenEnd.prototype.createCommandWindow = () => {};
seed.call([HiddenEnd]);
assert.equal(
  window.Scene_GameEnd,
  HiddenEnd,
  "publish renamed native end menu"
);

function BootSceneManager() {}
BootSceneManager._scene = { constructor: { name: "Scene_Boot" } };
BootSceneManager._stack = [];
BootSceneManager.run = () => {};
const bootWindow = {};
const bootResult = vm
  .runInNewContext("(" + SEALED_SEED_FN + ")", { window: bootWindow, console })
  .call([BootSceneManager, troops]);
assert.equal(bootResult.partial, true);
assert.equal(
  bootWindow.$dataTroops,
  undefined,
  "wait for native boot metadata processing before publishing tables"
);

const loadWindow = {};
let liveParty = { _gold: 0, _items: {}, _actors: [] };
function NativeDataManager() {}
NativeDataManager._databaseFiles = [];
NativeDataManager.isDatabaseLoaded = () => true;
NativeDataManager.makeSaveContents = () => {
  throw new Error("map has not loaded yet");
};
NativeDataManager.extractSaveContents = (contents) => {
  liveParty = contents.party;
};
vm.runInNewContext("(" + SEALED_SEED_FN + ")", {
  window: loadWindow,
  console
}).call([NativeDataManager, liveParty]);
const loadedParty = { _gold: 10, _items: {}, _actors: [1] };
NativeDataManager.extractSaveContents({ party: loadedParty });
assert.equal(
  loadWindow.$gameParty,
  loadedParty,
  "publish native extracted objects when save metadata needs an unloaded map"
);

const nativeItems = [
  null,
  { id: 1, itypeId: 1, name: "native item" },
  { id: 2, itypeId: 1, name: "another item" }
];
const copiedItems = JSON.parse(JSON.stringify(nativeItems));
NativeDataManager.isItem = (item) => nativeItems.includes(item);
const itemWindow = {};
vm.runInNewContext("(" + SEALED_SEED_FN + ")", {
  window: itemWindow,
  console
}).call([nativeItems.slice(1), copiedItems, nativeItems, NativeDataManager]);
assert.equal(
  itemWindow.$dataItems,
  nativeItems,
  "native inventory identity must win over a cached JSON copy"
);

const actorRecords = [
  null,
  { id: 1, name: "native actor", profile: "", meta: {} }
];
const actorInstances = [
  null,
  {
    profile() {
      return "";
    },
    name() {
      return "native actor";
    }
  }
];
const actorWindow = {};
vm.runInNewContext("(" + SEALED_SEED_FN + ")", {
  window: actorWindow,
  console
}).call([actorInstances, actorRecords]);
assert.equal(
  actorWindow.$dataActors,
  actorRecords,
  "live actor instances are not database records"
);

function MVStorageManager() {}
MVStorageManager.save = () => {};
MVStorageManager.load = () => {};
MVStorageManager.localFileDirectoryPath = () => "/native/save";
const storageWindow = {};
vm.runInNewContext("(" + SEALED_SEED_FN + ")", {
  window: storageWindow,
  console
}).call([MVStorageManager]);
assert.equal(
  storageWindow.StorageManager,
  MVStorageManager,
  "publish native MV filesystem storage manager"
);

function Scene_File() {}
Scene_File.prototype = Object.create(Scene_Base.prototype);
Scene_File.prototype.onLoadSuccess = () => {};
Scene_File.prototype.onLoadFailure = () => {};
function Scene_Load() {}
Scene_Load.prototype = Object.create(Scene_File.prototype);
const sceneWindow = {};
vm.runInNewContext("(" + SEALED_SEED_FN + ")", {
  window: sceneWindow,
  console
}).call([Scene_File, Scene_Load]);
assert.equal(
  sceneWindow.Scene_Load,
  Scene_Load,
  "an exact native scene name wins over a superclass signature"
);

for (const failQuery of [false, true]) {
  const calls = [];
  const page = {};
  const chrome = {
    runtime: {},
    debugger: {
      getTargets(callback) {
        callback([
          { id: "unrelated", type: "page", url: "other" },
          { id: "own", type: "page", url: "game" }
        ]);
      },
      attach(target, version, callback) {
        assert.equal(target.targetId, "own");
        calls.push("attach");
        callback();
      },
      detach(target, callback) {
        assert.equal(target.targetId, "own");
        calls.push("detach");
        callback();
      },
      sendCommand(target, method, params, callback) {
        assert.equal(target.targetId, "own");
        calls.push(method);
        if (method === "Runtime.queryObjects" && failQuery) {
          chrome.runtime.lastError = { message: "probe failed" };
          callback();
          delete chrome.runtime.lastError;
          return;
        }
        if (method === "Runtime.evaluate")
          callback({ result: { objectId: "proto" } });
        else if (method === "Runtime.queryObjects")
          callback({ objects: { objectId: "heap" } });
        else if (method === "Runtime.callFunctionOn") {
          assert.equal(params.functionDeclaration, SEALED_SEED_FN);
          page.__rmchSealed = { seeded: true };
          callback({ result: { value: { partial: false } } });
        } else callback({});
      }
    }
  };
  const context = vm.createContext({
    window: page,
    location: { href: "game" },
    chrome,
    setTimeout() {
      return 0;
    }
  });
  await vm.runInContext(buildSelfSeedBootstrap(), context);
  assert.ok(
    calls.includes("Runtime.releaseObjectGroup"),
    "release heap handles on both success and failure"
  );
  assert.equal(
    calls.at(-1),
    "detach",
    "detach the debugger after each attempt"
  );
  const count = calls.length;
  await vm.runInContext(buildSelfSeedBootstrap(), context);
  assert.equal(calls.length, count, "one resident seeder per game page");
}
console.log("sealed self debugger transport PASS");
