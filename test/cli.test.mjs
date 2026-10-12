import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const directory = await fs.mkdtemp(path.join(os.tmpdir(),'uber-cli-test-'));
const executable = new URL('../bin/uber',import.meta.url);
function run(...args){return spawnSync(process.execPath,[executable.pathname,...args],{encoding:'utf8',env:{...process.env,UBER_CLI_STATE_DIR:directory}});}
test.after(()=>fs.rm(directory,{recursive:true,force:true}));
test('CLI describes model tools and validates routes without login/network',()=>{
  const tools=run('tools');assert.equal(tools.status,0);assert.ok(JSON.parse(tools.stdout).tools.some(t=>t.name==='quote'));
  const quote=run('quote','--from','37,-122','--to','38,-121','--dry-run');assert.equal(quote.status,0);assert.equal(JSON.parse(quote.stdout).body.request.pickupWaypoint.locationSpec.point.latitude,37);
  const cancel=run('cancel','--trip-id','df00bf9a-d252-42f4-9a7c-4e6aeaf79a3c','--dry-run');assert.equal(cancel.status,0);assert.equal(JSON.parse(cancel.stdout).willCancel,false);
  assert.equal(run('cancel','--trip-id','df00bf9a-d252-42f4-9a7c-4e6aeaf79a3c','--confirm').status,1);
  const book=run('book','--from','37,-122','--to','38,-121','--product','UberX','--dry-run');assert.equal(book.status,0);assert.equal(JSON.parse(book.stdout).willBook,false);
  assert.equal(run('book','--from','37,-122','--to','38,-121','--product','UberX','--confirm').status,1);
  assert.equal(run('book','--from','37,-122','--to','38,-121','--vehicle-view-id','1.2','--dry-run').status,1);
  for(const args of [['quote','--oops'],['quote','--from','99,0','--to','0,0','--dry-run'],['unknown']]){
    const result=run(...args);assert.equal(result.status,1);assert.equal(result.stdout,'');assert.ok(JSON.parse(result.stderr).error.message);assert.ok(!result.stderr.includes('at Module'));
  }
});
test('login prints another-device approval URL and logout deletes local credentials',async()=>{
  const login=run('login');assert.equal(login.status,0);const p=JSON.parse(login.stdout);assert.equal(new URL(p.url).hostname,'auth.uber.com');
  assert.ok(await fs.stat(path.join(directory,'pending-login.json')));
  const logout=run('auth','logout');assert.equal(logout.status,0);assert.deepEqual(JSON.parse(logout.stdout),{loggedOut:true});
  await assert.rejects(fs.stat(path.join(directory,'pending-login.json')),{code:'ENOENT'});
  assert.equal(JSON.parse(run('auth','status').stdout).loggedIn,false);
});
