// Run only against tools/debug/homecoming-session.mjs's disposable copy.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const endpoint =
  "http://127.0.0.1:" + (Number(process.env.RMCH_TEST_PORT) || 19433);
const results = [];
async function request(q) {
  const r = await (
    await fetch(endpoint, { method: "POST", body: JSON.stringify(q) })
  ).json();
  if (!r.ok) throw Error(r.error);
  return r.out;
}
const send = (type, args = {}) => request({ type, args });
const evaluate = (code) => request({ eval: code });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function test(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log("PASS", name, detail || "");
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log("FAIL", name, e.message);
  }
}
const identity = JSON.parse(
  await evaluate(
    `JSON.stringify({root:window.__rmchEnv.RMCH_GAME_ROOT,url:location.href})`
  )
);
assert.ok(
  fs.existsSync(path.join(identity.root, ".rmch-isolated-test")),
  "refusing to mutate an unmarked game"
);
await test("isolated root and browser origin", async () => {
  assert.match(identity.url, /tauri.localhost/);
  return identity;
});
await test("runtime and installed hooks", async () => {
  const x = await send("runtime.info");
  assert.equal(x.engine.maker, "MV");
  assert.ok(x.hooks.targets.length >= 29);
  return x.engine.makerVersion + " / " + x.hooks.targets.length + " hooks";
});
await test("ping", async () => assert.ok((await send("ping")).bridgeVersion));
await test("scene and player", async () => {
  assert.ok((await send("scene.info")).current);
  assert.ok((await send("player.location")).mapId);
});
await test("all trainer options roundtrip", async () => {
  const old = (await send("trainer.options.get")).options;
  const next = {
    ...old,
    expRate: 2,
    goldRate: 2,
    dropRate: 2,
    noSkillCost: true,
    oneHitKill: true,
    invincible: true,
    lockHp: true,
    lockHpMax: true,
    lockHpVal: 25,
    lockMp: true,
    lockMpVal: 1,
    lockTp: true,
    lockTpVal: 10,
    moveSpeedAdd: 1,
    gameSpeedMulti: 2,
    speedHoldCtrl: true,
    throughWalls: true,
    noEncounter: true,
    showFollowers: false,
    alwaysDash: true
  };
  await send("trainer.options.set", next);
  assert.deepEqual((await send("trainer.options.get")).options, next);
  await send("trainer.options.set", old);
});
await test("gold set/add", async () => {
  await send("gold.set", { value: 1000 });
  assert.equal((await send("party.info")).gold, 1000);
  await send("gold.add", { amount: 50 });
  assert.equal((await send("party.info")).gold, 1050);
});
for (const kind of [
  "item",
  "weapon",
  "armor",
  "skill",
  "state",
  "actor",
  "enemy",
  "troop"
])
  await test("catalog " + kind, async () => {
    const x = await send("catalog.query", { kind, limit: 5 });
    assert.ok(x.total > 0);
    return x.total;
  });
