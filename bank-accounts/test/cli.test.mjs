import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const bin=new URL('../bin/bank-accounts',import.meta.url).pathname;
test('agent tools are read-only and command parsing refuses literal API keys and unrelated options',()=>{
  const invoke=args=>spawnSync(process.execPath,[bin,...args],{encoding:'utf8'});
  const tools=JSON.parse(invoke(['tools']).stdout).tools;
  assert.ok(tools.every(tool=>tool.name.startsWith('bank_accounts_')));
  assert.ok(tools.some(tool=>tool.command==='balances'));assert.ok(tools.some(tool=>tool.command==='transactions'));
  assert.equal(tools.some(tool=>/payment|transfer|purchase/u.test(tool.command)),false);
  for(const args of [['configure','--connector-id','sample','--api-key','do-not-echo-this'],['balances','--api-key-stdin'],['transactions','--limit','10','--limit','20'],['configure']]) {
    const result=invoke(args);assert.equal(result.status,1);assert.equal(result.stdout,'');assert.doesNotMatch(result.stderr,/do-not-echo-this/);assert.equal(JSON.parse(result.stderr).error.code,'INVALID_ARGUMENT');
  }
});
