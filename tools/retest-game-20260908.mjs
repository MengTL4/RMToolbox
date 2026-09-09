import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {gameRuntime} from '../core/game-runtime.mjs';
import {launchGame} from '../core/launcher.mjs';
import {BridgeServer} from '../core/ws-server.mjs';
import {BridgeSessions,externalSessions} from '../core/bridge-sessions.mjs';
import {getToken} from '../core/token.mjs';
import {listProcessesByExeName} from '../core/attach.mjs';
import {createSaveFiles} from '../core/save-files.mjs';
const workspaceRoot=path.resolve(import.meta.dirname,'..'),projectRoot=process.argv.includes('--v075-full')?path.join(workspaceRoot,'tmp/release-baseline-v075'):workspaceRoot,root=path.resolve(process.argv[2]),output=process.argv[3];
assert.ok(root.startsWith(path.join(workspaceRoot,'tmp/full-retest-20260908/games')+path.sep));
assert.ok(fs.existsSync(path.join(root,'.rmch-isolated-test')));
const scan=gameRuntime.scan(root),report={root,title:scan.title,engine:scan.engine,container:scan.container,started:new Date().toISOString(),checks:[]};
const server=new BridgeServer({port:0,token:getToken(projectRoot),stateDir:path.join(projectRoot,'runtime/bridge-state')});
const sessions=new BridgeSessions({server});
// Manual /client probes must reach CDP/RGSS adapters just like the GUI host.
const websocketSend=server.sendCommand.bind(server);
server.sendCommand=(gameKey,type,args)=>{const adapter=externalSessions.find(gameKey);return adapter?adapter.send(type,args||{}):websocketSend(gameKey,type,args||{});};
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2));
 const send=(type,args={})=>sessions.send(scan.gameKey,type,args);
 const ev=async code=>(await send('console.eval',{code})).result;
 async function test(name,fn){try{const detail=await fn();report.checks.push({name,status:'pass',detail});console.log('PASS',name,JSON.stringify(detail)?.slice(0,220));return detail;}catch(e){const status=/对话中|剧情事件执行中|当前不是可操作的地图场景|请等待当前对话|技能位已满|no MP skill|no alternate native class|no usable .*sample|no catalog entry/.test(e.message)?'blocked':/unsupported on RGSS|unsupported catalog kind|暂不支持额外游戏倍速|暂不支持数量锁|独立.*不支持.*锁|职业由原生专武规则/.test(e.message)?'limitation':'fail';report.checks.push({name,status,error:e.message});console.log(status.toUpperCase(),name,e.message);return null;}finally{save();}}
 function blocked(name,reason){report.checks.push({name,status:'blocked',reason});save();}
 async function prepareIdleFixture(){
  await test('prepare isolated idle-map fixture',async()=>{
   // Extra-only runs used to enter while a copied game was still displaying
   // its intro dialogue. Clear only live runtime objects, then return to the
   // current map; no game files or saves are changed by this fixture.
   await ev(`(function(){var t=window.TK&&TK.$,m=t&&t.gameMap?t.gameMap():window.$gameMap,msg=t&&t.gameMessage?t.gameMessage():window.$gameMessage,ce=t&&t.dataCommonEvents?t.dataCommonEvents():window.$dataCommonEvents,all=[window.$gameMessage,msg];if(m){m.events().forEach(function(e){var d=e&&e.event&&e.event();if(d&&d.pages&&d.pages.some(function(p){return p.trigger===3||p.trigger===4}))e.erase();});if(m._interpreter&&typeof m._interpreter.clear==='function')m._interpreter.clear();(m._events||[]).forEach(function(e){if(e&&e._interpreter&&typeof e._interpreter.clear==='function')e._interpreter.clear();});m.requestRefresh&&m.requestRefresh();}if(ce)ce.forEach(function(e){if(e)e.trigger=0;});all.forEach(function(x){if(!x)return;if(typeof x.clear==='function')x.clear();x._texts=[];x._choices=[];x._choiceCallback=null;x._numInputVariableId=0;x._itemChoiceVariableId=0;if(typeof x.isBusy==='function'&&!x.__rmchIdleBusyPatch){x.__rmchIdleBusyPatch=x.isBusy;x.isBusy=function(){return false;};}});if(window.$online)window.$online._isBusy=false;var sm=window.SceneManager,sc=window.Scene_Map;if(sm&&sc)sm.goto(sc);return true})()`);
   await send('game.repair',{action:'clearCurrentEvent'}).catch(()=>{});await send('game.repair',{action:'fadeIn'}).catch(()=>{});await sleep(1000);
   const map=await send('map.inspect');if(map.busy)throw Error(map.busy);return {mapId:map.mapId};
  });
 }
 const SMOKE_DONE=Symbol('smoke completed');let pid;
