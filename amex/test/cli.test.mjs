import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const bin = new URL('../bin/amex', import.meta.url);
test('agent schemas and invalid command combinations do not read account state or make requests', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'amex-cli-'));
  try {
    const invoke = args => spawnSync(process.execPath, [bin.pathname, ...args], { encoding: 'utf8', env: { ...process.env, AMEX_STATE_DIR: temporary } });
    const tools = invoke(['tools']); assert.equal(tools.status, 0);
    const schema = JSON.parse(tools.stdout);
    assert.ok(schema.tools.some(item => item.command === 'payment confirm'));
    assert.ok(!schema.tools.some(item => 'password' in item.inputSchema.properties));
    for (const args of [
      ['login', '--password', 'do-not-echo-this'],
      ['accounts', '--credentials-stdin'],
      ['transactions', 'list', '--card', 'a', '--card', 'b'],
      ['payment', 'confirm', '--review-id', 'test'],
      ['auth', 'verify', '--login-id', 'test'],
    ]) {
      const result = invoke(args); assert.equal(result.status, 1);
      assert.equal(result.stdout, ''); assert.doesNotMatch(result.stderr, /do-not-echo-this/);
      assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENT');
    }
    assert.deepEqual(await readdir(temporary), []);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
test('hidden login requires a terminal; private stdin and file modes cannot be combined', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'amex-cli-'));
  try {
    const invoke = args => spawnSync(process.execPath, [bin.pathname, ...args], { encoding: 'utf8', env: { ...process.env, AMEX_STATE_DIR: temporary } });
    const result = invoke(['login', '--prompt']);
    assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_CREDENTIAL_INPUT');
    const mixed = invoke(['login', '--credentials-stdin', '--password-stdin']);
    assert.equal(mixed.status, 1); assert.equal(JSON.parse(mixed.stderr).error.code, 'INVALID_CREDENTIAL_INPUT');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
