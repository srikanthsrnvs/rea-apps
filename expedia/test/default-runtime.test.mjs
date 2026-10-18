import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'expedia-http-default-'));
const guard = path.join(state, 'guard.mjs');
await fs.writeFile(guard, `import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){
 if(/native-login|android-runtime|playwright|puppeteer|selenium|cdp|node:child_process/.test(specifier))throw Error('Rejected runtime import: '+specifier);
 return next(specifier,context);
}});
globalThis.fetch=()=>{throw Error('Unexpected network request');};`);
const environment = { ...process.env, EXPEDIA_CLI_STATE_DIR: state, EXPEDIA_NODE: process.execPath, EXPEDIA_CLOUDFLARED: '/nonexistent-expedia-test-tunnel' };
function cli(...args) {
  return spawnSync(process.execPath, ['--import', guard, path.join(root, 'src/cli.mjs'), ...args], { env: environment, encoding: 'utf8' });
}
test.after(() => fs.rm(state, { recursive: true, force: true }));

test('normal CLI tools and capabilities load without an Android, browser or subprocess module', () => {
  const tools = cli('tools');
  assert.equal(tools.status, 0, tools.stderr);
  const definitions = JSON.parse(tools.stdout).tools;
  assert.equal(definitions.some(tool => tool.command.startsWith('runtime ') || ['auth wait', 'auth verify'].includes(tool.command)), false);
  assert.equal(definitions.some(tool => tool.command === 'auth code'), true);
  assert.deepEqual(Object.keys(definitions.find(tool => tool.command === 'login').inputSchema.properties), ['email', 'replace']);
  const capabilities = cli('capabilities');
  assert.equal(capabilities.status, 0, capabilities.stderr);
  const result = JSON.parse(capabilities.stdout);
  assert.deepEqual(result.runtime, { transport: 'node_http', browser: false, android: false, tunnel: false });
  assert.equal(result.authentication.freshLogin, 'live_verified_linux');
  assert.equal(result.authentication.hostBrowser, false);
  assert.equal(result.purchase.liveVerified, false);
});

test('failed fresh-login preflight preserves credentials and cannot silently return a different account', async () => {
  let response = cli('login', '--email', 'test@example.test');
  assert.equal(response.status, 1);
  assert.ok(['UNSUPPORTED_PLATFORM', 'VERIFICATION_TUNNEL_UNAVAILABLE'].includes(JSON.parse(response.stderr).error.code));
  const session = { profile: { firstName: 'Test', emailAddress: 'test@example.test' }, cookies: [{ name: 'EG_SESSIONTOKEN', value: 'private-test-token' }] };
  const filename = path.join(state, 'session.json');
  await fs.writeFile(filename, JSON.stringify(session), { mode: 0o600 });
  response = cli('login', '--email', 'test@example.test');
  assert.equal(response.status, 0, response.stderr);
  assert.equal(JSON.parse(response.stdout).validation, 'saved_session');
  for (const args of [['login', '--replace'], ['login', '--email', 'different@example.test']]) {
    response = cli(...args);
    assert.equal(response.status, 1);
    assert.ok(['EMAIL_REQUIRED', 'UNSUPPORTED_PLATFORM', 'VERIFICATION_TUNNEL_UNAVAILABLE'].includes(JSON.parse(response.stderr).error.code));
    assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), session);
    assert.equal(response.stderr.includes('private-test-token'), false);
  }
  const status = cli('auth', 'status');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout.includes('private-test-token'), false);
});

test('Linux launcher directly executes the same HTTP CLI', () => {
  const child = spawnSync('/bin/sh', [path.join(root, 'bin/expedia-linux'), 'capabilities'], { env: environment, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).runtime.android, false);
});
