import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const state=await fs.mkdtemp(path.join(os.tmpdir(),'claude-verification-client-'));
process.env.CLAUDE_CHAT_STATE_DIR=state;
const {startBrowserVerification,browserVerificationStatus}=await import('../src/verification-client.mjs');
const {saveState,readState}=await import('../src/state.mjs');
const {cancelLogin}=await import('../src/auth.mjs');
test.after(async()=>fs.rm(state,{recursive:true,force:true}));
async function fixture(closed=false){
 const loginId=randomUUID(),directory=path.join(state,`verification-${loginId}`),id=randomUUID(),expiresAt=Date.now()+60000;
 await fs.mkdir(directory,{mode:0o700});
 const host={id,pid:2147483647,port:1,key:'unit-fixture-private-capability-1234567890',status:closed?'closed':'ready',expiresAt};
 await fs.writeFile(path.join(directory,'verification-host.json'),JSON.stringify(host),{mode:0o600});
 await fs.writeFile(path.join(directory,'verification-url.json'),JSON.stringify({id,expiresAt,url:'https://unit-fixture.trycloudflare.com/#key=fixture'}),{mode:0o600});
 return {loginId,record:{directory,id,expiresAt},directory};
}
test('a dead relay is reported unavailable and its stale URL is not reused',async()=>{
 const {loginId,record}=await fixture();
 assert.equal((await browserVerificationStatus(record)).status,'unavailable');
 await assert.rejects(startBrowserVerification(loginId,{publicKey:'a8086506-2036-46f4-ae50-00d8be805efa'},'/unused-fixture-executable'),{code:'VERIFICATION_HOST_UNAVAILABLE'});
});
test('cancelling a closed login removes spent proof/config/capability files and preserves the saved account',async()=>{
 const {loginId,record,directory}=await fixture(true),session={fixture:'existing session'};
 await fs.writeFile(path.join(directory,'verification-result.json'),'{}',{mode:0o600});
 await fs.writeFile(path.join(directory,'verification-config.json'),'{}',{mode:0o600});
 await saveState('session',session);await saveState('pending-login',{id:loginId,browserVerification:record});
 assert.equal((await cancelLogin({loginId})).status,'cancelled');
 await assert.rejects(fs.stat(directory),{code:'ENOENT'});assert.equal(await readState('pending-login'),null);assert.deepEqual(await readState('session'),session);
});
