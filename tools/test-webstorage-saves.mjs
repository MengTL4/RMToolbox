import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {createSaveFiles} from '../core/save-files.mjs';

const values = new Map();
let failingKey = null;
const localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem(key, value) { if (key === failingKey) { failingKey = null; throw Error('quota exceeded'); } values.set(key, String(value)); },
  removeItem: key => values.delete(key)
};
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const window = {
  StorageManager: {isLocalMode:()=>false, webStorageKey:id=>id===0?'RPG Global':`RPG File${id}`},
  LZString: {decompressFromBase64:value=>Buffer.from(value,'base64').toString()},
  DataManager: {
    maxSavefiles:()=>20,
    loadGlobalInfo:()=>JSON.parse(Buffer.from(values.get('RPG Global') || encode([]),'base64').toString()),
    saveGlobalInfo:info=>localStorage.setItem('RPG Global',encode(info))
  }
};
const context = {window,localStorage,commandHandlers:{},requireId:value=>Number(value),requireDataManager:()=>window.DataManager,
  resolveSystem:()=>({onBeforeSave(){context.beforeSave++;}}),beforeSave:0,
  resolveSceneManager:()=>({goto(){}}),resolveSceneMap:()=>function Scene_Map(){}};
vm.runInNewContext(fs.readFileSync('runtime/bridge/src/parts/66-commands-saves.js','utf8'),context);
const send = async(type,args={})=>context.commandHandlers[type](args);
values.set('RPG File1',encode({party:{gold:111}}));
values.set('RPG Global',encode([null,{timestamp:1700000000000,title:'fixture'}]));
values.set('unrelated-setting','untouched');
const listing=await send('save.list');
assert.equal(listing.storage,'webstorage');assert.equal(listing.dir,null);
assert.equal(listing.entries.find(x=>x.slot===1).name,'RPG File1');
const snapshot=await send('save.webstorage.export');
assert.equal(snapshot.entries.length,2);
const original=JSON.stringify([...values]);
for(const entries of [
  [{key:'unrelated-setting',value:encode({})}],
  [{key:'RPG File21',value:encode({})}],
  [{key:'RPG File1',value:encode({})},{key:'RPG File1',value:encode({})}],
  [{key:'RPG File1',value:encode([])}],
  [{key:'RPG Global',value:encode({})}],
  [{key:'RPG File1',value:'bad-compressed-json'}]
]) await assert.rejects(send('save.webstorage.import',{snapshot:{format:snapshot.format,title:null,entries}}));
await assert.rejects(send('save.webstorage.import',{snapshot:{...snapshot,title:'different game'}}));
assert.equal(JSON.stringify([...values]),original);
failingKey='RPG File1';
await assert.rejects(send('save.webstorage.import',{snapshot}),/quota exceeded/);
assert.equal(JSON.stringify([...values]),original);
values.set('RPG File1bak','previous engine backup');
failingKey='RPG Global';
await assert.rejects(send('save.webstorage.delete',{name:'RPG File1'}),/quota exceeded/);
assert.equal(values.get('RPG File1'),snapshot.entries.find(x=>x.key==='RPG File1').value);
assert.equal(values.get('RPG File1bak'),'previous engine backup');
assert.equal(values.get('RPG Global'),snapshot.entries.find(x=>x.key==='RPG Global').value);
await send('save.webstorage.delete',{name:'RPG File1'});
assert.equal(values.has('RPG File1'),false);
await send('save.webstorage.import',{snapshot});
assert.equal(values.get('RPG File1'),snapshot.entries.find(x=>x.key==='RPG File1').value);
assert.equal(values.get('unrelated-setting'),'untouched');
window.DataManager.saveGame=()=>false;
await assert.rejects(send('save.save',{id:1}),/returned false/);
window.DataManager.saveGame=async()=>{throw Error('disk full');};
await assert.rejects(send('save.save',{id:1}),/disk full/);
window.DataManager.saveGame=async()=>{};
assert.equal((await send('save.save',{id:1})).saved,true);
assert.equal(context.beforeSave,3);
window.DataManager.loadGame=async()=>{};
let cleared=0;
window.$gameMessage={clear(){cleared++;},isBusy:()=>true};
assert.equal((await send('save.load',{id:1})).loaded,true);
assert.equal(cleared,1);
window.DataManager.loadGame=async()=>false;
await assert.rejects(send('save.load',{id:1}),/failed/);
assert.equal(cleared,1);
let extracted=0;
window.DataManager.extractSaveContents=()=>{extracted++;};
context.requireJsonEx=()=>JSON;
await assert.rejects(send('save.contents.apply',{json:'{"party":{}}'}),/对话或选项/);
assert.equal(extracted,0);
await assert.rejects(send('save.save',{id:21}),/slot limit/);

