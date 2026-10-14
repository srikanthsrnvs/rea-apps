import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const moduleURL=new URL('../src/state.mjs',import.meta.url).href;
async function run(code,directory){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,EREWHON_CLI_STATE_DIR:directory,EREWHON_CLI_KERNEL_LOCK:''},stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
  child.on('error',reject);child.on('close',status=>status===0?resolve(output):reject(Error(`Child exited ${status}: ${errors}`)));
 });
}
async function temp(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'erewhon-state-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}

test('atomic state writes enforce private directory/file modes and reject path traversal',async t=>{
 const directory=await temp(t);
 const code=`import * as s from ${JSON.stringify(moduleURL)}; await s.saveState('session',{token:'synthetic-private'}); for(const name of ['../session','a/b','']){try{await s.saveState(name,{});throw Error('accepted invalid name');}catch(e){if(!(e instanceof TypeError))throw e;}}`;
 await run(code,directory);assert.equal((await fs.stat(directory)).mode&0o777,0o700);assert.equal((await fs.stat(path.join(directory,'session.json'))).mode&0o777,0o600);
 assert.equal(JSON.parse(await fs.readFile(path.join(directory,'session.json'),'utf8')).token,'synthetic-private');
 assert.deepEqual((await fs.readdir(directory)).filter(x=>x.endsWith('.tmp')),[]);
});

test('multiple processes cannot lose updates while sharing the same state mutex',async t=>{
 const directory=await temp(t);await run(`import * as s from ${JSON.stringify(moduleURL)};await s.saveState('counter',{value:0});`,directory);
 const code=`import * as s from ${JSON.stringify(moduleURL)};import{setTimeout as delay}from'node:timers/promises';for(let i=0;i<10;i++)await s.withStateLock(async()=>{const c=await s.readState('counter');await delay(1);await s.saveState('counter',{value:c.value+1});});`;
 await Promise.all(Array.from({length:4},()=>run(code,directory)));
 assert.equal(JSON.parse(await fs.readFile(path.join(directory,'counter.json'),'utf8')).value,40);
 assert.deepEqual((await fs.readdir(path.join(directory,'.state-lock'))).filter(x=>x.endsWith('.json')),[]);
});

test('a process crash leaves a recoverable lock participant rather than blocking future commands',async t=>{
 const directory=await temp(t);
 await run(`import * as s from ${JSON.stringify(moduleURL)};await s.withStateLock(async()=>process.exit(0));`,directory);
 assert.equal((await fs.readdir(path.join(directory,'.state-lock'))).filter(x=>x.endsWith('.json')).length,1);
 await run(`import * as s from ${JSON.stringify(moduleURL)};await s.withStateLock(async()=>s.saveState('recovered',{success:true}));`,directory);
 assert.equal(JSON.parse(await fs.readFile(path.join(directory,'recovered.json'),'utf8')).success,true);
 assert.deepEqual((await fs.readdir(path.join(directory,'.state-lock'))).filter(x=>x.endsWith('.json')),[]);
});

test('lock failures release their participant and a live owner causes a bounded timeout',async t=>{
 const directory=await temp(t);
 const code=`import * as s from ${JSON.stringify(moduleURL)};try{await s.withStateLock(async()=>{throw Error('expected');});}catch(e){if(e.message!=='expected')throw e;}await s.withStateLock(async()=>{try{await s.withStateLock(()=>{}, {timeoutMs:50,pollIntervalMs:5});throw Error('missing timeout');}catch(e){if(e.code!=='EREWHON_STATE_LOCK_TIMEOUT')throw e;}});`;
 await run(code,directory);assert.deepEqual((await fs.readdir(path.join(directory,'.state-lock'))).filter(x=>x.endsWith('.json')),[]);
});
