import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../',import.meta.url));
const [key,type,json='{}'] = process.argv.slice(2);
if(!key || path.basename(key)!==key || !type) throw Error('Usage: bridge-file-command <gameKey> <type> [JSON args]');
const dir=path.join(root,'runtime','bridge-state',key);
const id=`diagnostic-${Date.now()}`;
fs.appendFileSync(path.join(dir,'commands.jsonl'),JSON.stringify({commandId:id,ts:Date.now(),type,args:JSON.parse(json)})+'\n');
for(let i=0;i<100;i++) {
  await new Promise(r=>setTimeout(r,200));
  const file=path.join(dir,'events.jsonl');
  if(!fs.existsSync(file))continue;
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) {
    let event;try{event=JSON.parse(line)}catch{continue}
    if(event.commandId!==`file:${id}`)continue;
    console.log(JSON.stringify(event,null,2));process.exit(event.ok?0:1);
  }
}
throw Error('No response from the live bridge');
