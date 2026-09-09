import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
let native=true;
const actor={level:1,record:1,exp:0,maxLevel:()=>50,nextLevelExp(){return this.level*10;},
 levelNewUp(){this.level++;this.record=this.level;},
 thTyChangeExp(exp,show,mode){assert.equal(mode,true);assert.equal(this.level,this.record,'native level record');this.exp=exp;while(this.exp>=this.nextLevelExp()){this.exp-=this.nextLevelExp();this.levelNewUp();}},
 changeLevel(level){this.level=level;},
 gainExp(amount){assert.equal(this.level,this.record,'level change must preserve later experience gains');this.thTyChangeExp(this.exp+amount,false,true);}};
const context={commandHandlers:{},requireActor:()=>actor,requireNumber:Number,
 isNativeFramePacingTarget:()=>native,withRatesSuppressed:fn=>fn(),refreshActor:()=>{},
 refreshMapAndWindows:()=>{},actorInfo:a=>({level:a.level,exp:a.exp})};
vm.createContext(context);
vm.runInContext(fs.readFileSync('runtime/bridge/src/parts/62-commands-party.js','utf8'),context);
const set=level=>context.commandHandlers['actor.level.set']({id:1,level});
set(5);assert.equal(actor.level,5);actor.gainExp(7);assert.equal(actor.exp,7);
set(5);assert.equal(actor.exp,7,'same level preserves progress');
assert.throws(()=>set(2),/不支持降级/);assert.equal(actor.level,5);
set(999);assert.equal(actor.level,50);
native=false;set(2);assert.equal(actor.level,2,'ordinary engines retain native changeLevel');
console.log('PASS FT level changes preserve native experience validation and ordinary engines');
native=true;
actor._classId=1;actor._exp={1:7};actor._thExpFxgGetNum={1:'native:7'};
actor.currentExp=()=>actor._exp[actor._classId]||0;
actor.changeClass=function(id,keep){if(keep)this._exp[id]=this.currentExp();this._classId=id;assert.equal(this._thExpFxgGetNum[id],'native:'+this.currentExp());};
context.requireId=Number;context.runtimeDataTable=()=>[null,{},{},{}];
context.resolveParty=()=>({fhZhNumGain(exp,type,a,id){assert.equal(type,1);a._thExpFxgGetNum[id]='native:'+exp;}});
const change=(classId,keepExp=true)=>context.commandHandlers['actor.class.set']({id:1,classId,keepExp});
change(2);assert.equal(actor.currentExp(),7);
change(3,false);assert.equal(actor.currentExp(),0);
change(1,false);assert.equal(actor.currentExp(),7);
console.log('PASS FT class changes initialize native records for retained and existing class experience');
actor.mp=0;actor.mmp=45;actor.recoverAll=()=>{actor.hp=100;};actor.setMp=n=>{actor.mp=n;};
context.withLocksSuppressed=fn=>fn();context.readStat=(a,k)=>a[k];
context.commandHandlers['actor.recover']({id:1});assert.equal(actor.hp,100);assert.equal(actor.mp,45);
console.log('PASS FT full recovery restores exposed MP through the native setter');
