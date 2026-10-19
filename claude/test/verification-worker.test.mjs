import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createProfile} from '../src/client-profile.mjs';

test('detached worker commits a validated login and closes its own tunnel after the widget callback',async t=>{
 const state=await fs.mkdtemp(path.join(os.tmpdir(),'claude-worker-')),loginId=randomUUID(),directory=path.join(state,`verification-${loginId}`);
 await fs.mkdir(directory,{mode:0o700});
 const account={uuid:randomUUID(),email_address:'fixture@example.invalid',memberships:[]};
 const tunnel=path.join(state,'tunnel.mjs');
 await fs.writeFile(tunnel,`#!${process.execPath}\nprocess.stderr.write('https://unit-fixture.trycloudflare.com\\n');setInterval(()=>{},1000);`,{mode:0o700});
 const preload=path.join(state,'mock-http.mjs');
 await fs.writeFile(preload,`const account=${JSON.stringify(account)};let exchanges=0;globalThis.fetch=async(url,options)=>{if(new URL(url).origin!=='https://claude.ai')throw Error('No external network allowed');if(new URL(url).pathname==='/api/auth/verify_magic_link'){if(++exchanges>1)throw Error('Verification replay');const body=JSON.parse(options.body);if(!body.client_attestation?.hcaptcha_token||body.play_integrity_token!==undefined)throw Error('Wrong proof protocol');return new Response(JSON.stringify({success:true,account}),{headers:{'set-cookie':'sessionKey=unit-fixture-only; Path=/; Secure; HttpOnly'}});}if(new URL(url).pathname==='/api/account')return new Response(JSON.stringify(account));throw Error('Unexpected API path');};`);
 await fs.writeFile(path.join(directory,'verification-config.json'),JSON.stringify({publicKey:'a8086506-2036-46f4-ae50-00d8be805efa',loginId,cloudflared:tunnel,ttlMs:60000}),{mode:0o600});
 const worker=fileURLToPath(new URL('../src/verification-worker.mjs',import.meta.url));
 const child=spawn(process.execPath,['--import',preload,worker,directory],{env:{...process.env,CLAUDE_CHAT_STATE_DIR:state},stdio:'ignore'});
 const exited=new Promise(resolve=>child.once('exit',resolve));
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,delay(3000)]);}await fs.rm(state,{recursive:true,force:true});});
 const read=async name=>{try{return JSON.parse(await fs.readFile(path.join(directory,name)));}catch{return null;}};
 let host;
 for(let i=0;i<100;i++){host=await read('verification-host.json');if(host?.port&&await read('verification-url.json'))break;await delay(50);}
 assert.ok(host?.port);
 const pending={id:loginId,email:account.email_address,profile:createProfile(),previousBinding:null,phase:'verification_waiting',delivery:{cookies:[]},verificationInput:{code:'123456'},browserVerification:{directory,id:host.id,expiresAt:host.expiresAt}};
 await fs.writeFile(path.join(state,'pending-login.json'),JSON.stringify(pending),{mode:0o600});
 const response=await fetch(`http://127.0.0.1:${host.port}/result`,{method:'POST',headers:{authorization:`Bearer ${host.key}`,'content-type':'application/json'},body:JSON.stringify({token:'unit-fixture-not-a-real-provider-proof'})});assert.equal(response.status,200);
 let timeout;try{await Promise.race([exited,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Worker did not finish')),10000);})]);}finally{clearTimeout(timeout);}
 assert.equal(child.exitCode,0);
 const session=JSON.parse(await fs.readFile(path.join(state,'session.json')));assert.equal(session.account.uuid,account.uuid);assert.equal(session.generation,loginId);
 await assert.rejects(fs.stat(directory),{code:'ENOENT'});
 await assert.rejects(fs.stat(path.join(state,'pending-login.json')),{code:'ENOENT'});
});
