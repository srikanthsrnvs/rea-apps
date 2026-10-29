#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const output = process.env.EREWHON_EVAL_OUTPUT;
if (!output || !path.isAbsolute(output) || !process.env.PI_CODING_AGENT_DIR) throw new Error('Set absolute EREWHON_EVAL_OUTPUT and PI_CODING_AGENT_DIR (containing a local model configuration).');
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const extension = fileURLToPath(new URL('./pi-extension.mjs', import.meta.url));
const scenarios = process.argv.slice(2).length ? process.argv.slice(2) : ['fresh','saved','interrupted','pending','approved','repeat','ambiguous'];
const summaries = [];
for (const scenario of scenarios) {
  const trace = path.join(output, `${scenario}-trace.jsonl`);
  const transcript = path.join(output, `${scenario}.jsonl`);
  await fs.writeFile(trace, '', { mode: 0o600 });
  const handle = await fs.open(transcript, 'w', 0o600);
  const started = Date.now();
  const args = ['--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-approve','--no-builtin-tools','--no-session',
    '-e',extension,'--provider',process.env.EREWHON_EVAL_PROVIDER ?? 'local-qwen','--model',process.env.EREWHON_EVAL_MODEL ?? 'qwen3.6:35b',
    '--thinking','off','--mode','json','--print','__EREWHON_SCENARIO__'];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.env.EREWHON_PI ?? 'pi', args, { env: { ...process.env, EREWHON_EVAL_SCENARIO:scenario, EREWHON_EVAL_TRACE:trace, EREWHON_EVAL_PROFILE:process.env.EREWHON_EVAL_PROFILE ?? 'ordering' }, stdio:['ignore',handle.fd,handle.fd] });
    const timeout=setTimeout(()=>child.kill('SIGTERM'),180_000);
    child.on('error',error=>{clearTimeout(timeout);reject(error);});
    child.on('exit',code=>{clearTimeout(timeout);resolve(code);});
  });
  await handle.close();
  const parseLines = text => text.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  const events = parseLines(await fs.readFile(trace,'utf8'));
  const messages = parseLines(await fs.readFile(transcript,'utf8')).filter(event=>event.type==='message_end' && event.message.role==='assistant').map(event=>event.message);
  const last = messages.at(-1);
  const final = last?.content?.filter(item=>item.type==='text').map(item=>item.text).join('\n') ?? '';
  const calls=events.filter(event=>event.type==='call');
  const results=events.filter(event=>event.type==='result');
  const state=events.filter(event=>event.type==='state').at(-1);
  const prepared=results.some(event=>event.result?.status==='prepared');
  const statuses=results.filter(event=>event.name==='order_status').map(event=>event.result);
  const errors=results.filter(event=>event.result?.error).length;
  let passed=exitCode===0 && Boolean(final);
  if(['fresh','saved','repeat'].includes(scenario))passed&&=prepared&&state?.quantity===1&&state?.rows===1&&state?.placements===0&&(scenario==='repeat'||/9\.97/.test(final))&&calls.length<=6;
  else if(scenario==='interrupted')passed&&=statuses.some(result=>result.orderPlaced===false)&&state?.placements===0&&/not|hasn.t|wasn.t|no order|only.*prepar/i.test(final);
  else if(scenario==='pending')passed&&=statuses.some(result=>result.orderPlaced===null)&&state?.placements===0&&/unknown|uncertain|cannot|can.t|unable|unresolved|may already|may have|might have/i.test(final)&&!/start over|not gone through|has not.*gone|not been placed|hasn.t been placed/i.test(final);
  else if(scenario==='approved')passed&&=state?.placements===1&&results.some(event=>event.result?.orderPlaced===true&&event.result.orderId);
  else if(scenario==='ambiguous')passed&&=state?.placements===0&&state?.quantity===0&&errors>0&&/which|clarif|confirm|specif|ambig|detail|brand|sku|multiple|choose/i.test(final)&&!/\$\d|Latte|Americano|not found/i.test(final);
  const summary={scenario,passed,calls:calls.map(call=>call.name),errors,state,seconds:Math.round((Date.now()-started)/1000),final};
  summaries.push(summary);
  console.log(JSON.stringify(summary));
  await fs.writeFile(path.join(output,'summary.json'),JSON.stringify({model:process.env.EREWHON_EVAL_MODEL ?? 'qwen3.6:35b',harness:'Pi',profile:process.env.EREWHON_EVAL_PROFILE ?? 'ordering',summaries},null,2),{mode:0o600});
}
if (summaries.some(summary=>!summary.passed)) process.exitCode=1;
