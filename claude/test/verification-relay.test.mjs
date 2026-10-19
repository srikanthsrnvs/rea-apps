import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createVerificationRelay} from '../src/verification-relay.mjs';
const publicKey='a8086506-2036-46f4-ae50-00d8be805efa';
async function setup(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'claude-widget-'));const relay=await createVerificationRelay({directory,publicKey});const port=await relay.listen();t.after(async()=>{await relay.close();await fs.rm(directory,{recursive:true,force:true});});return {relay,directory,base:`http://127.0.0.1:${port}`,headers:{authorization:`Bearer ${relay.key}`,'content-type':'application/json'}};}

test('public shell discloses no capability or login form; configuration requires capability',async t=>{
 const {relay,base,headers}=await setup(t),response=await fetch(base),html=await response.text();
 assert.equal(response.status,200);assert.equal(html.includes(relay.key),false);assert.doesNotMatch(html,/<input|password|vnc/i);
 assert.equal(response.headers.get('referrer-policy'),'no-referrer');
 assert.equal((await fetch(`${base}/config`)).status,401);
 assert.equal((await (await fetch(`${base}/config`,{headers})).json()).publicKey,publicKey);
});
test('only one bounded result is published privately, even when requests race',async t=>{
 const {base,headers,directory}=await setup(t);
 const request=()=>fetch(`${base}/result`,{method:'POST',headers,body:JSON.stringify({token:'test-fixture-not-a-real-provider-token'})});
 const results=await Promise.all([request(),request()]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const file=path.join(directory,'verification-result.json');assert.equal((await fs.stat(file)).mode&0o777,0o600);
 const record=JSON.parse(await fs.readFile(file));assert.equal(record.status,'completed');assert.equal(record.publicKey,publicKey);
 assert.equal((await (await fetch(`${base}/status`,{headers})).json()).token,undefined);
 assert.equal((await request()).status,409);
});
test('unauthenticated or malformed submissions cannot publish proof',async t=>{
 const {base,headers,directory}=await setup(t);
 assert.equal((await fetch(`${base}/result`,{method:'POST',body:'{}'})).status,401);
 assert.equal((await fetch(`${base}/result`,{method:'POST',headers,body:JSON.stringify({token:'short'})})).status,400);
 assert.equal((await fetch(`${base}/result`,{method:'POST',headers,body:JSON.stringify({token:'x'.repeat(25000)})})).status,413);
 await assert.rejects(fs.stat(path.join(directory,'verification-result.json')),{code:'ENOENT'});
});