await test("inventory set/list/remove", async () => {
  const item = (
    await send("catalog.query", { kind: "item", limit: 10 })
  ).entries.find((x) => x.name);
  await send("item.set", { kind: "item", id: item.id, count: 3 });
  assert.ok(
    (await send("item.list")).entries.some(
      (x) => x.id === item.id && x.count === 3
    )
  );
  await send("item.set", { kind: "item", id: item.id, count: 0 });
});
const actorId = (await send("party.info")).members[0].id;
await test("actor exp/level", async () => {
  await send("actor.exp.add", { id: actorId, amount: 100 });
  await send("actor.level.set", { id: actorId, level: 5 });
  assert.equal((await send("actor.info", { id: actorId })).actor.level, 5);
});
await test("disabled native addParam reports limitation", async () => {
  await assert.rejects(
    send("actor.param.add", { id: actorId, paramId: 0, value: 10 }),
    /游戏没有应用/
  );
  return "native addParam is intentionally a no-op; explicit error";
});
await test("actor vitals/recovery/name", async () => {
  await send("actor.vitals.set", { id: actorId, hp: 10, tp: 20 });
  assert.equal((await send("actor.info", { id: actorId })).actor.hp, 10);
  await send("actor.recover", { id: actorId });
  const a = (await send("actor.info", { id: actorId })).actor;
  assert.equal(a.hp, a.mhp);
  await send("actor.name.set", { id: actorId, name: "验收角色" });
  await send("actor.nickname.set", { id: actorId, nickname: "隔离" });
  assert.equal(
    (await send("actor.info", { id: actorId })).actor.nickname,
    "隔离"
  );
});
await test("actor skill learn/forget", async () => {
  const skill = (await send("catalog.query", { kind: "skill", limit: 5 }))
    .entries[0].id;
  await send("actor.skill.learn", { id: actorId, skillId: skill });
  assert.ok(
    (await send("actor.info", { id: actorId })).actor.skills.some(
      (x) => x.id === skill
    )
  );
  await send("actor.skill.forget", { id: actorId, skillId: skill });
  assert.ok(
    !(await send("actor.info", { id: actorId })).actor.skills.some(
      (x) => x.id === skill
    )
  );
});
await test("actor state add/remove", async () => {
  const state = (
    await send("catalog.query", { kind: "state", limit: 10 })
  ).entries.find((x) => x.id !== 1).id;
  await send("actor.state.add", { id: actorId, stateId: state });
  assert.ok(
    (await send("actor.info", { id: actorId })).actor.states.some(
      (x) => x.id === state
    )
  );
  await send("actor.state.remove", { id: actorId, stateId: state });
});
await test("party add/remove/recover", async () => {
  await send("party.addActor", { id: 2 });
  assert.ok((await send("party.info")).members.some((x) => x.id === 2));
  await send("party.removeActor", { id: 2 });
  assert.ok(!(await send("party.info")).members.some((x) => x.id === 2));
  await send("party.recover");
});
await test("switch/variable writes", async () => {
  await send("switch.set", { id: 5, value: true });
  assert.equal(
    (await send("switch.list", { offset: 5, limit: 1 })).entries[0].value,
    true
  );
  await send("switch.set", { id: 5, value: false });
  await send("variable.set", { id: 5, value: 777 });
  assert.equal(
    (await send("variable.list", { offset: 5, limit: 1 })).entries[0].value,
    777
  );
  await send("variable.set", { id: 5, value: 0 });
});
await test("map catalog/info/events", async () => {
  const maps = await send("map.list");
  assert.ok(maps.total > 0);
  const map = await send("map.info");
  assert.ok(map.width > 0);
  const events = await send("map.events.list");
  assert.ok(events.entries.length > 0);
  return maps.total + " maps / " + events.entries.length + " current events";
});
await test("through and movement options actual behavior", async () => {
  await send("map.through.set", { value: true });
  assert.equal(await evaluate("$gamePlayer.isThrough()"), true);
  await send("map.through.set", { value: false });
  await send("trainer.options.set", {
    moveSpeedAdd: 1,
    noEncounter: true,
    alwaysDash: true
  });
  assert.equal(await evaluate("$gamePlayer.encounterProgressValue()"), 0);
  await send("trainer.options.set", {
    moveSpeedAdd: 0,
    noEncounter: false,
    alwaysDash: false
  });
});
await test("gold lock reassertion", async () => {
  await send("lock.set", { kind: "gold", value: 500 });
  await send("gold.set", { value: 999 });
  await sleep(1300);
  assert.equal((await send("party.info")).gold, 500);
  assert.equal((await send("lock.list")).locks.gold, 500);
  await send("lock.clear", { kind: "gold" });
});
await test("battle info outside combat", async () =>
  assert.equal((await send("battle.info")).inBattle, false));
await test("save slot and data roundtrip", async () => {
  await send("gold.set", { value: 1234 });
  await send("save.save", { id: 4 });
  const list = await send("save.list");
  assert.equal(list.storage, "webstorage");
  assert.equal(list.dir, null);
  assert.ok(list.entries.some((x) => x.slot === 4));
  await send("gold.set", { value: 5678 });
  await send("save.load", { id: 4 });
  await sleep(1500);
  assert.equal((await send("party.info")).gold, 1234);
  assert.equal(
    await evaluate("$gameParty===$thNewGmPr && $gamePlayer===$thNewGmPl"),
    true
  );
});
await test("WebStorage export/delete/import", async () => {
  const snapshot = await send("save.webstorage.export");
  await send("save.webstorage.delete", { name: "RPG File4" });
  assert.ok(!(await send("save.list")).entries.some((x) => x.slot === 4));
  await send("save.webstorage.import", { snapshot });
  assert.ok((await send("save.list")).entries.some((x) => x.slot === 4));
  await send("save.load", { id: 4 });
  await sleep(1000);
  assert.equal((await send("party.info")).gold, 1234);
  return snapshot.entries.length + " keys";
});
await test("save contents get/apply preserves aliases", async () => {
  const data = await send("save.contents.get");
  assert.ok(data.bytes > 1000);
  const applied = await send("save.contents.apply", { json: data.json });
  assert.equal(applied.applied, true);
  await sleep(1500);
  assert.equal(
    await evaluate(
      "$gameParty===$thNewGmPr && $gameParty === DataManager.makeSaveContents().party"
    ),
    true
  );
  return data.bytes + " bytes";
});
await test("console eval", async () =>
  assert.equal((await send("console.eval", { code: "1+1" })).result, 2));
await test("icon atlas", async () => {
  const x = await send("assets.iconset");
  assert.ok(x.dataUrl.length > 10000);
  assert.ok(x.width > 0);
  return `${x.width} x ${x.height}`;
});
fs.writeFileSync(
  "tmp/homecoming-acceptance.json",
  JSON.stringify(results, null, 2)
);
console.log(`${results.filter((x) => x.ok).length}/${results.length} PASS`);
