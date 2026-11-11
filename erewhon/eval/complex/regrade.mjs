import fs from 'node:fs/promises';
import path from 'node:path';
import {session} from './session.mjs';
const output=process.env.EREWHON_EVAL_OUTPUT;
if(!path.isAbsolute(output??''))throw new Error('Set absolute output directory.');
const {createHash}=await import('node:crypto');
const original=JSON.parse(await fs.readFile(path.join(output,'summary.json'),'utf8'));
for(const [name,expected] of Object.entries(original.hashes??{})){const actual=createHash('sha256').update(await fs.readFile(new URL(`../../src/${name}.mjs`,import.meta.url))).digest('hex');if(actual!==expected)throw new Error(`Production source differs for ${name}; do not regrade across implementations.`);}
const summaries=[];
for(const old of original.summaries){
 const events=(await fs.readFile(path.join(output,`${old.scenario}-trace.jsonl`),'utf8')).split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
 const run=await session(old.scenario);
 for(const event of events.filter(e=>e.type==='call'))await run.call(event.name,event.args);
 const current=run.grade(old.final);
 summaries.push({...old,...current});
}
const updated={...original,gradingNote:'Replay of recorded tool arguments, without model inference; instruction comparison ignores case/whitespace. Production hashes must match.',summaries};
await fs.writeFile(path.join(output,'regraded-summary.json'),JSON.stringify(updated,null,2),{mode:0o600});
console.log(JSON.stringify({cases:summaries.length,passed:summaries.filter(s=>s.passed).length,failed:summaries.filter(s=>!s.passed).map(s=>s.scenario)}));
