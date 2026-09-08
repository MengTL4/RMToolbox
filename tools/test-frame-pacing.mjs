import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../runtime/bridge/src/parts/44-frame-pacing.js', import.meta.url), 'utf8');
const hooks = readFileSync(new URL('../runtime/bridge/src/parts/40-hooks.js', import.meta.url), 'utf8');
const partyCommands = readFileSync(new URL('../runtime/bridge/src/parts/62-commands-party.js', import.meta.url), 'utf8');
function simulate(hz, { target = true, disabledPlugin = false } = {}) {
  let now = 0, queued = null, frames = 0, steps = 0, previous = 0, accumulator = 0;
  const manager = {
    _deltaTime: 1 / 120, _stopped: false,
    requestUpdate() { if (!this._stopped) { assert.equal(queued, null, 'one pending frame'); queued = this.update.bind(this); } },
    update(timestamp) {
      assert.equal(this, manager); assert.equal(timestamp, now);
      accumulator += (now - previous) / 1000; previous = now;
      while (accumulator + 1e-9 >= this._deltaTime) { accumulator -= this._deltaTime; steps++; }
      frames++; this.requestUpdate();
    }
  };
  const original = manager.update;
  const sandbox = {
    SceneManager: manager, Game_Player: class {}, Scene_Map: class {},
    $ftGmPl: null, $ftGmPr: null, $newTkIt: [],
    $plugins: [{ name: 'TH-BaseSet', status: !disabledPlugin }, { name: 'TDDP_FluidTimestep', status: true }],
    performance: { now: () => now }, bridge: { originals: {} },
    resolveSceneManager: () => manager
  };
  if (!target) delete sandbox.$ftGmPr;
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(hooks + source, context);
  vm.runInContext('patchNativeFramePacing()', context);
  const installed = manager.update;
  vm.runInContext('patchNativeFramePacing()', context);
  assert.equal(manager.update, installed, 'retry must not stack wrappers');
  manager.requestUpdate();
  for (let tick = 0; tick <= hz * 10; tick++) {
    now = tick * 1000 / hz;
    const callback = queued; queued = null;
    assert.ok(callback, 'skipped display frames must schedule the next frame');
    callback(now);
  }
  const measuredFrames = frames - 1;
  const measuredSteps = steps;
  assert.equal(manager._deltaTime, 1 / 120, 'native authored logic speed is retained');
  manager._stopped = true;
  now += 1000 / hz;
  const final = queued; queued = null; final(now);
  assert.equal(queued, null, 'native stop logic is retained on skipped or rendered frames');
  manager._stopped = false;
  now += 5000;
  manager.requestUpdate();
  const resumed = queued; queued = null; resumed(now);
  assert.ok(queued, 'resume after suspension continues scheduling');
  return { frames: measuredFrames, steps: measuredSteps, original, installed };
}

