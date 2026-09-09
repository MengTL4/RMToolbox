import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const project=path.resolve(import.meta.dirname,'..'),base=path.join(project,'tmp/full-retest-20260908'),out=path.join(base,'specialized');fs.mkdirSync(out,{recursive:true});
function run(label,script,args=[],env={}){console.log(new Date().toISOString(),'START',label);const fd=fs.openSync(path.join(out,label+'.log'),'w');const r=spawnSync(process.execPath,[path.join(project,script),...args],{cwd:project,env:{...process.env,...env},stdio:['ignore',fd,fd],windowsHide:true,timeout:1800000});fs.closeSync(fd);console.log(new Date().toISOString(),'END',label,r.status,r.error?.message||'');}
run('grover-copy-functional','tools/retest-all-20260908.mjs',['zsyb1','mengyan'],{RMCH_RETEST_ROUND:'copy-functional',RMCH_RETEST_SHADOW:'1'});
run('corrected-command-round','tools/retest-all-20260908.mjs',['zsyb2','daqian2','shua','sanguo','qianlong','mingyun','storm','homecoming','liming'],{RMCH_RETEST_ROUND:'round2'});
for(const id of ['blacksouls1','blacksouls2','wujie'])for(const kind of ['hooks','saves','contents'])run(id+'-'+kind,'tools/test-rgss-'+kind+'.mjs',[path.join(base,'games',id)]);
for(const [label,script] of [['pokemon-cmds','_probe-ess-cmds'],['pokemon-actor','_probe-ess-actor'],['pokemon-storage','_probe-ess-storage']])run(label,'tools/'+script+'.mjs',[path.join(base,'games/pokemon')]);
run('mengyan-source-readonly','tools/smoke-runtime-readonly.mjs',['F:/SteamLibrary/steamapps/common/Nightmare without return']);
