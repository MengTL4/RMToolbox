import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchGame} from '../../core/launcher.mjs';
const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const gameRoot=path.resolve(process.argv[2] || path.join(projectRoot,'tmp/homecoming-0133-isolated'));
if(!fs.existsSync(path.join(gameRoot,'.rmch-isolated-test'))) throw Error('Run only on a disposable full copy marked with .rmch-isolated-test');
const diagnosticPort=Number(process.env.RMCH_TEST_PORT)||19433;
process.env.WEBVIEW2_USER_DATA_FOLDER=gameRoot+'/webview-test-profile';
const summary=await launchGame({gameRoot,projectRoot});
const session=summary.tauriSession;
console.log(JSON.stringify({pid:summary.pid,port:summary.cdpPort,root:gameRoot}));
http.createServer(async(req,res)=>{
 let data='';for await(const chunk of req)data+=chunk;
 try{const q=JSON.parse(data);const out=q.eval?await session.cdp.evaluate(q.eval,20000):await session.send(q.type,q.args||{});res.end(JSON.stringify({ok:true,out}));}
 catch(e){res.end(JSON.stringify({ok:false,error:e.message}));}
}).listen(diagnosticPort,'127.0.0.1',()=>console.log('diagnostic endpoint '+diagnosticPort+' ready'));
