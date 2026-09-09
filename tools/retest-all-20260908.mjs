// Real-game acceptance orchestrator. Each mutable test runs on a full independent copy.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const project=path.resolve(import.meta.dirname,'..');
const out=path.join(project,'tmp/full-retest-20260908');fs.mkdirSync(out,{recursive:true});
const resultDir=path.join(out,process.env.RMCH_RETEST_ROUND||'.');fs.mkdirSync(resultDir,{recursive:true});
const base='D:/Downloads/RPG';
const steam='F:/SteamLibrary/steamapps/common';
const games=[
 ['zsyb1',`${steam}/再刷一把 PlayAgain`],['zsyb2',`${steam}/再刷一把2：金色传说`],
 ['mengyan',`${steam}/Nightmare without return`],['daqian2',`${steam}/大千世界2 The Stupendous World Demo`],['shua',`${steam}/刷啊刷`],
 ['blacksouls1',`${base}/BLACK SOULS`],['blacksouls2',`${base}/BLACK SOULS II`],
 ['sanguo',`${base}/Three Kingdoms True Dragon`],['wanzu122',`${base}/_V1.2.2_B电脑端`],
 ['sanguoxiuxian',`${base}/三国修仙传V1.91PC端`],['qianlong',`${base}/三国志潜龙在渊/Three Kingdoms Heroes`],
 ['lunhui',`${base}/停不下来的轮回正式版v1.4.1`],['mingyun',`${base}/命运II离线版V4.6.3`],
 ['pokemon',`${base}/宝可梦赤途1.0.9.1（肝帝版修复版）/宝可梦赤途1.0.9.1（肝帝版修复版）_unpacked`],
 ['storm',`${base}/末日风暴-1.9.6`],['wujie',`${base}/武界风云传1.63 限界神宗正式发布版本体`],
 ['homecoming',`${base}/重装归途-0.1.33`],['liming',`${base}/黎明电脑版EXE`]
];
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({created:new Date().toISOString(),excluded:[`${base}/放弃适配`,'青岚','西游','所有压缩包'],games},null,2));
const selected=process.argv.slice(2);const results=[];
for(const [id,source] of games){
 if(selected.length&&!selected.includes(id))continue;
 const target=path.join(out,'games',id);
 console.log(new Date().toISOString(),'COPY',id,source);
 fs.cpSync(source,target,{recursive:true,dereference:true,preserveTimestamps:true,filter:(src)=>{
   const rel=path.relative(source,src);return !rel.split(path.sep).some(s=>/^(?:\.git|放弃适配|同能PC游戏盒子.exe|游戏错误解决方法FQA)$/i.test(s));
 }});
 fs.writeFileSync(path.join(target,'.rmch-isolated-test'),JSON.stringify({source,created:new Date().toISOString()}));
 console.log(new Date().toISOString(),'TEST',id);
 const logfile=path.join(resultDir,id+'.log');const fd=fs.openSync(logfile,'w');
 const extra=process.env.RMCH_RETEST_SHADOW==='1'?['--shadow']:[];
 const child=spawnSync(process.execPath,[path.join(project,'tools/retest-game-20260908.mjs'),target,path.join(resultDir,id+'.json'),...extra],{cwd:project,stdio:['ignore',fd,fd],windowsHide:true,timeout:900000});
 fs.closeSync(fd);results.push({id,source,target,exitCode:child.status,error:child.error?.message});
 fs.writeFileSync(path.join(resultDir,'progress.json'),JSON.stringify(results,null,2));
 console.log(new Date().toISOString(),'DONE',id,child.status,child.error?.message||'');
}
process.exitCode=results.some(r=>r.exitCode!==0)?1:0;
