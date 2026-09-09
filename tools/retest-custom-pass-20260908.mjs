import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const project=path.resolve(import.meta.dirname,'..'),base=path.join(project,'tmp/full-retest-20260908'),out=path.join(base,'custom-pass');fs.mkdirSync(out,{recursive:true});
while(true){try{if(JSON.parse(fs.readFileSync(path.join(base,'native-battle/progress.json'))).length===6)break;}catch{}await new Promise(r=>setTimeout(r,1000));}
for(const id of ['homecoming','storm']){
 console.log(new Date().toISOString(),'START',id);const fd=fs.openSync(path.join(out,id+'.log'),'w');
 const r=spawnSync(process.execPath,[path.join(project,'tools/retest-game-20260908.mjs'),path.join(base,'games',id),path.join(out,id+'.json'),'--idle-fixture','--skip-scenes'],{cwd:project,stdio:['ignore',fd,fd],windowsHide:true,timeout:480000});fs.closeSync(fd);console.log(new Date().toISOString(),'DONE',id,r.status);
}
