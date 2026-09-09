import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function Actor(){this._paramPlus=Array(8).fill(0);this.equipment=7;}
Actor.prototype.refresh=function(){};
Actor.prototype.addParam=function(id,value){this.refresh();};
Actor.prototype.paramPlus=function(id){return this.equipment;};
Actor.prototype.param=function(id){return 80+this.paramPlus(id);};
Actor.prototype.thNewPrValue=function(){};
Actor.prototype.isTkActor=function(){return false;};
let actor=new Actor();
const targets=[{object:Actor.prototype,label:'native.actor'}];
const context={bridge:{originals:{}},commandHandlers:{},
 resolvePrototypeTargets:()=>targets,partyMemberPrototypeTargets:()=>[],uniqueTargets:x=>x,
 requireActor:()=>actor,requireNumber:Number,refreshActor:a=>a.refresh(),
 refreshMapAndWindows:()=>{},actorInfo:a=>({value:a.param(0),bonus:a._paramPlus[0]})};
vm.createContext(context);
vm.runInContext(fs.readFileSync('runtime/bridge/src/parts/40-hooks.js','utf8'),context);
vm.runInContext(fs.readFileSync('runtime/bridge/src/parts/62-commands-party.js','utf8'),context);
assert.equal(context.patchThActorParameters(),true);
const patched=Actor.prototype.paramPlus;
assert.equal(context.patchThActorParameters(),true);
assert.equal(Actor.prototype.paramPlus,patched);
const edit=value=>context.commandHandlers['actor.param.add']({id:1,paramId:0,value});
edit(10);assert.equal(actor.param(0),97);assert.equal(actor._paramPlus[0],10);
actor.equipment=12;assert.equal(actor.param(0),102,'native equipment changes remain live');
actor=Object.assign(new Actor(),JSON.parse(JSON.stringify(actor)));
assert.equal(actor.param(0),102,'save round trip retains additive term');
edit(-10);assert.equal(actor.param(0),92);
// A TH variant which already includes the engine additive term must stay native.
function Standard(){}
Standard.prototype=Object.create(Actor.prototype);
Standard.prototype.addParam=function(id,value){this._paramPlus[id]+=value;this.refresh();};
Standard.prototype.paramPlus=function(id){return this.equipment+this._paramPlus[id];};
const standard=Standard.prototype.paramPlus;
targets[0]={object:Standard.prototype,label:'standard.actor'};
assert.equal(context.patchThActorParameters(),false);
assert.equal(Standard.prototype.paramPlus,standard);
console.log('PASS TH additive parameters, native equipment, persistence, idempotence and standard-engine isolation');
