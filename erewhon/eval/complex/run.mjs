import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {scenarios} from './scenarios.mjs';
const output=process.env.EREWHON_EVAL_OUTPUT;
if(!path.isAbsolute(output??'')||!process.env.PI_CODING_AGENT_DIR)throw new Error('Set private absolute output and PI_CODING_AGENT_DIR.');
await fs.mkdir(output,{recursive:true,mode:0o700});const summaries=[];
const {createHash}=await import('node:crypto');const hashes={};for(const name of ['recipes','ordering','tools','product-choices'])hashes[name]=createHash('sha256').update(await fs.readFile(new URL(`../../src/${name}.mjs`,import.meta.url))).digest('hex');await fs.writeFile(path.join(output,'source-hashes.json'),JSON.stringify(hashes,null,2),{mode:0o600});
for(const scenario of process.argv.slice(2).length?process.argv.slice(2):Object.keys(scenarios)){
 const trace=path.join(output,`${scenario}-trace.jsonl`),grade=path.join(output,`${scenario}-grade.json`),transcript=path.join(output,`${scenario}.jsonl`);
 await fs.writeFile(trace,'',{mode:0o600});const fd=await fs.open(transcript,'w',0o600);const started=Date.now();
 const args=['--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-approve','--no-builtin-tools','--no-session','-e',fileURLToPath(new URL('./pi-extension.mjs',import.meta.url)),'--provider','local-qwen','--model',process.env.EREWHON_EVAL_MODEL??'qwen3.6:35b','--thinking',process.env.EREWHON_EVAL_THINKING??'off','--mode','json','--print','__EREWHON_SCENARIO__'];
 const exitCode=await new Promise((resolve,reject)=>{const p=spawn(process.env.EREWHON_PI??'/opt/homebrew/bin/pi',args,{env:{...process.env,EREWHON_EVAL_SCENARIO:scenario,EREWHON_EVAL_TRACE:trace,EREWHON_EVAL_GRADE:grade},stdio:['ignore',fd.fd,fd.fd]});const timer=setTimeout(()=>p.kill('SIGTERM'),240000);p.on('error',reject);p.on('exit',c=>{clearTimeout(timer);resolve(c);});});
 await fd.close();let summary;try{summary=JSON.parse(await fs.readFile(grade,'utf8'));}catch{summary={scenario,passed:false,reason:'no final grade'};}
 const transcriptEvents=(await fs.readFile(transcript,'utf8')).split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
 const messages=transcriptEvents.filter(e=>e.type==='message_end').map(e=>e.message);
 const attemptedCalls=messages.filter(m=>m.role==='assistant').flatMap(m=>m.content??[]).filter(c=>c.type==='toolCall');
 const validationErrors=messages.filter(m=>m.role==='toolResult'&&m.isError&&m.content?.some(c=>c.text?.includes('Validation failed'))).length;
 Object.assign(summary,{attemptedCalls:attemptedCalls.map(c=>c.name),validationErrors,exitCode,seconds:Math.round((Date.now()-started)/1000)});summaries.push(summary);console.log(JSON.stringify(summary));await fs.writeFile(path.join(output,'summary.json'),JSON.stringify({model:process.env.EREWHON_EVAL_MODEL??'qwen3.6:35b',harness:'Pi',thinking:process.env.EREWHON_EVAL_THINKING??'off',hashes,summaries},null,2),{mode:0o600});
}
if(summaries.some(s=>!s.passed))process.exitCode=1;
