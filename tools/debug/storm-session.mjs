// Dedicated local acceptance session. Pass an independent game copy as argv[2].
import http from 'node:http';
import path from 'node:path';
import {gameRuntime} from '../../core/game-runtime.mjs';
import {BridgeServer} from '../../core/ws-server.mjs';
import {getToken} from '../../core/token.mjs';
const projectRoot=path.resolve(import.meta.dirname,'../..');
const gameRoot=path.resolve(process.argv[2]||path.join(projectRoot,'tmp/storm-196-isolated'));
const scan=gameRuntime.scan(gameRoot);
const server=new BridgeServer({port:19435,token:getToken(projectRoot),stateDir:path.join(projectRoot,'runtime/bridge-state')});
await server.start();
server.on('session-open',key=>console.log('session open',key));
const summary=await gameRuntime.launch({gameRoot,projectRoot,port:19435});
console.log(JSON.stringify({pid:summary.pid,strategy:summary.strategy,root:gameRoot}));
http.createServer(async(req,res)=>{
 let data='';for await(const chunk of req)data+=chunk;
 try {const q=JSON.parse(data);const session=server.sessions.get(scan.gameKey);if(!session)throw Error('No session');const out=await session.sendCommand(q.type,q.args||{},30000);res.end(JSON.stringify({ok:true,out}));}
 catch(e){res.end(JSON.stringify({ok:false,error:e.message}));}
}).listen(19436,'127.0.0.1',()=>console.log('diagnostic endpoint 19436 ready'));
