// Real multi-turn Pi test. Mutates only the cart; confirmation is not exposed.
// Requires an EMPTY live cart. Leaves the final requested cart intact.
import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {StringDecoder} from 'node:string_decoder';
import {cartRows} from '../../src/ordering-protocol.mjs';
const exec=promisify(execFile),env=process.env;
const host=env.EREWHON_EVAL_SSH_HOST,socket=env.EREWHON_EVAL_SSH_SOCKET;
if(!host||!socket||!env.EREWHON_EVAL_OUTPUT||!env.PI_CODING_AGENT_DIR)throw Error('Set EREWHON_EVAL_SSH_HOST, EREWHON_EVAL_SSH_SOCKET, EREWHON_EVAL_OUTPUT and PI_CODING_AGENT_DIR.');
const out=path.resolve(env.EREWHON_EVAL_OUTPUT);fs.mkdirSync(out,{recursive:true,mode:0o700});fs.chmodSync(out,0o700);
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
const ssh=['-S',socket,'-o','BatchMode=yes','-o',`HostKeyAlias=${env.EREWHON_EVAL_SSH_ALIAS??'truffle-2217.local'}`,'-o','StrictHostKeyChecking=yes',host];
async function cart(){const r=await exec('ssh',[...ssh,[env.EREWHON_EVAL_REMOTE_CLI??'/home/truffle/.local/bin/erewhon','cart'].map(quote).join(' ')],{timeout:60_000,maxBuffer:2*1024*1024});return JSON.parse(r.stdout);}
const save=(name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const initial=await cart();save('before-cart.json',initial);
if(cartRows(initial).some(row=>row.quantity>0))throw Error('Live cart is occupied. Stopped without changing it.');
const trace=path.join(out,'trace.jsonl');if(fs.existsSync(trace))throw Error('Use a fresh evaluation directory.');
const extension=new URL('../pi-live-extension.mjs',import.meta.url).pathname;
const child=spawn(env.EREWHON_EVAL_PI??'pi',['--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-approve','--no-builtin-tools','--no-session','-e',extension,'--provider',env.EREWHON_EVAL_PROVIDER??'local-qwen','--model',env.EREWHON_EVAL_MODEL??'rea-erewhon-qwen35b-eval','--thinking','low','--mode','rpc'],{env:{...env,EREWHON_EVAL_TRACE:trace},stdio:['pipe','pipe',fs.openSync(path.join(out,'stderr.log'),'w',0o600)]});
async function* records(){let buffer='';const decoder=new StringDecoder('utf8');for await(const chunk of child.stdout){buffer+=decoder.write(chunk);let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line.trim())yield JSON.parse(line);}}}
const events=records(),transcript=fs.openSync(path.join(out,'transcript.jsonl'),'w',0o600),turns=[];
const deadline=setTimeout(()=>child.kill('SIGTERM'),12*60_000);
const prompts=JSON.parse(env.EREWHON_EVAL_PROMPTS??'["Add my usual coffee to the cart.","Make it 3 actually."]');
try{
 for(const [index,prompt]of prompts.entries()){
  const turn=index+1,messages=[];console.log(JSON.stringify({turn,prompt}));
  child.stdin.write(JSON.stringify({id:`prompt-${turn}`,type:'prompt',message:prompt})+'\n');
  while(true){const next=await events.next();if(next.done)throw Error('Pi exited before agent_settled. Inspect the private transcript and current cart.');const event=next.value;
   fs.writeSync(transcript,JSON.stringify({turn,...event})+'\n');
   if(event.type==='response'&&!event.success)throw Error(`Pi command failed: ${event.error}`);
   if(event.type==='tool_execution_start')console.log(JSON.stringify({turn,tool:event.toolName,args:event.args}));
   if(event.type==='message_end')messages.push(event.message);
   if(event.type==='agent_settled')break;
  }
  const actual=await cart();save(`cart-${turn}.json`,actual);
  const attempted=messages.filter(m=>m.role==='assistant').flatMap(m=>(m.content??[]).filter(c=>c.type==='toolCall').map(c=>({name:c.name,args:c.arguments})));
  const final=messages.filter(m=>m.role==='assistant').flatMap(m=>(m.content??[]).filter(c=>c.type==='text').map(c=>c.text)).join('\n');
  const result={turn,prompt,attempted,quantity:cartRows(actual).reduce((n,row)=>n+row.quantity,0),final};
  turns.push({...result,messages});console.log(JSON.stringify(result));save('turns.json',turns);
 }
}finally{clearTimeout(deadline);fs.closeSync(transcript);child.stdin.end();setTimeout(()=>child.kill('SIGTERM'),10_000).unref();}
