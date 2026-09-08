// Debug-only real-game regression. Requires the dedicated unsaved test session
// on map 7, with introductory story events completed in memory. Never saves.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
function evaluate(code) {
  execFileSync(process.execPath, [new URL('zs2-stairs-probe.mjs', import.meta.url).pathname.slice(1), code], {cwd:root,stdio:'pipe'});
  return JSON.parse(readFileSync(new URL('runtime/zs2-stairs-probe.json',root),'utf8'));
}
const snapshotCode = `(()=>{var p=TK.$.gamePlayer(),m=TK.$.gameMap();return {map:m.mapId(),x:p.x,y:p.y,canMove:p.canMove(),moving:p.isMoving(),forcing:p._moveRouteForcing,through:p._through,wait:m._interpreter._waitMode,routeIndex:p._moveRouteIndex,cheat:window.__rmchBridge.options.throughWalls}})()`;
async function until(label, predicate) {
  const deadline=Date.now()+10000;
  let state;
  do {
    await new Promise(r=>setTimeout(r,300));
    state=evaluate(snapshotCode);
    if(predicate(state)){console.log(label,JSON.stringify(state));return state;}
  } while(Date.now()<deadline);
  assert.fail(`${label}: ${JSON.stringify(state)}`);
}
assert.equal(evaluate(snapshotCode).map,7,'start at village in dedicated test session');
for(let i=1;i<=3;i++) {
  evaluate(`(()=>{var p=TK.$.gamePlayer();p.locate(3,11);p.setDirection(8);p.checkEventTriggerHere([0]);return true})()`);
  await until(`round ${i}: downstairs`,s=>s.map===19&&s.x===7&&s.y===6&&s.canMove&&!s.moving&&!s.forcing);
  evaluate('(TK.$.gamePlayer().moveStraight(4),true)');
  await until(`round ${i}: upstairs`,s=>s.map===7&&s.canMove&&!s.moving&&!s.forcing);
  evaluate('(TK.$.gamePlayer().moveStraight(2),true)');
  const walked=await until(`round ${i}: input restored`,s=>s.map===7&&s.y===12&&s.canMove&&!s.moving);
  assert.equal(walked.through,false);
  assert.equal(walked.cheat,false);
}
console.log('PASS: 3 complete basement stair round trips; normal collision and player movement restored');
