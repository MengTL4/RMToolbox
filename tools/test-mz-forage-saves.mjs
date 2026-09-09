import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const prefix='rmmzsave.123.', map=new Map();
const contents={system:{},party:{gold:7},actors:{}};
map.set(prefix+'file1',JSON.stringify(contents));
map.set(prefix+'global',JSON.stringify([null,{timestamp:100}]));
map.set(prefix+'config','private-config');
map.set('rmmzsave.999.file1','other-game');
let cloudCalls=0,loaded,failOnce;
const storage={isLocalMode:()=>false,forageKey:name=>prefix+name,
 updateForageKeys:async()=>{storage._forageKeys=[...map.keys()];},
 exists:async name=>map.has(prefix+name),loadZip:async name=>map.get(prefix+name),
 saveZip:async(name,value)=>{if(failOnce===name){failOnce=null;throw Error('write failed');}map.set(prefix+name,value);},
 remove:async name=>{map.delete(prefix+name);},
 zipToJson:async x=>x,jsonToZip:async x=>x,
 jsonToObject:async x=>JSON.parse(x),objectToJson:async x=>JSON.stringify(x),
 loadObject:async name=>JSON.parse(map.get(prefix+name)),
 saveObject:async(name,value)=>map.set(prefix+name,JSON.stringify(value)),
 loadCloudSave:async()=>{cloudCalls++;throw Error('cloud must not be called');}};
const manager={makeSavename:id=>'file'+id,loadGame:()=>storage.loadCloudSave(),
 createGameObjects:()=>{},extractSaveContents:value=>{loaded=value;},correctDataErrors:()=>{},
 loadGlobalInfo:async()=>{manager._globalInfo=await storage.loadObject('global');}};
const context={window:{$dataSystem:{gameTitle:'Fixture'},StorageManager:storage,DataManager:manager},
 commandHandlers:{},requireJsonEx:()=>JSON,requireDataManager:()=>manager,
 requireId:value=>{if(!Number.isInteger(value)||value<1)throw Error('invalid ID');return value;},
 resolveSystem:()=>null,resolveSceneManager:()=>null,resolveSceneMap:()=>null};
vm.createContext(context);
for(const file of ['66-commands-saves.js','66b-mz-forage.js'])vm.runInContext(fs.readFileSync('runtime/bridge/src/parts/'+file,'utf8'),context);
const commands=context.commandHandlers;
const snapshot=await commands['save.webstorage.export']();
assert.equal(snapshot.entries.length,2,'exclude config and other games');
assert.equal((await commands['save.list']()).storage,'webstorage');
await commands['save.load']({id:1});assert.equal(loaded.party.gold,7);assert.equal(cloudCalls,0);
map.set(prefix+'file0',JSON.stringify({...contents,party:{gold:5}}));
await commands['save.load']({id:0});assert.equal(loaded.party.gold,5);
await assert.rejects(commands['save.load']({id:2}),/本地存档/);assert.equal(cloudCalls,0);
await assert.rejects(commands['save.webstorage.import']({snapshot:{...snapshot,prefix:'other.'}}),/invalid/);
await assert.rejects(commands['save.webstorage.import']({snapshot:{...snapshot,entries:[{key:'config',value:'{}'}]}}),/invalid/);
map.set(prefix+'file2',JSON.stringify(contents));
map.set(prefix+'global',JSON.stringify([null,{timestamp:200},{timestamp:300}]));
await commands['save.webstorage.import']({snapshot});
assert.equal((await storage.loadObject('global'))[1].timestamp,100);
assert.equal((await storage.loadObject('global'))[2].timestamp,300,'preserve un-restored slot metadata');
const original=map.get(prefix+'file1');
await commands['save.webstorage.delete']({name:'file1.rmmzsave'});
assert.equal(await storage.exists('file1'),false);
await commands['save.webstorage.import']({snapshot});assert.equal(map.get(prefix+'file1'),original);
map.set(prefix+'file1',JSON.stringify({...contents,party:{gold:99}}));
const before=new Map(map);failOnce='global';
await assert.rejects(commands['save.webstorage.import']({snapshot}),/write failed/);
assert.deepEqual(map,before,'restore overwritten slots when a later write fails');
assert.equal(map.get(prefix+'config'),'private-config');
assert.equal(map.get('rmmzsave.999.file1'),'other-game');
console.log('PASS MZ browser save listing, local/cloud separation, backup validation, deletion, metadata merge and rollback');
