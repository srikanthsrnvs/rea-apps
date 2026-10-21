import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'quiltt-auth-'));
process.env.QUILTT_STATE_DIR=temporary;
const {saveState,readState,removeState}=await import('../src/state.mjs');
const auth=await import('../src/auth.mjs');
const originalFetch=globalThis.fetch;
beforeEach(async()=>{
  await removeState('session');await removeState('login');
  await saveState('config',{version:1,connectorId:'sample',environment:{id:'env_test',mode:'SANDBOX'}});
  globalThis.fetch=async()=>new Response('<div id="root" data-connector-id="sample" data-environment-id="env_test" data-environment-mode="SANDBOX"></div>');
});
after(async()=>{globalThis.fetch=originalFetch;await fs.rm(temporary,{recursive:true,force:true});});
test('an expired browser session is reported expired and normal login starts a fresh flow for the same Profile',async()=>{
  await saveState('session',{validated:true,profile:{id:'p_test'},environmentId:'env_test',expiresAt:new Date(Date.now()-1000).toISOString(),token:'synthetic-private-token'});
  const status=await auth.authStatus();assert.equal(status.authenticated,false);assert.equal(status.profileSaved,true);assert.equal(JSON.stringify(status).includes('synthetic-private-token'),false);
  let spawned=0;
  const result=await auth.startLogin({publicUrl:'https://callback.example.test',port:61000},{spawnImpl:()=>{spawned++;return Object.assign(new EventEmitter(),{unref(){}});},pause:async()=>{const flow=await readState('login');await saveState('login',{...flow,status:'waiting',approvalUrl:'https://callback.example.test/private-link'});}});
  assert.equal(result.status,'waiting');assert.equal(spawned,1);assert.equal((await readState('login')).expectedProfileId,'p_test');
});
test('a usable session avoids another browser flow and another bank cannot be linked before first login',async()=>{
  await assert.rejects(auth.startLogin({connect:true}),{code:'AUTH_REQUIRED'});
  await saveState('session',{validated:true,profile:{id:'p_test'},environmentId:'env_test',expiresAt:new Date(Date.now()+60000).toISOString()});
  const result=await auth.startLogin();assert.equal(result.status,'authenticated');assert.equal(await readState('login'),null);
});
test('cancel and logout remove capabilities while retaining Sandbox configuration',async()=>{
  await saveState('login',{loginId:'test',status:'waiting',expiresAt:Date.now()+60000,secret:'synthetic-private-secret',approvalUrl:'https://callback.example.test/private-link'});
  await auth.cancelLogin();assert.equal((await readState('login')).secret,undefined);
  await saveState('session',{validated:true,profile:{id:'p_test'}});await auth.logout();
  assert.equal(await readState('session'),null);assert.equal((await readState('config')).environment.mode,'SANDBOX');
});
