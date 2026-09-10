// Requires a deliberately marked independent copy and a live storm-session.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const endpoint =
  "http://127.0.0.1:" + (Number(process.env.RMCH_TEST_PORT) || 19436);
const results = [];
async function send(type, args = {}) {
  const response = await (
    await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ type, args })
    })
  ).json();
  if (!response.ok) throw Error(response.error);
  return response.out;
}
const evaluate = async (code) => (await send("console.eval", { code })).result;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function test(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log("PASS", name, detail ?? "");
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log("FAIL", name, error.message);
  }
}
const root = await evaluate("process.env.RMCH_GAME_ROOT");
assert.ok(
  fs.existsSync(path.join(root, ".rmch-isolated-test")),
  "refusing to mutate an unmarked game"
);
assert.equal(
  (await send("scene.info")).current,
  "Scene_Map",
  "enter a playable map before acceptance"
);
await test("native aliases and player", async () => {
  assert.equal(
    await evaluate(
      "$gameParty===$ftGmPr && $gamePlayer===$ftGmPl && DataManager.makeSaveContents().party===$gameParty"
    ),
    true
  );
  assert.ok((await send("player.location")).mapId > 0);
});
await test("gold native set/add", async () => {
  await send("gold.set", { value: 1000 });
  await send("gold.add", { amount: 50 });
  assert.equal((await send("party.info")).gold, 1050);
  assert.equal(await evaluate("$ftGmPr.gold()"), 1050);
});
await test("inventory native set/remove", async () => {
  const item = (
    await send("catalog.query", { kind: "item", limit: 20 })
  ).entries.find((x) => x.name);
  await send("item.set", { kind: "item", id: item.id, count: 3 });
  assert.equal(await evaluate(`$ftGmPr.numItems($newTkIt[${item.id}])`), 3);
  assert.ok(
    (await send("item.list")).entries.some(
      (x) => x.id === item.id && x.count === 3
    )
  );
  await send("item.set", { kind: "item", id: item.id, count: 0 });
  assert.equal(await evaluate(`$ftGmPr.numItems($newTkIt[${item.id}])`), 0);
});
await test("weapon and armor native inventory", async () => {
  for (const kind of ["weapon", "armor"]) {
    const source = (
      await send("catalog.query", { kind, limit: 20 })
    ).entries.find((x) => x.name);
    await send("item.add", { kind, id: source.id, amount: 1 });
    const entry = (await send("item.list")).entries.find(
      (x) =>
        x.kind === kind && (x.id === source.id || x.baseItemId === source.id)
    );
    assert.ok(entry && entry.count > 0);
    const db = kind === "weapon" ? "$thTkWp" : "$thTkAr";
    assert.equal(
      await evaluate(`$ftGmPr.numItems(${db}[${entry.id}])`),
      entry.count
    );
    await send("item.set", { kind, id: entry.id, count: 0 });
  }
});
const members = (await send("party.info")).members;
assert.ok(members.length, "map must have a party");
const id = members[0].id;
await test("actor parameter actual behavior", async () => {
  const before = await evaluate(`$ftGmAc.actor(${id}).paramPlus(0)`);
  try {
    await send("actor.param.add", { id, paramId: 0, value: 10 });
  } catch (error) {
    assert.match(error.message, /游戏没有应用/);
    assert.equal(await evaluate(`$ftGmAc.actor(${id}).paramPlus(0)`), before);
    return "native method rejects changes; explicit limitation";
  }
  assert.equal(
    await evaluate(`$ftGmAc.actor(${id}).paramPlus(0)`),
    before + 10
  );
});
await test("actor level and vitals", async () => {
  const expBefore = await evaluate(`$ftGmAc.actor(${id}).currentExp()`);
  await send("actor.exp.add", { id, amount: 10 });
  assert.equal(
    await evaluate(`$ftGmAc.actor(${id}).currentExp()`),
    expBefore + 10
  );
  await send("actor.level.set", { id, level: 5 });
  assert.equal((await send("actor.info", { id })).actor.level, 5);
  await send("actor.vitals.set", { id, hp: 10, tp: 20 });
  assert.equal((await send("actor.info", { id })).actor.hp, 10);
  await send("actor.recover", { id });
  const actor = (await send("actor.info", { id })).actor;
  assert.equal(actor.hp, actor.mhp);
});
await test("actor skill/state", async () => {
  await send("actor.skill.learn", { id, skillId: 2 });
  assert.ok(
    (await send("actor.info", { id })).actor.skills.some((x) => x.id === 2)
  );
  await send("actor.skill.forget", { id, skillId: 2 });
  await send("actor.state.add", { id, stateId: 2 });
  assert.ok(
    (await send("actor.info", { id })).actor.states.some((x) => x.id === 2)
  );
  await send("actor.state.remove", { id, stateId: 2 });
  await send("actor.state.add", { id, stateId: 2 });
  assert.ok(
    (await send("actor.info", { id })).actor.states.some((x) => x.id === 2)
  );
  await send("actor.state.remove", { id, stateId: 2 });
});
await test("switch and variable native roundtrip", async () => {
  const sw = await evaluate("$ftGmSw.value(5)"),
    vr = await evaluate("$ftGmVr.value(5)");
  await send("switch.set", { id: 5, value: !sw });
  assert.equal(await evaluate("$ftGmSw.value(5)"), !sw);
  await send("variable.set", { id: 5, value: 777 });
  assert.equal(await evaluate("$ftGmVr.value(5)"), 777);
  await send("switch.set", { id: 5, value: sw });
  await send("variable.set", { id: 5, value: vr });
});
await test("movement modifiers actual behavior", async () => {
  const old = (await send("trainer.options.get")).options;
  await send("trainer.options.set", {
    moveSpeedAdd: 1,
    noEncounter: true,
    throughWalls: true
  });
  assert.equal(await evaluate("$ftGmPl.encounterProgressValue()"), 0);
  assert.equal(await evaluate("$ftGmPl.isThrough()"), true);
  await send("trainer.options.set", old);
});
await test("unsupported extra speed explicitly rejected", async () => {
  const before = (await send("trainer.options.get")).options;
  await assert.rejects(
    send("trainer.options.set", { gameSpeedMulti: 2, expRate: 9 }),
    /暂不支持额外游戏倍速/
  );
  await assert.rejects(
    send("trainer.options.set", { speedHoldCtrl: true }),
    /暂不支持额外游戏倍速/
  );
  assert.deepEqual((await send("trainer.options.get")).options, before);
  assert.equal(await evaluate("$gameSystem._drill_speedgear_speed"), 2);
});
await test("map catalog and events", async () => {
  const map = await send("map.info");
  assert.ok(map.width > 0);
  assert.ok((await send("map.list")).total > 0);
  return (await send("map.events.list")).entries.length + " events";
});
await test("gold lock actual reassertion", async () => {
  await send("lock.set", { kind: "gold", value: 500 });
  await send("gold.set", { value: 999 });
  await sleep(1300);
  assert.equal((await send("party.info")).gold, 500);
  await send("lock.clear", { kind: "gold" });
});
await test("filesystem save/load and dynamic aliases", async () => {
  await send("gold.set", { value: 1234 });
  await send("save.save", { id: 4 });
  const saved = await send("save.list");
  assert.ok(saved.dir && saved.dir.startsWith(root));
  assert.ok(saved.entries.some((x) => x.name === "file4.rpgsave"));
  await send("gold.set", { value: 5678 });
  await send("save.load", { id: 4 });
  await sleep(1500);
  assert.equal((await send("party.info")).gold, 1234);
  assert.equal(
    await evaluate("$gameParty===$ftGmPr && $gamePlayer===$ftGmPl"),
    true
  );
});
await test("save contents apply preserves aliases", async () => {
  const contents = await send("save.contents.get");
  assert.ok(contents.bytes > 1000);
  assert.equal(
    (await send("save.contents.apply", { json: contents.json })).applied,
    true
  );
  await sleep(1500);
  assert.equal(
    await evaluate(
      "$gameParty===$ftGmPr && $gameParty===DataManager.makeSaveContents().party"
    ),
    true
  );
});
fs.mkdirSync("tmp", { recursive: true });
fs.writeFileSync("tmp/storm-acceptance.json", JSON.stringify(results, null, 2));
console.log(`${results.filter((x) => x.ok).length}/${results.length} PASS`);
if (results.some((x) => !x.ok)) process.exitCode = 1;
