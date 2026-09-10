import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const locks = {
  gold: 12,
  item: { 1: 3 },
  weapon: {},
  armor: {},
  switch: { 1: true },
  variable: {}
};
const context = vm.createContext({
  window: {},
  commandHandlers: {},
  bridge: { valueLocks: locks, lockStats: {} },
  requireNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw Error("number");
    return number;
  },
  resolveParty: () => ({}),
  dataEntryLoose: (kind, id) => ({ kind, id }),
  customInventory: () => ({
    validateLock(data, value) {
      if (data.kind !== "item" || data.id === 2 || value > 1000)
        throw Error("unsupported custom lock");
    }
  })
});
for (const name of ["50-value-locks.js", "66-commands-saves.js"]) {
  vm.runInContext(
    fs.readFileSync(
      new URL("../runtime/bridge/src/parts/" + name, import.meta.url),
      "utf8"
    ),
    context
  );
}
const commands = context.commandHandlers;
commands["lock.set"]({ kind: "item", id: 1, value: 5 });
assert.equal(locks.item[1], 5);
const fractional = commands["lock.set"]({
  kind: "variable",
  id: 1,
  value: 1.5
});
assert.equal(
  fractional.value,
  1,
  "numeric variable locks use the native setter integer contract"
);
let nativeValue = 0;
context.writeLockedSlots(locks.variable, {
  _data: [],
  value: () => nativeValue,
  setValue: (id, value) => {
    nativeValue = Math.floor(value);
  }
});
assert.equal(
  nativeValue,
  fractional.value,
  "the reported lock target matches the native stored value"
);
for (const args of [
  { kind: "item", id: 2, value: 5 },
  { kind: "weapon", id: 1, value: 1 },
  { kind: "item", id: 1, value: 1001 }
]) {
  assert.throws(() => commands["lock.set"](args), /unsupported custom lock/);
}
assert.deepEqual(locks.item, { 1: 5 });
const before = JSON.stringify(locks);
assert.throws(
  () =>
    commands["lock.replace"]({
      locks: { gold: 999, item: { 1: 7 }, weapon: { 1: 2 } }
    }),
  /unsupported custom lock/
);
assert.equal(
  JSON.stringify(locks),
  before,
  "a rejected batch preserves all previous locks"
);
commands["lock.replace"]({
  locks: { gold: 30, item: { 1: 7 }, variable: { 2: 4 } }
});
assert.equal(locks.item[1], 7);
assert.equal(locks.gold, 30);
assert.equal(locks.variable[2], 4);
commands["lock.set"]({ kind: "weapon", id: 1, enabled: false });
assert.equal(
  Object.keys(locks.weapon).length,
  0,
  "unsupported persisted locks can still be removed"
);
console.log(
  "PASS custom inventory lock validation and atomic bulk replacement"
);
