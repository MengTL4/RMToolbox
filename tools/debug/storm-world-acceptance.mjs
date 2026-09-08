// Real native interpreter/battle checks; only a deliberately marked game copy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const endpoint = process.env.RMCH_TEST_ENDPOINT || 'http://127.0.0.1:19436';
const results = [];
async function send(type, args = {}) {
  const value = await (await fetch(endpoint, { method: 'POST', body: JSON.stringify({ type, args }), signal: AbortSignal.timeout(20000) })).json();
  if (!value.ok) throw Error(value.error);
  return value.out;
}
const evaluate = async code => (await send('console.eval', { code })).result;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const gameRoot = await evaluate('process.env.RMCH_GAME_ROOT');
assert.ok(fs.existsSync(path.join(gameRoot, '.rmch-isolated-test')), 'refusing to mutate an unmarked game');
assert.equal((await send('scene.info')).current, 'Scene_Map');
assert.equal(await evaluate('document.hidden'), false, 'keep the game foreground while checking native scene transitions');
assert.equal((await send('map.inspect')).busy, null, 'finish the native introduction before testing');
await send('save.save', { id: 3 });
// A shipped combat map: Map018 uses existing encrypted backgrounds 14 / 20.
await send('map.transfer', { mapId: 18, x: 1, y: 1 });
await sleep(1200);
assert.equal((await send('player.location')).mapId, 18);
const combatMap = await send('map.inspect');
const combatGrid = await send('map.grid', { mapToken: combatMap.mapToken, offset: 0, count: 2048 });
const freeCell = combatGrid.cells.findIndex((mask, index) => mask === 15 && !combatMap.events.some(event => event.x === index % 30 && event.y === Math.floor(index / 30)));
assert.ok(freeCell >= 0, 'combat map contains a clear passable cell');
await send('map.transfer', { mapId: 18, x: freeCell % 30, y: Math.floor(freeCell / 30) });
await sleep(1000);
async function test(name, fn) {
  try { const detail = await fn(); assert.equal(await evaluate('!!SceneManager._stopped'), false); results.push({ name, ok: true, detail }); console.log('PASS', name, detail ?? ''); }
  catch (error) { results.push({ name, ok: false, error: error.message }); console.log('FAIL', name, error.message); }
}
await test('map grid and real event reader', async () => {
  const map = await send('map.inspect'); assert.equal(map.busy, null);
  const grid = await send('map.grid', { mapToken: map.mapToken, offset: 0, count: 100 }); assert.ok(grid.cells.length > 0);
  const event = map.events.find(e => !e.erased); assert.ok(event);
  const read = await send('events.read', { mapToken: map.mapToken, kind: 'map', id: event.eventId }); assert.ok(read.total > 0);
  return { cells: grid.total, event: event.eventId, commands: read.total };
});
await test('native selected common-event execution', async () => {
  const previous = await evaluate('$gameSwitches.value(5)');
  const id = await evaluate('$dataCommonEvents.length');
  let execution;
  try {
    await evaluate(`$dataCommonEvents.push({id:${id},name:'RMToolbox isolated execution test',trigger:0,switchId:1,list:[{code:121,indent:0,parameters:[5,5,${previous ? 1 : 0}]},{code:0,indent:0,parameters:[]}]});true`);
    const map = await send('map.inspect');
    const plan = await send('events.steps', { mapToken: map.mapToken, id });
    const step = plan.steps.find(s => s.start === 0); assert.ok(step && !step.reason);
    execution = (await send('events.execute', { mapToken: map.mapToken, id, start: 0, revision: step.revision })).execution;
    for (let i = 0; i < 30; i++) { await sleep(200); execution = (await send('events.execution')).execution; if (execution && ['completed', 'stopped', 'failed'].includes(execution.state)) break; }
    assert.equal(execution.state, 'completed');
    assert.equal(await evaluate('$gameSwitches.value(5)'), !previous);
    return { state: execution.state, fixture: 'temporary common event through native interpreter' };
  } finally {
    if (execution && !['completed', 'stopped', 'failed'].includes(execution.state)) {
      await send('events.stop', { executionId: execution.id });
      await sleep(300);
    }
    await evaluate(`$dataCommonEvents.length=${id};$gameSwitches.setValue(5,${JSON.stringify(previous)});true`);
  }
});
await test('same-map native transfer', async () => {
  const p = await send('player.location'); await send('map.transfer', { mapId: p.mapId, x: p.x, y: p.y }); await sleep(1000);
  const q = await send('player.location'); assert.equal(q.mapId, p.mapId); assert.equal(q.x, p.x); assert.equal(q.y, p.y);
});
await test('native menu push/pop', async () => {
  await send('scene.push', { name: 'Scene_Menu' }); await sleep(600); assert.equal((await send('scene.info')).current, 'Scene_Menu');
  await send('scene.pop'); await sleep(600); assert.equal((await send('scene.info')).current, 'Scene_Map');
});
await test('no cost and vital locks use native setters', async () => {
  const old = (await send('trainer.options.get')).options;
  try {
    await send('trainer.options.set', { noSkillCost: true, lockHp: true, lockHpMax: true, lockTp: true, lockTpVal: 30 });
    const x = await evaluate('(()=>{const a=$gameParty.members()[0],s=$dataSkills.find(s=>s&&s.mpCost>0);a.setHp(1);a.setTp(1);return {hp:a.hp,mhp:a.mhp,tp:a.tp,mpCost:a.skillMpCost(s),canPay:a.canPaySkillCost(s)}})()');
    assert.equal(x.hp, x.mhp); assert.equal(x.tp, 30); assert.equal(x.mpCost, 0); assert.equal(x.canPay, true); return x;
  } finally { await send('trainer.options.set', old); }
});
let battleReady = false;
await test('native battle scene', async () => {
  // Some non-combat maps retain default RPG Maker background names whose
  // assets were removed from the shipped game. Never force a battle there.
  const backgrounds = await evaluate('({first:$gameMap.battleback1Name(),second:$gameMap.battleback2Name(),hidden:document.hidden})');
  assert.equal(backgrounds.hidden, false, 'native scene transitions pause in the background');
  for (const [folder, name] of [['battlebacks1', backgrounds.first], ['battlebacks2', backgrounds.second]]) {
    assert.ok(name, 'choose a real combat map with explicit battle backgrounds');
    assert.ok(['.png', '.rpgmvp'].some(extension => fs.existsSync(path.join(gameRoot, 'www', 'img', folder, name + extension))), `battle test requires an existing ${folder}/${name} asset; choose a real combat map`);
  }
  assert.equal(await evaluate('$gamePlayer._encounterCount=0;$gamePlayer.executeEncounter()'), true, 'the current map has a real native encounter');
  await evaluate('SceneManager.push(Scene_Battle);true'); await sleep(1800);
  assert.equal((await send('scene.info')).current, 'Scene_Battle'); const battle = await send('battle.info'); assert.equal(battle.inBattle, true); assert.ok(battle.enemies.length); return battle.enemies.length;
});
// A failed entry must not continue applying damage/rewards to a queued scene.
battleReady = results[results.length - 1].ok;
if (battleReady) {
await test('battle gold EXP and drop multipliers', async () => {
  const old = (await send('trainer.options.get')).options;
  try {
    await send('trainer.options.set', { goldRate: 2, expRate: 2, dropRate: 2 });
    const x = await evaluate('(()=>{const a=$gameParty.battleMembers()[0],g=$gameParty.gold(),v=a.currentExp(),e=$gameTroop.members()[0];$gameParty.gainGold(10,true);a.gainExp(10,true);return {gold:$gameParty.gold()-g,exp:a.currentExp()-v,drop:e.dropItemRate()}})()');
    assert.equal(x.gold, 20); assert.equal(x.exp, 20); assert.equal(x.drop, 2); return x;
  } finally { await send('trainer.options.set', old); }
});
await test('invincible native damage', async () => {
  const old = (await send('trainer.options.get')).options;
  try {
    await send('trainer.options.set', { invincible: true });
    const x = await evaluate('(()=>{const a=$gameParty.battleMembers()[0],e=$gameTroop.members()[0],before=a.hp,action=new Game_Action(e);action.setAttack();action.executeHpDamage(a,10);return {before,after:a.hp}})()');
    assert.equal(x.before, x.after); return x;
  } finally { await send('trainer.options.set', old); }
});
await test('enemy HP command and native one-hit kill', async () => {
  const enemy = (await send('battle.info')).enemies[0]; await send('battle.enemy.setHp', { index: enemy.index, value: 1 });
  const old = (await send('trainer.options.get')).options;
  try {
    await send('trainer.options.set', { oneHitKill: true });
    const x = await evaluate('(()=>{const e=$gameTroop.members()[0],action=new Game_Action($gameParty.battleMembers()[0]);e.setHp(20);action.setAttack();action.apply(e);return {hp:e.hp,dead:e.isDead()}})()');
    assert.equal(x.hp, 0); assert.equal(x.dead, true); return x;
  } finally { await send('trainer.options.set', old); }
});
await test('kill remaining native enemies', async () => { const x = await send('battle.killEnemies'); assert.equal(x.remaining, 0); return x; });
}
fs.mkdirSync('tmp', { recursive: true }); fs.writeFileSync('tmp/storm-world-acceptance.json', JSON.stringify(results, null, 2));
console.log(`${results.filter(x => x.ok).length}/${results.length} PASS`);
if (results.some(x => !x.ok)) process.exitCode = 1;
