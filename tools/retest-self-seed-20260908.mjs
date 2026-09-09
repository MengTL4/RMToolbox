import { SEALED_SEED_FN } from '../core/sealed-seed.mjs';
import { spawnSync } from 'node:child_process';
const publisher=process.argv.includes('--scenes') ? `function(){return this.filter(x=>typeof x==='function'&&/^Scene_/.test(x.name)).map(x=>x.name)}` : SEALED_SEED_FN;
const code = `(function(){
 let target;
 const post=(method,params)=>new Promise((resolve,reject)=>chrome.debugger.sendCommand(target,method,params,result=>{
   if(chrome.runtime.lastError)reject(new Error(chrome.runtime.lastError.message));else resolve(result);
 }));
 (async function(){
   try {
     const targets=await new Promise(resolve=>chrome.debugger.getTargets(resolve));
     const own=targets.find(t=>t.type==='page'&&t.url===location.href);
     if(!own)throw new Error('own game target missing');
     target={targetId:own.id};
     await new Promise((resolve,reject)=>chrome.debugger.attach(target,'1.3',()=>chrome.runtime.lastError?reject(new Error(chrome.runtime.lastError.message)):resolve()));
     const proto=await post('Runtime.evaluate',{expression:'Object.prototype',objectGroup:'rmch-probe'});
     const heap=await post('Runtime.queryObjects',{prototypeObjectId:proto.result.objectId,objectGroup:'rmch-probe'});
     const result=await post('Runtime.callFunctionOn',{objectId:heap.objects.objectId,functionDeclaration:${JSON.stringify(publisher)},returnByValue:true});
     window.__rmchSelfSeedResult=result;
   }catch(e){window.__rmchSelfSeedResult={error:String(e)}}
   finally {await post('Runtime.releaseObjectGroup',{objectGroup:'rmch-probe'});chrome.debugger.detach(target,function(){});}
 })();return 'seed pending';
})()`;
const r=spawnSync(process.execPath,['tools/retest-command-20260908.mjs',process.argv[2],'console.eval',JSON.stringify({code})],{encoding:'utf8'});
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exitCode=r.status||0;
