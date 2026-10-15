import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const executable = new URL('../bin/linkedin', import.meta.url);
function run(directory, args, input) {
  const child = spawnSync(process.execPath, [executable.pathname, ...args], { encoding: 'utf8', input,
    env: { ...process.env, LINKEDIN_CLI_STATE_DIR: directory } });
  assert.equal(child.stderr, '');
  return { status: child.status, json: JSON.parse(child.stdout) };
}
test('tools and status run without a display, browser dependency or saved credentials', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linkedin-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const result = run(directory, ['tools']);
  assert.equal(result.status, 0);
  assert.ok(result.json.data.tools.some(x => x.name === 'message.send'));
  assert.ok(result.json.data.tools.some(x => x.name === 'connection.send'));
  assert.equal(result.json.data.validation.liveAccount, true);
  assert.equal(result.json.data.validation.liveSend, false);
  assert.equal(result.json.data.validation.liveInvitation, true);
  const status = run(directory, ['auth', 'status']);
  assert.equal(status.json.data.authenticated, false);
  const inbox = run(directory, ['call', 'inbox.list', '--input', '-'], '{}');
  assert.equal(inbox.status, 1);
  assert.equal(inbox.json.error.code, 'AUTH_REQUIRED');
});
test('tool input validation rejects unknown fields and non-explicit send confirmations before network access', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linkedin-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.equal(run(directory, ['call', 'inbox.list', '--json', '{"cookies":"secret"}']).json.error.code, 'INVALID_ARGUMENT');
  assert.equal(run(directory, ['call', 'message.send', '--json', '{"operationId":"id","confirm":false}']).json.error.code, 'INVALID_ARGUMENT');
  assert.equal(run(directory, ['call', 'connection.send', '--json', '{"operationId":"id","confirm":false}']).json.error.code, 'INVALID_ARGUMENT');
  assert.equal(run(directory, ['call', 'people.search', '--json', '[]']).json.error.code, 'INVALID_ARGUMENT');
  assert.equal(run(directory, ['--version']).json.data.version, '0.1.0');
});
