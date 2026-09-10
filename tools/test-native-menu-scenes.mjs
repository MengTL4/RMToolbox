import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
function HiddenItem() {}
function HiddenSkill() {}
function HiddenEquip() {}
HiddenItem.prototype.createItemWindow = function () {};
HiddenSkill.prototype.createSkillTypeWindow = function () {};
HiddenEquip.prototype.createSlotWindow = function () {};
const originalPush = () => {
  throw Error("discovery must not navigate");
};
const manager = { push: originalPush, _stack: [] };
function Menu() {}
Menu.prototype.commandItem = function () {
  manager.push(HiddenItem);
};
Menu.prototype.onPersonalOk = function () {
  manager.push(
    this._commandWindow.currentSymbol() === "skill" ? HiddenSkill : HiddenEquip
  );
};
const window = { TK: { $: { SceneMrg: manager } }, Scene_Menu: Menu };
const context = {
  window,
  commandHandlers: {},
  resolveSceneManager: () => manager,
  isNativeFramePacingTarget: () => false
};
vm.runInNewContext(
  fs.readFileSync("runtime/bridge/src/parts/68-commands-system.js", "utf8"),
  context
);
const info = context.commandHandlers["scene.info"]();
assert.ok(info.available.includes("Scene_Item"));
assert.equal(window.Scene_Item, HiddenItem);
assert.equal(window.Scene_Skill, HiddenSkill);
assert.equal(window.Scene_Equip, HiddenEquip);
assert.equal(manager.push, originalPush);
assert.equal(manager._stack.length, 0);
manager._scene = new HiddenSkill();
assert.equal(context.commandHandlers["scene.info"]().current, "Scene_Skill");
delete window.Scene_Equip;
Menu.prototype.onPersonalOk = function () {
  throw Error("plugin requires a live menu");
};
context.commandHandlers["scene.info"]();
assert.equal(
  manager.push,
  originalPush,
  "restore dispatcher on plugin failure"
);
console.log(
  "PASS native menu scene discovery, canonical identity and dispatcher restoration"
);

const actor = { actorId: () => 1 };
let selected = 0,
  pushed;
context.resolveParty = () => ({
  menuActor: () => actor,
  setMenuActor: (a) => {
    selected = a.actorId();
  }
});
context.requireSceneManager = () => ({
  push: (ctor) => {
    assert.equal(selected, 1, "selection must precede native scene creation");
    pushed = ctor;
  }
});
context.commandHandlers["scene.push"]({ name: "Scene_Item" });
assert.equal(pushed, HiddenItem);
context.resolveParty = () => ({
  menuActor: () => null,
  setMenuActor: () => {
    throw Error("invalid selection");
  }
});
assert.throws(
  () => context.commandHandlers["scene.push"]({ name: "Scene_Skill" }),
  /没有可用于/
);
console.log("PASS native menu actor selection and empty-party guard");
const ftParty = {
  menuActor: () => actor,
  setMenuActor: () => {},
  members: () => [{}, actor]
};
context.resolveParty = () => ftParty;
context.isNativeFramePacingTarget = () => true;
context.requireSceneManager = () => ({
  push: () => assert.equal(ftParty._TkSpIndex, 1)
});
context.commandHandlers["scene.push"]({ name: "Scene_Skill" });
context.isNativeFramePacingTarget = () => false;
console.log(
  "PASS FT native personal-menu party position is prepared before scene creation"
);
function RemovedDebug() {}
RemovedDebug.prototype.create = function () {
  ThSce_MenuBase.prototype.create.call(this);
};
window.Scene_Debug = window.ThSce_Debug = RemovedDebug;
assert.equal(
  context.commandHandlers["scene.info"]().available.includes("Scene_Debug"),
  false
);
assert.throws(
  () => context.commandHandlers["scene.push"]({ name: "Scene_Debug" }),
  /unavailable/
);
RemovedDebug.prototype.create = function () {
  this.createRangeWindow();
};
assert.equal(
  context.commandHandlers["scene.info"]().available.includes("Scene_Debug"),
  true
);
console.log("PASS removed native debug menu is not advertised or entered");
