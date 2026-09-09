import fs from 'node:fs';
import {getToken} from '../core/token.mjs';
import {extra} from './retest-extra-20260909.mjs';
const session=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),output=process.argv[3];
const socket=new WebSocket(`ws://127.0.0.1:${session.port}/client?token=${encodeURIComponent(getToken(session.projectRoot))}`);
const pending=new Map(),checks=[];let seq=0;
socket.onmessage=event=>{const r=JSON.parse(String(event.data));if(r.t!=='result')return;const p=pending.get(r.id);if(!p)return;clearTimeout(p.timer);pending.delete(r.id);r.ok?p.resolve(r.payload):p.reject(Error(r.error));};
await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
const send=(type,args={})=>new Promise((resolve,reject)=>{const id='extra-'+(++seq);pending.set(id,{resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(Error(type+' timeout'));},35000)});socket.send(JSON.stringify({t:'send',id,gameKey:session.gameKey,type,args}));});
const save=()=>fs.writeFileSync(output,JSON.stringify({gameKey:session.gameKey,checks},null,2));
const test=async(name,fn)=>{try{const detail=await fn();checks.push({name,status:'pass',detail});console.log('PASS',name);return detail;}catch(e){const status=/暂不支持数量锁|暂不支持额外游戏倍速|独立.*不支持.*锁/.test(e.message)?'limitation':'fail';checks.push({name,status,error:e.message});console.log(status.toUpperCase(),name,e.message);}finally{save();}};
const blocked=(name,reason)=>{checks.push({name,status:'blocked',reason});save();};
const suite=process.argv.includes('--effects')?(await import('./retest-effects-20260908.mjs')).effects:extra;
try{await suite({send,ev:async code=>(await send('console.eval',{code})).result,test,blocked,sleep:ms=>new Promise(r=>setTimeout(r,ms))});}
finally{save();socket.close();process.exit(checks.some(c=>c.status==='fail')?1:0);}
