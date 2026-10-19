import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'claude-auth-'));
process.env.CLAUDE_CHAT_STATE_DIR=directory;
const {readState,saveState}=await import('../src/state.mjs');
const {login,completeLogin,sessionBinding}=await import('../src/auth.mjs');
const {createProfile}=await import('../src/client-profile.mjs');
const originalFetch=globalThis.fetch;
const account={uuid:randomUUID(),email_address:'test@example.invalid',memberships:[{organization:{uuid:randomUUID()}}]};
test.beforeEach(async()=>{for(const file of await fs.readdir(directory))await fs.rm(path.join(directory,file),{recursive:true,force:true});});
test.afterEach(()=>{globalThis.fetch=originalFetch;});
test.after(async()=>fs.rm(directory,{recursive:true,force:true}));
const response=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
async function stageBrowserProof(){
 const pending=await readState('pending-login'),id=randomUUID(),proofDirectory=path.join(directory,`verification-${pending.id}`);
 await fs.mkdir(proofDirectory,{mode:0o700});
 await fs.writeFile(path.join(proofDirectory,'verification-result.json'),JSON.stringify({id,status:'completed',token:'unit-test-fixture-not-a-real-provider-proof',publicKey:'a8086506-2036-46f4-ae50-00d8be805efa',receivedAt:new Date().toISOString()}),{mode:0o600});
 pending.browserVerification={directory:proofDirectory,id,expiresAt:Date.now()+60000};pending.phase='verification_waiting';pending.verificationInput={code:'123456'};await saveState('pending-login',pending);
}

test('a refused native verification preserves the saved account and is never replayed',async()=>{
 const old={profile:createProfile(),account,generation:randomUUID(),cookies:[]};await saveState('session',old);
 let posts=0;
 globalThis.fetch=async(url)=>{posts++;return String(url).endsWith('send_magic_link')?response({sent:true,fallback_code_configuration:{length:6,charset:'numeric'}}):response({error:{details:{error_code:'missing_client_attestation'}}},400);};
 const pending=await login({email:account.email_address,replace:true});
 await stageBrowserProof();
 await assert.rejects(completeLogin({loginId:pending.loginId,code:'123456'}),{code:'LOGIN_VERIFICATION_REJECTED'});
 await assert.rejects(completeLogin({loginId:pending.loginId,code:'123456'}),{code:'LOGIN_VERIFICATION_REJECTED'});
 assert.equal(posts,2);assert.deepEqual(await readState('session'),old);
});

test('a lost native verification response remains uncertain rather than resending a credential',async()=>{
 let calls=0;
 globalThis.fetch=async()=>{if(++calls===1)return response({sent:true});throw Error('Connection lost after upload');};
 const pending=await login({email:account.email_address});
 await stageBrowserProof();
 await assert.rejects(completeLogin({loginId:pending.loginId,code:'123456'}),{code:'NETWORK_ERROR'});
 await assert.rejects(completeLogin({loginId:pending.loginId,code:'123456'}),{code:'LOGIN_OUTCOME_UNKNOWN'});
 assert.equal(calls,2);assert.equal(await readState('session'),null);
});

test('genuine-widget completion submits the source web proof, then validates through native account headers',async()=>{
 const calls=[];
 globalThis.fetch=async(url,options)=>{
  calls.push({url:String(url),...options});
  if(String(url).endsWith('send_magic_link'))return response({sent:true});
  if(String(url).endsWith('verify_magic_link'))return response({success:true,account},200,{'set-cookie':'sessionKey=unit-test-session; Path=/; Secure; HttpOnly'});
  return response(account);
 };
 const pending=await login({email:account.email_address});await stageBrowserProof();
 const result=await completeLogin({loginId:pending.loginId});assert.equal(result.status,'authenticated');
 assert.equal(calls.length,3);
 const sent=JSON.parse(calls[1].body);assert.equal(sent.play_integrity_token,undefined);assert.equal(sent.recaptcha_token,undefined);assert.ok(sent.client_attestation.hcaptcha_token);
 assert.equal(calls[1].headers['Anthropic-Client-Platform'],'web_claude_ai');assert.equal(calls[2].headers['Anthropic-Client-Platform'],'android');
 assert.ok(calls[2].headers.cookie.includes('sessionKey='));assert.equal((await readState('session')).account.uuid,account.uuid);
});

test('a known independently validated native result can finish a local commit without network replay',async()=>{
 const profile=createProfile(),id=randomUUID(),session={profile,account,cookies:[],generation:id,validatedAt:new Date().toISOString()};
 await saveState('pending-login',{id,email:account.email_address,profile,previousBinding:null,committedBinding:sessionBinding(session),phase:'commit_pending',completedSession:session});
 globalThis.fetch=async()=>{throw Error('No network allowed during local commit recovery');};
 const result=await completeLogin({loginId:id});assert.equal(result.status,'authenticated');assert.deepEqual(await readState('session'),session);assert.equal(await readState('pending-login'),null);
});

test('a lost validation GET can resume without replaying the successful proof or replacing old state early',async()=>{
 const old={profile:createProfile(),account,generation:randomUUID(),cookies:[]};await saveState('session',old);
 let verifies=0,reads=0;
 globalThis.fetch=async url=>{
  if(String(url).endsWith('send_magic_link'))return response({sent:true});
  if(String(url).endsWith('verify_magic_link')){verifies++;return response({success:true,account},200,{'set-cookie':'sessionKey=fixture-session; Path=/; Secure'});}
  if(++reads===1)throw Error('Lost read-only response');return response(account);
 };
 const pending=await login({email:account.email_address,replace:true});await stageBrowserProof();
 await assert.rejects(completeLogin({loginId:pending.loginId}),{code:'NETWORK_ERROR'});assert.deepEqual(await readState('session'),old);
 assert.equal((await completeLogin({loginId:pending.loginId})).status,'authenticated');assert.equal(verifies,1);assert.equal(reads,2);
});
