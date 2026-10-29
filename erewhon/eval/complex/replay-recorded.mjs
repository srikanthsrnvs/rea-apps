import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {session} from './session.mjs';
const [input,output]=process.argv.slice(2);
if(!path.isAbsolute(input??'')||!path.isAbsolute(output??''))throw new Error('Pass absolute private input and output directories.');
await fs.mkdir(output,{recursive:true,mode:0o700});
const original=JSON.parse(await fs.readFile(path.join(input,'regraded-summary.json'),'utf8'));
const hashes={};for(const name of ['recipes','ordering','tools','product-choices'])hashes[name]=createHash('sha256').update(await fs.readFile(new URL(`../../src/${name}.mjs`,import.meta.url))).digest('hex');
const summaries=[];
for(const observed of original.summaries){
 const events=(await fs.readFile(path.join(input,`${observed.scenario}-trace.jsonl`),'utf8')).split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
 const run=await session(observed.scenario);
 for(const event of events.filter(e=>e.type==='call'))await run.call(event.name,event.args);
 summaries.push(run.grade(observed.final));
}
await fs.writeFile(path.join(output,'summary.json'),JSON.stringify({type:'recorded_arguments_replay',modelInvocations:0,originalHashes:original.hashes,hashes,summaries},null,2),{mode:0o600});
console.log(JSON.stringify({replayed:summaries.length,passed:summaries.filter(s=>s.passed).length,modelInvocations:0}));
if(summaries.some(s=>!s.passed))process.exitCode=1;
