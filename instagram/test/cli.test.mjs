import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const bin = new URL('../bin/instagram', import.meta.url);
test('CLI exposes required and optional model inputs without a login', () => {
  const result = JSON.parse(execFileSync(process.execPath, [bin.pathname, 'tools'], { encoding: 'utf8' }));
  const search = result.tools.find(tool => tool.command === 'search users');
  assert.equal(result.tools.find(tool => tool.command === 'explore').inputSchema.properties.cursor.maxLength, 32768);
  assert.equal(result.tools.some(tool => /thread|send|post|feed/.test(tool.command)), false);
  assert.deepEqual(search.inputSchema.required, ['query']);
  assert.equal(result.authentication.browserApprovalRequired, true);
  assert.equal(result.authentication.browserRequiredOnHost, false);
  assert.equal(result.tools.some(tool => tool.command === 'auth poll'), true);
  assert.equal(result.authentication.startCommand, 'instagram login');
});

test('invalid routes, duplicate and command-incompatible flags fail before network access', () => {
  for (const args of [
    ['profile', '--id', '../accounts/logout'], ['profile', '--id', '123', '--id', '456'],
    ['me', '--browser'], ['search', 'users', '--query', 'x', '--count', '0'],
    ['auth', 'poll', '--timeout', '30'], ['auth', 'wait', '--timeout', '0'],
    ['login', '--browser', '--replace'], ['login', '--browser-path', '/missing'],
  ]) {
    const result = spawnSync(process.execPath, [bin.pathname, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENT');
  }
});

test('local auth status and logout keep credentials out of output and remove the browser profile', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'instagram-cli-test-'));
  const env = { ...process.env, INSTAGRAM_CLI_STATE_DIR: directory };
  try {
    await fs.writeFile(path.join(directory, 'session.json'), JSON.stringify({ cookies: [{
      name: 'sessionid', value: 'fixture-private', expires: -1,
    }] }));
    await fs.mkdir(path.join(directory, 'browser'));
    const status = execFileSync(process.execPath, [bin.pathname, 'auth', 'status'], { env, encoding: 'utf8' });
    assert.equal(status.includes('fixture-private'), false);
    assert.equal(JSON.parse(status).loggedIn, true);
    execFileSync(process.execPath, [bin.pathname, 'auth', 'logout'], { env });
    await assert.rejects(fs.stat(path.join(directory, 'session.json')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(directory, 'browser')), { code: 'ENOENT' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