for (const hz of [60, 120, 144, 240]) {
  const result = simulate(hz);
  assert.ok(Math.abs(result.frames - 600) <= 1, `${hz} Hz: expected 600 rendered frames in 10s, got ${result.frames}`);
  assert.ok(Math.abs(result.steps - 1200) <= 2, `${hz} Hz: native 120 logic steps/sec must survive rendering cap`);
}
assert.equal(simulate(30).frames, 300, 'slow displays must keep every frame');
for (const options of [{ target: false }, { disabledPlugin: true }]) {
  const result = simulate(144, options);
  assert.equal(result.frames, 1440, 'other games or disabled plugins are untouched');
  assert.equal(result.installed, result.original);
}
for (const target of [true, false]) {
  const sandbox = {
    Game_Player: class {}, Scene_Map: class {}, $ftGmPl: null, $newTkIt: [],
    $plugins: [{name:'TH-BaseSet',status:true},{name:'TDDP_FluidTimestep',status:true}],
    bridge: {options:{gameSpeedMulti:1,speedHoldCtrl:false,expRate:1}},
    clampNumber: (value,min,max,fallback) => Number.isFinite(Number(value)) ? Math.min(max,Math.max(min,Number(value))) : fallback,
    toBool: value => value === true || value === 'true'
  };
  if (target) sandbox.$ftGmPr = null;
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(hooks + source + '\npatchTrainerHooks=function(){};applyWorldOptions=function(){};', context);
  if(target) {
    for(const input of [{gameSpeedMulti:2,expRate:9},{speedHoldCtrl:true,expRate:9}]) {
      sandbox.input = input;
      assert.throws(()=>vm.runInContext('setTrainerOptions(input)',context),/暂不支持额外游戏倍速/);
      assert.equal(sandbox.bridge.options.expRate,1,'unsupported speed rejects the entire update before any mutation');
    }
    vm.runInContext('setTrainerOptions({gameSpeedMulti:1,speedHoldCtrl:false,expRate:2})',context);
    assert.equal(sandbox.bridge.options.expRate,2,'other modifiers remain available');
  } else {
    vm.runInContext('setTrainerOptions({gameSpeedMulti:2,speedHoldCtrl:true})',context);
    assert.equal(sandbox.bridge.options.gameSpeedMulti,2,'other families keep their speed controls');
  }
}
console.log('frame pacing PASS: high refresh warning cadence, native logic speed, low refresh, stop/resume, family gate');
for(const target of [true,false]) {
  const actor={exp:40,thTyChangeExp(){},gainExp(amount,nativeMode){
    assert.equal(arguments.length,target?2:1,'only FT custom EXP receives the native second flag');
    if(target)assert.equal(nativeMode,true);
    this.exp+=amount;
  }};
  const commands={};
  vm.runInNewContext(partyCommands,{
    commandHandlers:commands,requireActor:()=>actor,requireNumber:Number,
    withRatesSuppressed:fn=>fn(),isNativeFramePacingTarget:()=>target,
    refreshActor(){},refreshMapAndWindows(){},actorInfo:a=>({exp:a.exp})
  });
  assert.equal(commands['actor.exp.add']({id:1,amount:10}).actor.exp,50);
}
console.log('FT EXP command PASS: native custom flag, raw amount, other families untouched');
for(const target of [true,false]) {
  let nativeCalls=0;
  const party={_gold:10,thNewGainGold(){},gold(){return this._gold},gainGold(amount,nativeMode){
    if(target && nativeMode!==true)return;
    assert.equal(arguments.length,target?2:1);
    nativeCalls++;this._gold=Math.min(15,Math.max(0,this._gold+amount));
  }};
  const commands={};
  vm.runInNewContext(partyCommands,{
    commandHandlers:commands,requireParty:()=>party,requireNumber:Number,
    withRatesSuppressed:fn=>fn(),isNativeFramePacingTarget:()=>target,safeGold:p=>p.gold()
  });
  assert.equal(commands['gold.add']({amount:10}).gold,15,'native ceiling is preserved instead of raw-store fallback');
  assert.equal(nativeCalls,1);
  if(target)assert.equal(commands['gold.add']({amount:1}).gold,15,'already at native ceiling must not fall back to a raw overwrite');
}
console.log('FT gold command PASS: native mode and ceiling, other families untouched');
{
  const actor={states:[],removed:[],clearResult(){this.removed=[]},
    addState(id){if(id!==3&&!this.removed.includes(id)&&!this.states.includes(id))this.states.push(id)},
    removeState(id){this.states=this.states.filter(x=>x!==id);this.removed.push(id)}};
  const commands={};
  vm.runInNewContext(partyCommands,{commandHandlers:commands,requireActor:()=>actor,requireNumber:Number,refreshActor(){},actorInfo:a=>({states:[...a.states]})});
  commands['actor.state.add']({id:1,stateId:2});
  commands['actor.state.remove']({id:1,stateId:2});
  assert.deepEqual(commands['actor.state.add']({id:1,stateId:2}).actor.states,[2],'a new manual action must not inherit the previous removal result');
  assert.deepEqual(commands['actor.state.add']({id:1,stateId:3}).actor.states,[2],'native state resistance is still honored');
}
console.log('manual state command PASS: add/remove/add action boundaries, native resistance retained');
