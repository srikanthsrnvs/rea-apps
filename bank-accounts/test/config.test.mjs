import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bank-accounts-config-'));
process.env.BANK_ACCOUNTS_STATE_DIR=path.join(directory,'state');
const {configure}=await import('../src/config.mjs');
const {readState,saveState}=await import('../src/state.mjs');
const {privateInput}=await import('../src/private-input.mjs');
after(async()=>fs.rm(directory,{recursive:true,force:true}));
test('Sandbox configuration works without an API secret and stores only verified connector metadata',async()=>{
  const result=await configure({connector:'sample'},{inspect:async()=>({id:'env_test',mode:'SANDBOX'})});
  assert.equal(result.persistentServerAccess,false);assert.equal(result.environment.mode,'SANDBOX');
  assert.equal((await readState('config')).secret,undefined);
  assert.equal((await fs.stat(path.join(directory,'state/config.json'))).mode&0o777,0o600);
});
test('private persistent access rejects a production or mismatched environment key without changing configuration',async()=>{
  for(const environment of [{id:'env_test',mode:'PRODUCTION'},{id:'env_other',mode:'SANDBOX'}]) {
    await assert.rejects(configure({connector:'sample',stdin:true},{inspect:async()=>({id:'env_test',mode:'SANDBOX'}),readSecret:async()=>'synthetic-private-secret',requestImpl:async()=>({environment})}),{code:'SANDBOX_REQUIRED'});
    assert.equal((await readState('config')).secret,undefined);
  }
  const result=await configure({connector:'sample',stdin:true},{inspect:async()=>({id:'env_test',mode:'SANDBOX'}),readSecret:async()=>'synthetic-private-secret',requestImpl:async()=>({environment:{id:'env_test',mode:'SANDBOX'}})});
  assert.equal(result.persistentServerAccess,true);assert.equal(JSON.stringify(result).includes('synthetic-private-secret'),false);
  await saveState('session',{environmentId:'env_test'});
  await assert.rejects(configure({connector:'sample'},{inspect:async()=>({id:'env_other',mode:'SANDBOX'})}),{code:'ENVIRONMENT_CHANGED'});
});
test('secret input accepts private stdin/files and rejects symlinks, readable-by-others files and mixed modes',async()=>{
  const file=path.join(directory,'key'),link=path.join(directory,'key-link');
  await fs.writeFile(file,'synthetic-private-secret\n',{mode:0o600});await fs.symlink(file,link);
  assert.equal(await privateInput({file}),'synthetic-private-secret');
  assert.equal(await privateInput({stdin:true},Readable.from(['synthetic-private-secret\n'])),'synthetic-private-secret');
  await assert.rejects(privateInput({file:link}),{code:'PRIVATE_INPUT_REQUIRED'});
  await fs.chmod(file,0o644);await assert.rejects(privateInput({file}),{code:'PRIVATE_INPUT_REQUIRED'});
  await assert.rejects(privateInput({file,stdin:true}),{code:'PRIVATE_INPUT_REQUIRED'});
});
