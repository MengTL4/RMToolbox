import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createEventTools } from '../app/gui/src/state/event-tools.js';
import { describeCommand, describeConditions } from '../app/gui/src/state/event-format.js';

const source=fs.readFileSync(new URL('../runtime/bridge/src/parts/65-event-tools.js',import.meta.url),'utf8');
function bridgeFixture() {
  const pages=[{conditions:{switch1Valid:true,switch1Id:1},list:[{code:355,indent:0,parameters:['throw new Error("must never execute")']},{code:9876,indent:2,parameters:[{raw:true}]}]}, {conditions:{},list:[{code:401,indent:0,parameters:['第二页']}]}];
  const event={_eventId:1,_x:3,_y:3,_pageIndex:0,_priorityType:1,event:()=>({name:'守卫',pages})};
  const player={_x:0,_y:0,locate(x,y){this._x=x;this._y=y;},canMove:()=>true};
  const map={_events:[null,event],_mapId:1,isPassable:()=>true,isEventRunning:()=>false,_commonEvents:[]};
  class SceneMap {}
  const manager={_scene:new SceneMap()};
  const window={$dataMap:{},$gameMessage:{isBusy:()=>false}};
  const sandbox={window,commandHandlers:{},requireMap:()=>map,requirePlayer:()=>player,
    currentMapInfo:()=>({mapId:map._mapId,width:8,height:8,x:player._x,y:player._y}),resolveSceneManager:()=>manager,resolveSceneMap:()=>SceneMap,
    isInBattle:()=>false,resolveParty:()=>null,runtimeDataTable:()=>[null,{name:'公共事件',list:pages[0].list}],resolveSwitches:()=>({value:()=>true}),resolveVariables:()=>({value:()=>12}),resolveSelfSwitches:()=>({value:()=>false})};
  vm.runInNewContext(source,sandbox);
  return {api:sandbox.commandHandlers,map,event,player,window,pages,manager};
}
for(const engine of ['MV','MZ']) {
  const f=bridgeFixture(),a=f.api,inspect=a['map.inspect'](),token=inspect.mapToken;
  const arg={mapToken:token,eventId:1,eventToken:inspect.events[0].eventToken};
  assert.deepEqual(JSON.parse(JSON.stringify(a['map.move'](arg))),{mapId:1,x:3,y:4});
  f.map.isPassable=()=>false;
  assert.throws(()=>a['map.move'](arg),/没有已知/);
  assert.throws(()=>a['map.move']({...arg,force:true}),/确认/);
  a['map.move']({...arg,force:true,confirmed:true}); assert.equal(f.player._y,3);
  f.window.$gameMessage.isBusy=()=>true;
  assert.throws(()=>a['map.move']({...arg,force:true,confirmed:true}),/对话/);
  f.window.$gameMessage.isBusy=()=>false; f.event._x=4;
  assert.throws(()=>a['map.move'](arg),/位置或事件页/);
  f.event._x=3; f.event._erased=true;
  assert.throws(()=>a['map.move']({...arg,force:true,confirmed:true}),/消失/); f.event._erased=false;
  f.map.isEventRunning=()=>true;
  assert.throws(()=>a['map.move']({...arg,force:true,confirmed:true}),/剧情/); f.map.isEventRunning=()=>false;
  f.player.canMove=()=>false;
  assert.throws(()=>a['map.move']({...arg,force:true,confirmed:true}),/不可移动/); f.player.canMove=()=>true;
  f.event._x=3; f.map.isPassable=()=>{throw Error('unsupported');};
  assert.equal(a['map.grid']({mapToken:token,offset:10,count:2}).cells.join(','),'-1,-1');
  assert.throws(()=>a['map.move']({mapToken:token,x:-1,y:0,force:true,confirmed:true}),/范围/);
  const snapshot=a['events.read']({mapToken:token,kind:'map',id:1,pageIndex:0,count:1});
  assert.equal(snapshot.commands.length,1); assert.equal(snapshot.total,2); assert.equal(snapshot.values['switch:1'],true);
  const second=a['events.read']({mapToken:token,kind:'map',id:1,pageIndex:0,offset:1,revision:snapshot.revision});
  assert.equal(second.commands[0].code,9876);
  f.event._pageIndex=1;
  assert.notEqual(a['events.status']({mapToken:token,kind:'map',id:1,pageIndex:0}).revision,snapshot.revision);
  assert.throws(()=>a['events.read']({mapToken:token,kind:'map',id:1,pageIndex:0,revision:snapshot.revision}),/内容已变化/);
  f.map._interpreter={_list:f.pages[0].list,_index:1,_childInterpreter:{_list:f.pages[1].list,_index:0}};
  const running=a['events.running']({mapToken:token}).entries; assert.equal(running.length,2);
  assert.equal(a['events.read']({mapToken:token,kind:'running',runId:running[0].id}).index,1);
  f.map._interpreter._index=2;
  assert.throws(()=>a['events.read']({mapToken:token,kind:'running',runId:running[0].id}),/已结束/);
  f.window.$dataMap={};
  assert.throws(()=>a['map.grid']({mapToken:token}),/地图已变化/);
  assert.throws(()=>a['map.move']({...arg,force:true,confirmed:true}),/地图已变化/);
  console.log(engine+' event protocol fixture PASS');
}
assert.match(describeCommand({code:111,parameters:[12,'dangerous()']}).detail,/只读/);
assert.match(describeCommand({code:9999,parameters:['original']}).text,/未知指令[\s\S]*original/);
assert.match(describeConditions({variableValid:true,variableId:2,variableValue:8},{'variable:2':9})[0],/≥ 8.*9/);

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let pending, held=false, reads=0;
const host={trainer:{gameKey:'a'},state:{selectionEpoch:0},sessionFor:()=>true,ok:()=>{},warn:()=>{},send:async(key,type,args)=>{
  if(type==='map.inspect'){reads++;if(held)return new Promise(resolve=>{pending=resolve;});return {mapToken:key+':1',mapId:1,width:2,height:2,events:[]};}
  if(type==='events.read')return {mapToken:args.mapToken,source:args,pages:[],commands:[{code:355,parameters:['never()']}],total:1,revision:'one',activePage:0};
  if(type==='events.status')return {mapToken:args.mapToken,revision:'two',activePage:1};
  if(type==='events.running')return {entries:[]};
}};
const tools=createEventTools(host);
try {
  tools.visible('map',true); await pause(10); assert.equal(tools.state.map.mapToken,'a:1');
  await tools.read({kind:'common',id:1}); assert.equal(tools.state.reader.revision,'one');
  tools.visible('map',false); tools.visible('interpreter',true); await pause(10);
  assert.ok(tools.state.stale); assert.equal(tools.state.reader.revision,'one','polling retains body');
  host.state.selectionEpoch++; tools.sync();
  assert.equal(tools.state.reader.revision,'one','same game reconnect retains snapshot');
  tools.visible('interpreter',false); const before=reads; await pause(1100); assert.equal(reads,before,'hidden polling stops');
  held=true; const refresh=tools.refresh(); await pause(0);
  host.trainer.gameKey='b';host.state.selectionEpoch++;tools.sync();
  pending({mapToken:'a:late',events:[]}); await refresh;
  assert.equal(tools.state.map,null);assert.equal(tools.state.reader,null,'new game clears snapshot');
} finally {tools.stop();}
console.log('event controller PASS: retained snapshots, hidden polling, late response isolation');
const ruby=spawnSync('ruby',['tools/fixtures/event-tools.rb'],{encoding:'utf8'});
if(ruby.error?.code==='ENOENT') console.log('SKIP RGSS event fixtures: install Ruby to exercise all three adapters');
else { assert.equal(ruby.status,0,ruby.stdout+'\n'+ruby.stderr); console.log(ruby.stdout.trim()); }
