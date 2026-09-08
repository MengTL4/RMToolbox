import { appendFileSync, readFileSync, existsSync } from 'node:fs';
// Diagnostic helper for a dedicated, unsaved 再刷一把2 test instance.
const dir = new URL('../../runtime/bridge-state/再刷一把2：金色传说/', import.meta.url);
const id = `stairs-${Date.now()}`;
const output = 'E:/project/RMToolbox/runtime/zs2-stairs-probe.json';
const expression = process.argv[2];
const code = `require("fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify((0,eval)(${JSON.stringify(expression)}),null,2)); "captured"`;
appendFileSync(new URL('commands.jsonl',dir), JSON.stringify({commandId:id,ts:Date.now(),type:'console.eval',args:{code}})+'\n');
for(let n=0;n<100;n++) {
  await new Promise(r=>setTimeout(r,200));
  const file=new URL('events.jsonl',dir);
  if(!existsSync(file)) continue;
  const result=readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(x=>{try{return JSON.parse(x)}catch{return {}}}).find(x=>x.commandId===`file:${id}`);
  if(result){console.log(JSON.stringify(result,null,2));process.exit(result.ok?0:1);}
}
console.error('No live bridge response');process.exit(2);
