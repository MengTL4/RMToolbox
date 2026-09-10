import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const endpoint =
  "http://127.0.0.1:" + (Number(process.env.RMCH_TEST_PORT) || 19433);
const results = [];
async function req(q) {
  const x = await (
    await fetch(endpoint, { method: "POST", body: JSON.stringify(q) })
  ).json();
  if (!x.ok) throw Error(x.error);
  return x.out;
}
const send = (type, args = {}) => req({ type, args });
const evaluate = (evalCode) => req({ eval: evalCode });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gameRoot = await evaluate("window.__rmchEnv.RMCH_GAME_ROOT");
assert.ok(
  fs.existsSync(path.join(gameRoot, ".rmch-isolated-test")),
  "refusing to mutate an unmarked game"
);
async function test(name, fn) {
  try {
    const detail = await fn();
    assert.equal(await evaluate("!!SceneManager._stopped"), false);
    results.push({ name, ok: true, detail });
    console.log("PASS", name, detail || "");
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log("FAIL", name, e.message);
  }
}
await send("save.load", { id: 3 });
await sleep(1500);
await test("map grid/event reader", async () => {
  const map = await send("map.inspect");
  assert.equal(map.busy, null);
  const grid = await send("map.grid", {
    mapToken: map.mapToken,
    offset: 0,
    count: 100
  });
  assert.ok(grid.cells.length > 0);
  const event = map.events.find((x) => !x.erased);
  const read = await send("events.read", {
    mapToken: map.mapToken,
    kind: "map",
    id: event.eventId
  });
  assert.ok(read.total > 0);
  return `${grid.total} cells / event ${event.eventId}: ${read.total} commands`;
});
await test("map transfer same map", async () => {
  const p = await send("player.location");
  await send("map.transfer", { mapId: p.mapId, x: p.x, y: p.y });
  await sleep(1000);
  assert.equal((await send("player.location")).mapId, p.mapId);
});
await test("scene menu push/pop", async () => {
  await send("scene.push", { name: "Scene_Menu" });
  await sleep(600);
  assert.equal((await send("scene.info")).current, "ThSce_Menu");
  await send("scene.pop");
  await sleep(600);
  assert.equal((await send("scene.info")).current, "ThSce_Map");
});
await test("multipliers preserve quest gains outside battle", async () => {
  await send("trainer.options.set", { goldRate: 2, expRate: 2, dropRate: 2 });
  const values = JSON.parse(
    await evaluate(
      `JSON.stringify((()=>{const a=$gameActors.actor(1),g=$gameParty.gold(),e=a.currentExp(),enemy=new Game_Enemy(1,0,0);$gameParty.gainGold(10);a.gainExp(10);return {gold:$gameParty.gold()-g,exp:a.currentExp()-e,drop:enemy.dropItemRate()}})())`
    )
  );
  assert.equal(values.gold, 10);
  assert.equal(values.exp, 10);
  assert.equal(values.drop, 2);
  await send("trainer.options.set", { goldRate: 1, expRate: 1, dropRate: 1 });
  return values;
});
await test("no skill cost and vital locks actual setters", async () => {
  await send("trainer.options.set", {
    noSkillCost: true,
    lockHp: true,
    lockHpMax: true,
    lockMp: true,
    lockMpVal: 0,
    lockTp: true,
    lockTpVal: 30
  });
  const x = JSON.parse(
    await evaluate(
      `JSON.stringify((()=>{const a=$gameActors.actor(1),s=$dataSkills.find(s=>s&&s.mpCost>0);a.setHp(1);a.setMp(1);a.setTp(1);return {hp:a.hp,mhp:a.mhp,tp:a.tp,mpCost:a.skillMpCost(s),canPay:a.canPaySkillCost(s)}})())`
    )
  );
  assert.equal(x.hp, x.mhp);
  assert.equal(x.tp, 30);
  assert.equal(x.mpCost, 0);
  assert.equal(x.canPay, true);
  await send("trainer.options.set", {
    noSkillCost: false,
    lockHp: false,
    lockHpMax: false,
    lockMp: false,
    lockTp: false
  });
  return x;
});
await test("native battle scene opens", async () => {
  await evaluate(
    `BattleManager.setup(1,true,true);SceneManager.push(Scene_Battle);'battle queued'`
  );
  await sleep(1800);
  assert.equal((await send("scene.info")).current, "ThSce_Battle");
  assert.equal((await send("battle.info")).inBattle, true);
  return (await send("battle.info")).enemies.length + " enemies";
});
await test("battle gold/exp/drop multipliers actual calls", async () => {
  await send("trainer.options.set", { goldRate: 2, expRate: 2, dropRate: 2 });
  const x = JSON.parse(
    await evaluate(
      `JSON.stringify((()=>{const a=$gameParty.battleMembers()[0],g=$gameParty.gold(),v=a.currentExp(),e=$gameTroop.members()[0];$gameParty.gainGold(10);a.gainExp(10);return {gold:$gameParty.gold()-g,exp:a.currentExp()-v,drop:e.dropItemRate()}})())`
    )
  );
  assert.equal(x.gold, 20);
  assert.equal(x.exp, 20);
  assert.equal(x.drop, 2);
  await send("trainer.options.set", { goldRate: 1, expRate: 1, dropRate: 1 });
  return x;
});
await test("invincible actual HP damage", async () => {
  await send("trainer.options.set", { invincible: true });
  const x = JSON.parse(
    await evaluate(
      `JSON.stringify((()=>{const a=$gameParty.battleMembers()[0],e=$gameTroop.members()[0],v=a.hp;const action=new Game_Action(e);action.setAttack();action.executeHpDamage(a,10);return {before:v,after:a.hp}})())`
    )
  );
  assert.equal(x.before, x.after);
  await send("trainer.options.set", { invincible: false });
  return x;
});
await test("battle enemy HP command", async () => {
  const b = await send("battle.info");
  const enemy = b.enemies[0];
  const x = await send("battle.enemy.setHp", { index: enemy.index, value: 1 });
  return x;
});
await test("one hit kill actual native damage", async () => {
  await send("trainer.options.set", { oneHitKill: true });
  const x = await evaluate(
    `(()=>{const e=$gameTroop.members()[0],action=new Game_Action($gameParty.battleMembers()[0]);e.setHp(20);action.setAttack();action.apply(e);return {hp:e.hp,dead:e.isDead()}})()`
  );
  assert.equal(x.hp, 0);
  assert.equal(x.dead, true);
  await send("trainer.options.set", { oneHitKill: false });
});
await test("battle kill remaining enemies", async () => {
  const x = await send("battle.killEnemies");
  assert.equal(x.remaining, 0);
  return x;
});
await sleep(800);
fs.writeFileSync(
  "tmp/homecoming-combat-events.json",
  JSON.stringify(results, null, 2)
);
console.log(`${results.filter((x) => x.ok).length}/${results.length} PASS`);