try{
 await server.start();
 await test('launch and bridge',async()=>{
  report.launchEntry=process.argv.includes('--shadow')?'launcher.launchGame (isolated-copy fallback)':'gameRuntime.launch (GUI entry)';
  let launchFn=process.argv.includes('--shadow')?launchGame:gameRuntime.launch.bind(gameRuntime);
  if(process.argv.includes('--dll')){launchFn=({port})=>gameRuntime.launchInject({scan,projectRoot,port});report.launchEntry='gameRuntime.launchInject (native DLL delivery)';}
  if(process.argv.includes('--direct-shadow')){const {launchShadowGame}=await import('../core/shadow-launcher.mjs');const shadowScan=process.argv.includes('--legacy-shadow')?{...scan,protection:{...scan.protection,flags:scan.protection.flags.filter(x=>x!=='grover-boot')}}:scan;launchFn=({port})=>({...launchShadowGame({projectRoot,scan:shadowScan,gameKey:scan.gameKey,port,token:getToken(projectRoot)}),strategy:process.argv.includes('--legacy-shadow')?'shadow-legacy-layout-comparison':'shadow-direct-comparison'});report.launchEntry='shadow launcher direct comparison';}
  if(process.argv.includes('--v075-launch')||process.argv.includes('--v075-full')){launchFn=(await import('../tmp/release-baseline-v075/core/launcher.mjs')).launchGame;report.launchEntry=process.argv.includes('--v075-full')?'v0.7.5 launcher and bridge':'v0.7.5 launcher/scanner differential, current bridge';}
  const launch=await launchFn({gameRoot:root,projectRoot,port:server.httpServer.address().port,strategy:process.argv.includes('--shadow')||process.argv.includes('--runtime-shadow')?'shadow':'auto',build:!process.argv.includes('--v075-launch')});pid=launch.pid;report.strategy=launch.strategy;
  const deadline=Date.now()+180000;while(!sessions.list().some(s=>s.gameKey===scan.gameKey&&s.alive)){if(Date.now()>deadline)throw Error('bridge not connected in 180 seconds');await sleep(1000);}
  return {strategy:launch.strategy,pid};
 });
 if(!sessions.list().some(s=>s.gameKey===scan.gameKey&&s.alive))throw Error('Launch blocked all runtime tests');
 fs.writeFileSync(output+'.session.json',JSON.stringify({port:server.httpServer.address().port,gameKey:scan.gameKey,pid,root,projectRoot}));
 if(process.argv.includes('--manual')){
  console.log('WAIT native setup',output+'.ready');
  const deadline=Date.now()+3600000;while(!fs.existsSync(output+'.ready')){if(Date.now()>deadline)throw Error('native setup gate timed out');await sleep(300);}
 }
 const nativeSave=process.argv.find(a=>a.startsWith('--native-save='));
 if(nativeSave){
  for(let n=0;n<120;n++){
   const ready=await ev('(function(){var s=window.SceneManager&&SceneManager._scene,w=s&&s._commandWindow;return !!(window.DataManager&&window.$gameMap&&s&&(s.constructor===window.Scene_Map||s.constructor===window.Scene_Title||/Title|Map$/.test(s.constructor.name)||(w&&w._list&&w._list.some(function(c){return c.symbol==="newGame";}))));})()').catch(()=>false);
   if(ready)break;await sleep(1000);
  }
  await send('save.load',{id:Number(nativeSave.split('=')[1])});await sleep(2000);
 }
 if(process.argv.includes('--extra-only')){
  if(process.argv.includes('--idle-fixture')) await prepareIdleFixture();
  const {extra}=await import('./retest-extra-20260909.mjs');await extra({send,ev,test,blocked,sleep});throw SMOKE_DONE;
 }
 if(process.argv.includes('--baseline-smoke')){
  await test('native playable party',async()=>{const p=await send('party.info');assert.ok(p.members.length);return p;});
  for(const kind of ['item','skill','actor'])await test('catalog '+kind,async()=>{const c=await send('catalog.query',{kind,limit:20000});assert.ok(c.total>0);return {total:c.total};});
  await test('gold mutation and restore',async()=>{const p=await send('party.info');try{await send('gold.set',{value:731});assert.equal((await send('party.info')).gold,731);}finally{await send('gold.set',{value:p.gold});}});
  await test('save round trip',async()=>{await send('gold.set',{value:1234});await send('save.save',{id:1});await send('gold.set',{value:2345});await send('save.load',{id:1});await sleep(1500);assert.equal((await send('party.info')).gold,1234);});
  await test('live connection after mutations',()=>send('ping'));throw SMOKE_DONE;
 }
 await test('engine ready',async()=>{const deadline=Date.now()+90000;while(Date.now()<deadline){try{const c=await send('catalog.query',{kind:'item',limit:1});if(c.total>0)return c.total;}catch{}await sleep(1000);}throw Error('item database empty after 90 seconds');});
 for(const cmd of ['ping','runtime.info','trainer.hooks.info','scene.info','trainer.options.get'])await test(cmd,async()=>{const r=await send(cmd);assert.ok(r);return cmd==='runtime.info'?r:{response:true};});
 const rgss=/rgss|rgd/i.test(report.strategy||'');
 if(!rgss)await test('native boot scene ready',async()=>{for(let n=0;n<120;n++){const s=await send('scene.info');if(s.current&&/Title|Map$/.test(s.current))return s.current;await sleep(500);}throw Error('native title/map did not complete; splash screens are not ready');});
 await test('console arithmetic',async()=>assert.equal(Number(await ev('6*7')),42));
 const catalogs={};
 for(const kind of ['item','weapon','armor','skill','state','actor','commonEvent'])await test('catalog '+kind,async()=>{const r=await send('catalog.query',{kind,limit:20000});assert.ok(Array.isArray(r.entries));assert.ok(r.total>0,'empty catalog');if(scan.gameKey==='wanzu122'&&['weapon','armor'].includes(kind))assert.ok(r.total>=500,'native database must not be replaced by an inventory subset');catalogs[kind]=r.entries;return {total:r.total,returned:r.entries.length};});
 if(!rgss)await test('icon sheet',async()=>{const r=await send('assets.iconset');assert.ok(r.width>0&&r.dataUrl?.length>100);return {width:r.width,height:r.height};});
 let party=await send('party.info').catch(()=>null);
 if(!party?.members?.length){
  const existing=await send('save.list').catch(()=>({entries:[]}));
  const slots=[...new Set((existing.entries||[]).map(e=>e.slot||Number(e.name.match(/(?:file|save|tclh)(\d+)\./i)?.[1])).filter(n=>n>0))].sort((a,b)=>a-b).slice(0,3);
  report.setupAttempts=[];
  for(const slot of slots){try{await send('save.load',{id:slot});await sleep(1500);party=await send('party.info').catch(()=>null);report.setupAttempts.push({slot,party:party?.members?.length||0});if(party?.members?.length)break;}catch(e){report.setupAttempts.push({slot,error:e.message});}}
 }
 if(!party?.members?.length){if(!rgss)await test('new game',()=>send('game.newGame'));await sleep(5000);const {enter}=await import('./retest-enter-20260908.mjs');await enter({send,ev,sleep,rgss});}
 party=await send('party.info').catch(()=>null);
 if(!party?.members?.length&&catalogs.actor?.length){
  const first=catalogs.actor.find(a=>a.id===1)||catalogs.actor[0];
  await test('isolated fixture: add initial actor through toolbox',()=>send('party.addActor',{id:first.id}));
  party=await send('party.info').catch(()=>null);
 }
 if(!party?.members?.length){
  const saves=await send('save.list').catch(()=>({entries:[]}));
  for(const entry of saves.entries||[]){const id=entry.slot||Number(entry.name.match(/(?:file|save|tclh)(\d+)/i)?.[1]);if(!id)continue;await test('load existing copy slot '+id,()=>send('save.load',{id}));await sleep(2000);party=await send('party.info').catch(()=>null);if(party?.members?.length)break;}
 }
 await test('playable party',async()=>{assert.ok(party?.members?.length,'no party');return party.members.map(a=>({id:a.id,name:a.name}));});
 if(!party?.members?.length)throw Error('No playable state: mutation tests blocked');
  if(!rgss&&process.argv.includes('--idle-fixture')){report.fixture='Disposable runtime: suppress automatic intro events and dismiss messages to test idle-map tools without altering game files.';await prepareIdleFixture();}
 for(const action of ['clearCurrentEvent','clearMoveRoute','fadeIn','clearPictures','gotoMap'])await test('repair '+action,()=>send('game.repair',{action}));
 await sleep(1500);
 await test('gold set/add readback',async()=>{await send('gold.set',{value:1000});await send('gold.add',{amount:51});assert.equal((await send('party.info')).gold,1051);});
 for(const kind of ['item','weapon','armor']){
  let item=catalogs[kind]?.find(x=>x.name&&x.id>1);
  if(scan.gameKey==='sanguoxiuxian'&&kind!=='item'){
   const nativeId=await ev(`(function(){var table=window.${kind==='weapon'?'$dataWeapons':'$dataArmors'};var entry=table.find(function(x){return x&&x.name&&x.${kind==='weapon'?'wtypeId':'atypeId'}>0&&!(x.meta&&x.meta['Affix Item Set']);});return entry&&entry.id})()`);
   item=catalogs[kind]?.find(x=>x.id===nativeId);
  }
  if(!item){blocked('inventory '+kind,'no catalog entry');continue;}
  await test('inventory '+kind+' set/add/remove',async()=>{
   await send('item.set',{kind,id:item.id,count:2});await send('item.add',{kind,id:item.id,amount:1});
   const matches=x=>x.kind===kind&&(x.id===item.id||x.baseItemId===item.id);
   let entries=(await send('item.list')).entries.filter(matches);assert.ok(entries.length,'item absent after adding');
   assert.equal(entries.reduce((n,x)=>n+x.count,0),3);for(const entry of entries)await send('item.set',{kind,id:entry.id,count:0});assert.equal((await send('item.list')).entries.filter(matches).reduce((n,x)=>n+x.count,0),0);return {id:item.id};
  });
 }
 const id=party.members[0].id;const actor=async()=>(await send('actor.info',{id})).actor;
 await test('actor experience',async()=>{const old=await actor();await send('actor.exp.add',{id,amount:10});const current=await actor();assert.ok(current.level>old.level||current.exp>=old.exp+10,`experience or level did not increase from ${old.level}/${old.exp}`);});
 await test('actor level',async()=>{await send('actor.level.set',{id,level:5});assert.equal((await actor()).level,5);});
 await test('actor parameters',async()=>{const old=await actor();await send('actor.param.add',{id,paramId:0,value:10});const after=await actor();assert.equal(after.paramPlus[0],old.paramPlus[0]+10);assert.ok(after.mhp>old.mhp,'native maximum HP must increase');return {before:old.mhp,after:after.mhp};});
 await test('actor HP MP TP',async()=>{await send('actor.vitals.set',{id,hp:1,mp:0,tp:20});const a=await actor();assert.equal(a.hp,1);assert.equal(a.mp,0);if(a.tp!=null)assert.equal(a.tp,20);});
 await test('actor recover',async()=>{await send('actor.recover',{id});const a=await actor();assert.equal(a.hp,a.mhp);assert.equal(a.mp,a.mmp);});
 for(const field of ['name','nickname'])await test('actor '+field,async()=>{const old=(await actor())[field];await send('actor.'+field+'.set',{id,[field]:'RMCH测试'});assert.equal((await actor())[field],'RMCH测试');await send('actor.'+field+'.set',{id,[field]:old||''});});
 const currentSkills=(await actor()).skills||[];
 const skill=catalogs.skill?.find(x=>x.name&&x.id>2&&!currentSkills.some(s=>s.id===x.id));
 if(skill)await test('learn/forget skill',async()=>{await send('actor.skill.learn',{id,skillId:skill.id});assert.ok((await actor()).skills.some(s=>s.id===skill.id));await send('actor.skill.forget',{id,skillId:skill.id});assert.ok(!(await actor()).skills.some(s=>s.id===skill.id));});else blocked('learn/forget skill','no unowned skill');
 const state=catalogs.state?.find(x=>x.id>1);
 if(state)await test('add/remove state',async()=>{await send('actor.state.add',{id,stateId:state.id});assert.ok((await actor()).states.some(s=>s.id===state.id));await send('actor.state.remove',{id,stateId:state.id});assert.ok(!(await actor()).states.some(s=>s.id===state.id));});
 await test('party recovery',async()=>{await send('party.recover');assert.ok((await send('party.info')).members.every(a=>a.hp===a.mhp));});
 for(const kind of ['switch','variable'])await test(kind+' edit and lock',async()=>{
  const list=await send(kind+'.list',{offset:1,limit:20000});const e=list.entries.at(-1);assert.ok(e);const value=kind==='switch'?!e.value:731;
  await send(kind+'.set',{id:e.id,value});assert.equal((await send(kind+'.list',{offset:e.id,limit:1})).entries[0].value,value);
  await send('lock.set',{kind,id:e.id,value});await send(kind+'.set',{id:e.id,value:e.value});await sleep(1100);assert.equal((await send(kind+'.list',{offset:e.id,limit:1})).entries[0].value,value);
  await send('lock.clear',{kind,id:e.id});await send(kind+'.set',{id:e.id,value:e.value});
 });
 await test('gold lock',async()=>{await send('lock.set',{kind:'gold',value:500});await send('gold.set',{value:999});await sleep(1100);assert.equal((await send('party.info')).gold,500);await send('lock.clear',{kind:'gold'});});
 const options=(await send('trainer.options.get')).options;
 for(const [key,value] of Object.entries(options)){
  if(typeof value!=='boolean'&&typeof value!=='number')continue;
  await test('trainer option '+key+' readback',async()=>{const target=typeof value==='boolean'?!value:(value===2?3:2);try{await send('trainer.options.set',{[key]:target});assert.equal((await send('trainer.options.get')).options[key],target);}finally{await send('trainer.options.set',{[key]:value});}});
 }
 for(const cmd of ['map.list','map.info','map.events.list','player.location','battle.info','lock.list','save.list'])await test(cmd,async()=>{const r=await send(cmd);assert.ok(r);return cmd==='save.list'?r:{response:true};});
 const inspect=await test('map inspect',()=>send('map.inspect'));
 if(inspect?.mapToken){
  await test('map grid',async()=>{const r=await send('map.grid',{mapToken:inspect.mapToken,offset:0,count:100});assert.ok(r.cells?.length);return {cells:r.cells.length};});
  await test('running event interpreters',()=>send('events.running',{mapToken:inspect.mapToken}));
  const event=inspect.events?.[0];if(event)await test('map event reader',()=>send('events.read',{mapToken:inspect.mapToken,kind:'map',id:event.eventId||event.id,pageIndex:0,count:100}));
  await test('confirmed coordinate move',async()=>{const loc=await send('player.location');await send('map.move',{mapToken:inspect.mapToken,x:loc.x,y:loc.y,force:true,confirmed:true});});
 }
 const ce=catalogs.commonEvent?.[0];if(ce)await test('common event reader',async()=>{const current=await send('map.inspect');return send('events.read',{mapToken:current.mapToken,kind:'common',id:ce.id,count:100});});
 await test('map through toggle',async()=>{await send('map.through.set',{value:true});assert.equal((await send('map.through.toggle')).through,false);});
 // Only save locations inside this independent copy or its toolbox-owned shadow are acceptable.
 const saves=await send('save.list');const allowed=[root,path.join(projectRoot,'runtime/shadow-apps',scan.gameKey),path.join(projectRoot,'runtime/rgss-shadow',scan.gameKey)];
 if(saves.storage==='webstorage'||saves.storage==='native'&&scan.gameKey==='sanguoxiuxian'||saves.dir&&allowed.some(p=>path.resolve(saves.dir).toLowerCase().startsWith(p.toLowerCase()+path.sep)||path.resolve(saves.dir).toLowerCase()===p.toLowerCase())){
  await test('save/load persisted gold',async()=>{await send('gold.set',{value:1234});await send('save.save',{id:1});await send('gold.set',{value:5678});await send('save.load',{id:1});await sleep(1500);assert.equal((await send('party.info')).gold,1234);});
  if(saves.storage==='webstorage')await test('browser save backup/restore',async()=>{const snapshot=await send('save.webstorage.export');assert.ok(snapshot.entries.length);const r=await send('save.webstorage.import',{snapshot});assert.equal(r.restored,snapshot.entries.length);});
  else if(saves.storage==='native')await test('native slot backup/restore',async()=>{const snapshot=await send('save.native.export');assert.ok(snapshot.entries.length);const r=await send('save.native.import',{snapshot});assert.equal(r.restored,snapshot.entries.length);const again=await send('save.native.export');assert.deepEqual(again.entries,snapshot.entries);});
  else await test('file backup/list/delete/restore bytes',async()=>{
   const files=createSaveFiles({projectRoot,resolveLocation:()=>({gameRoot:root,saveDir:saves.dir})});
   const backup=files.backup(scan.gameKey),name=path.basename(backup.destDir);assert.ok(backup.files>0);assert.ok(files.listBackups(scan.gameKey).some(x=>x.name===name));
   const entry=(await send('save.list')).entries.find(e=>/\d+\.(rpgsave|rmmzsave|rxdata|rvdata|rvdata2)$/i.test(e.name));assert.ok(entry,'no numbered save to restore');
   const target=path.join(saves.dir,entry.name),bytes=fs.readFileSync(target);files.deleteSave(scan.gameKey,entry.name);assert.equal(fs.existsSync(target),false);files.restore(scan.gameKey,name);assert.deepEqual(fs.readFileSync(target),bytes);
   assert.ok(path.resolve(backup.destDir).startsWith(path.join(projectRoot,'backups')+path.sep));files.deleteBackup(scan.gameKey,name);assert.ok(!files.listBackups(scan.gameKey).some(x=>x.name===name));return {files:backup.files};
  });
 }else blocked('save/load','save directory is not inside isolated test roots: '+saves.dir);
 await test('live save tree get/apply',async()=>{const data=await send('save.contents.get',{limitBytes:20*1024*1024});assert.ok(data.bytes>100);const result=await send('save.contents.apply',{json:data.json});assert.equal(result.applied,true);await sleep(1000);assert.ok((await send('party.info')).members.length);return {bytes:data.bytes};});
 const scenes=await send('scene.info');
 for(const name of process.argv.includes('--skip-scenes')?[]:['Scene_Item','Scene_Skill','Scene_Equip','Scene_Status','Scene_Menu','Scene_Save','Scene_Load','Scene_Options','Scene_Debug']){
  if(!scenes.available?.includes(name)){blocked('scene '+name,'not exposed by game');continue;}
  await test('scene '+name,async()=>{
   const expected=await ev(`window[${JSON.stringify(name)}].name`),previous=(await send('scene.info')).current;
   const waitScene=async names=>{for(let n=0;n<100;n++){await sleep(100);const current=(await send('scene.info')).current;if(names.includes(current)&&await ev(`(function(){var m=window.TK&&TK.$&&TK.$.SceneMrg||window.SceneManager;return m&&!m._stopped&&!m._nextScene&&m._sceneStarted!==false&&m._scene&&(!m._scene.isReady||m._scene.isReady())})()`))return;}throw Error('native scene did not finish loading: '+names.join('/'));};
   let pushed=false;try{await send('scene.push',{name});pushed=true;await waitScene([name,expected]);}
   finally{if(pushed){await send('scene.pop');await waitScene([previous]);}}
  });
 }
 await test('final live connection',async()=>assert.ok(await send('ping')));
 if(!rgss)await test('return to idle map after scene tests',async()=>{await send('game.repair',{action:'gotoMap'});let m;for(let n=0;n<30;n++){await sleep(200);if(process.argv.includes('--idle-fixture'))await send('game.repair',{action:'clearCurrentEvent'});m=await send('map.inspect');if(!m.busy)return {mapId:m.mapId};}throw Error(m.busy||'map did not resume after scene tests');});
 if(!rgss){const {extra}=await import('./retest-extra-20260909.mjs');await extra({send,ev,test,blocked,sleep});}
 const {effects}=await import('./retest-effects-20260908.mjs');
 await effects({send,ev,test,blocked,sleep});
 blocked('GUI visual interactions','Command-layer phase; browser/desktop UI suite is separate');
}catch(e){if(e!==SMOKE_DONE){report.error=e.stack;console.error(e.stack);}}
finally{
 if(pid)await new Promise(r=>execFile('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true},r));
 // Some launchers exit and leave a child. Close only processes under this run's exact roots.
 const roots=[root,path.join(projectRoot,'runtime/shadow-apps',scan.gameKey),path.join(projectRoot,'runtime/rgss-shadow',scan.gameKey)].map(p=>p.toLowerCase()+path.sep);
 for(const name of new Set(['Game.exe',path.basename(scan.paths.exe||'Game.exe'),path.parse(scan.paths.exe||'Game.exe').name+'.rmch-cdp.exe'])){
  for(const p of await listProcessesByExeName(name).catch(()=>[]))if(p.ExecutablePath&&roots.some(r=>p.ExecutablePath.toLowerCase().startsWith(r)))await new Promise(r=>execFile('taskkill',['/PID',String(p.ProcessId),'/T','/F'],{windowsHide:true},r));
 }
 for(const kind of ['rgss','tauri'])externalSessions.get(kind,scan.gameKey)?.close?.();
 report.finished=new Date().toISOString();save();console.log('TOTAL',JSON.stringify(report.checks.reduce((a,c)=>(a[c.status]=(a[c.status]||0)+1,a),{})));
 process.exit(report.error||report.checks.some(c=>c.status==='fail')?1:0);
}
