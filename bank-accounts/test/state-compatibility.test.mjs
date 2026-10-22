import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const bin=new URL('../bin/bank-accounts',import.meta.url).pathname;
test('renamed CLI preserves an existing saved login and respects state directory precedence',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bank-accounts-state-'));
  const legacy=path.join(root,'quiltt-cli'),current=path.join(root,'bank-accounts-cli');
  const explicit=path.join(root,'explicit'),legacyExplicit=path.join(root,'legacy-explicit');
  const env={...process.env,XDG_CONFIG_HOME:root};
  delete env.BANK_ACCOUNTS_STATE_DIR;delete env.QUILTT_STATE_DIR;
  const status=(extra={})=>{
    const result=spawnSync(process.execPath,[bin,'auth','status'],{env:{...env,...extra},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  };
  async function save(directory,id){
    await fs.mkdir(directory,{mode:0o700});
    await fs.writeFile(path.join(directory,'config.json'),JSON.stringify({environment:{id:'env_test',mode:'SANDBOX'}}),{mode:0o600});
    await fs.writeFile(path.join(directory,'session.json'),JSON.stringify({validated:true,environmentId:'env_test',profile:{id},expiresAt:new Date(Date.now()+60_000).toISOString()}),{mode:0o600});
  }
  try{
    await save(legacy,'p_legacy');
    assert.equal(status().authenticated,true);assert.equal(status().profile.id,'p_legacy');
    await assert.rejects(fs.stat(current),{code:'ENOENT'});
    await save(current,'p_current');assert.equal(status().profile.id,'p_current');
    await save(legacyExplicit,'p_legacy_explicit');await save(explicit,'p_explicit');
    assert.equal(status({QUILTT_STATE_DIR:legacyExplicit}).profile.id,'p_legacy_explicit');
    assert.equal(status({QUILTT_STATE_DIR:legacyExplicit,BANK_ACCOUNTS_STATE_DIR:explicit}).profile.id,'p_explicit');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