const root=fs.mkdtempSync(path.join(os.tmpdir(),'rmch-websaves-'));
try {
  const fixtureState={projectRoot:root,modules:{saveFiles:{createSaveFiles}},sessions:{
    list:()=>[{gameKey:'fixture',alive:true,state:{saveStorage:'webstorage'}}],send:(key,type,args)=>send(type,args)
  }};
  const sandbox={module:{},require:createRequire(import.meta.url),fixtureState};
  vm.runInNewContext(fs.readFileSync('app/gui/host.cjs','utf8')+'\nObject.assign(state,fixtureState);',sandbox);
  const host=sandbox.module.exports;
  const backup=await host.backupSaves('fixture');assert.equal(backup.files,2);
  const backups=host.listBackups('fixture');assert.equal(backups.length,1);assert.equal(backups[0].storage,'webstorage');
  await host.deleteSaveFile('fixture','RPG File1');assert.equal(values.has('RPG File1'),false);
  const restored=await host.restoreBackup('fixture',backups[0].name);assert.equal(restored.restored,2);
  assert.equal(values.has('RPG File1'),true);
  await assert.rejects(host.restoreBackup('fixture','../escape'),/invalid backup name/);
  host.deleteBackup('fixture',backups[0].name);assert.equal(host.listBackups('fixture').length,0);
} finally {fs.rmSync(root,{recursive:true,force:true});}
console.log('PASS WebStorage slots, backup/restore/delete, validation/rollback, async save/load');

// Custom MV storage retains isLocalMode while no numbered file exists.
const nativeValues=new Map([[1,JSON.stringify({system:{},party:{gold:123},actors:{}})]]);
class SaveParty { characters(){return ['hero'];} }
let nativeInfo=[null,{title:'native fixture',timestamp:1700000000000,party:new SaveParty()}];
context.requireJsonEx=()=>({stringify:value=>JSON.stringify(value,(_key,v)=>v instanceof SaveParty?{'@':'SaveParty'}:v),
  parse:value=>JSON.parse(value,(_key,v)=>v&&v['@']==='SaveParty'?new SaveParty():v)});
let noDelete=true;
window.$dataSystem={gameTitle:'native fixture'};
window.StorageManager={isLocalMode:()=>true,localFilePath:id=>`virtual/file${id}.rpgsave`,
  exists:id=>nativeValues.has(id),load:id=>nativeValues.get(id),save:(id,value)=>nativeValues.set(id,value),
  remove:id=>{if(!noDelete)nativeValues.delete(id);}};
window.DataManager={maxSavefiles:()=>4,loadGlobalInfo:()=>nativeInfo,saveGlobalInfo:info=>{nativeInfo=info;}};
context.fs={existsSync:()=>false};
assert.equal((await send('save.list')).storage,'native');
const nativeSnapshot=await send('save.native.export');
assert.equal(nativeSnapshot.entries[0].id,1);
await assert.rejects(send('save.native.delete',{name:'file1.rpgsave'}),/未执行删除/);
assert.equal(nativeValues.has(1),true);
await assert.rejects(send('save.native.import',{snapshot:{...nativeSnapshot,title:'other'}}),/invalid/);
await assert.rejects(send('save.native.import',{snapshot:{...nativeSnapshot,entries:[{id:5,value:nativeSnapshot.entries[0].value}]}}),/invalid/);
const nativeRoot=fs.mkdtempSync(path.join(os.tmpdir(),'rmch-native-saves-'));
try {
  const fixtureState={projectRoot:nativeRoot,modules:{saveFiles:{createSaveFiles}},sessions:{
    list:()=>[{gameKey:'fixture',alive:true,state:{saveStorage:'native'}}],send:(key,type,args)=>send(type,args)}};
  const sandbox={module:{},require:createRequire(import.meta.url),fixtureState};
  vm.runInNewContext(fs.readFileSync('app/gui/host.cjs','utf8')+'\nObject.assign(state,fixtureState);',sandbox);
  const host=sandbox.module.exports;
  const backup=await host.backupSaves('fixture');assert.equal(backup.storage,'native');
  const backups=host.listBackups('fixture');assert.equal(backups[0].storage,'native');
  noDelete=false;
  await host.deleteSaveFile('fixture','file1.rpgsave');assert.equal(nativeValues.size,0);
  await host.restoreBackup('fixture',backups[0].name);
  assert.equal(nativeValues.get(1),nativeSnapshot.entries[0].value);
  assert.equal(nativeInfo[1].party.characters()[0],'hero','native preview metadata retains engine classes');
  host.deleteBackup('fixture',backups[0].name);
} finally {fs.rmSync(nativeRoot,{recursive:true,force:true});}
console.log('PASS native virtual slots, GUI backup/restore, validated slots and rejected silent deletion');
