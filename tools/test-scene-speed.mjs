import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../runtime/bridge/src/parts/40-hooks.js',import.meta.url),'utf8');
for(const engine of ['MV','MZ']){
 let ticks=0,scheduled=0,rendered=0,locks=0;
 const manager={updateScene(){ticks++;},updateInputData(){},changeScene(){},updateFrameCount(){},
  updateMain(){this.updateInputData();this.changeScene();this.updateScene();rendered++;scheduled++;}};
 const bridge={originals:{},options:{speedHoldCtrl:true,gameSpeedMulti:3},keysHeld:{control:true}};
 const context={bridge,resolveSceneManager:()=>manager,applyValueLocks:()=>locks++,
  clampNumber:(x,min,max,fallback)=>Number.isFinite(Number(x))?Math.min(max,Math.max(min,Number(x))):fallback,
  isNativeFramePacingTarget:()=>false};
 vm.runInNewContext(source,context);
 context.patchSceneUpdate();
 manager.updateMain();
 assert.equal(ticks,3,engine+' no-argument loop must execute three scene ticks');
 assert.equal(rendered,1,'render only once');assert.equal(scheduled,1,'never duplicate frame scheduling');assert.equal(locks,1);
 bridge.keysHeld.control=false;manager.updateMain();assert.equal(ticks,4,'released Ctrl restores normal speed');
 bridge.keysHeld.control=true;bridge.options.gameSpeedMulti=1.5;ticks=0;
 manager.updateMain();manager.updateMain();assert.equal(ticks,3,'fractional speeds accumulate across frames');
 bridge.options.speedHoldCtrl=false;ticks=0;manager.updateMain();assert.equal(ticks,1,'disabled speed ignores held Ctrl');
 console.log(engine+' native no-argument scene speed PASS');
}
