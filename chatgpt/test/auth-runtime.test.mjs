import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-auth-test-'));
process.env.CHATGPT_STATE_DIR = root;
const { loginAndroid: login, completeLogin, authorizedSession, accountHeaders } = await import('../src/auth.mjs');
const { readState, saveState, removeState } = await import('../src/state.mjs');
const { createProofKey } = await import('../src/native-crypto.mjs');
const { ChatGptClient } = await import('../src/client.mjs');
after(() => fs.rm(root, { recursive: true, force: true }));

async function reset() {
  await removeState('pending-login');
  await removeState('session');
}
async function callbackFor(started) {
  const pending = await readState('pending-login');
  const url = new URL(pending.redirectUri);
  url.searchParams.set('state', pending.state);
  url.searchParams.set('code', 'test-authorization-code');
  return { loginId: started.loginId, callbackUrl: url.href };
}

test('fresh login keeps keys private and commits only after independent account validation', async () => {
  await reset();
  const started = await login({ email: 'person@example.test' });
  assert.equal(started.status, 'sign_in_required');
  assert.doesNotMatch(JSON.stringify(started), /privateJwk|verifier/);
  assert.equal(new URL(started.approvalUrl).origin, 'https://auth.openai.com');
  const requests = [];
  const result = await completeLogin({ ...await callbackFor(started), fetcher: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'test-token', refresh_token: 'test-refresh', expires_in: 3600, token_type: 'DPoP' });
    return Response.json({ id: 'user-123', email: 'person@example.test', name: 'Person' });
  } });
  assert.equal(result.status, 'authenticated');
  assert.equal(result.validation, 'independent_account_read');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers.get('authorization'), 'DPoP test-token');
  assert.ok(requests[1].options.headers.get('dpop'));
  assert.equal((await readState('session')).account.id, 'user-123');
  assert.equal(await readState('pending-login'), null);
  assert.equal((await fs.stat(path.join(root, 'session.json'))).mode & 0o777, 0o600);
});

test('wrong callback state never reaches the token endpoint', async () => {
  await reset();
  const started = await login({ email: 'person@example.test' });
  const args = await callbackFor(started);
  args.callbackUrl = args.callbackUrl.replace(/state=[^&]+/, 'state=wrong');
  let calls = 0;
  await assert.rejects(completeLogin({ ...args, fetcher: async () => { calls++; } }), { code: 'AUTH_STATE_MISMATCH' });
  assert.equal(calls, 0);
});

test('login replaces an unused link from an older flow without discarding saved credentials', async () => {
  await reset();
  const session = { accessToken: 'saved', expiresAt: 0, generation: 'saved-generation',
    account: { id: 'saved-user', email: 'person@example.test' } };
  await saveState('session', session);
  const old = await login({ email: 'person@example.test' });
  const pending = await readState('pending-login');
  delete pending.flowVersion;
  await saveState('pending-login', pending);
  const updated = await login({ email: 'person@example.test' });
  assert.notEqual(updated.loginId, old.loginId);
  assert.equal(new URL(updated.approvalUrl).searchParams.get('preauth_cookie_failed'), 'other');
  assert.deepEqual(await readState('session'), session);
});

test('an uncertain code exchange is not silently repeated', async () => {
  await reset();
  const started = await login({ email: 'person@example.test' });
  const args = await callbackFor(started);
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('response lost'); };
  await assert.rejects(completeLogin({ ...args, fetcher }), { code: 'NETWORK_ERROR' });
  await assert.rejects(completeLogin({ ...args, fetcher }), { code: 'LOGIN_OUTCOME_UNKNOWN' });
  assert.equal(calls, 1);
});

test('an uncertain rotating-token refresh is journaled before transmission', async () => {
  await reset();
  await saveState('session', { accessToken: 'old', refreshToken: 'old-refresh', privateJwk: createProofKey(),
    deviceId: 'test-device', expiresAt: 0, generation: 'test', account: { id: 'user-123' } });
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('response lost'); };
  await assert.rejects(authorizedSession({ fetcher }), { code: 'NETWORK_ERROR' });
  await assert.rejects(authorizedSession({ fetcher }), { code: 'REFRESH_OUTCOME_UNKNOWN' });
  assert.equal(calls, 1);
});

test('websocket proof signs the HTTPS upgrade target', () => {
  const headers = accountHeaders({ accessToken: 'test', deviceId: 'device', privateJwk: createProofKey() },
    'wss://codex-cloud-backend.chatgpt.com/');
  const claims = JSON.parse(Buffer.from(headers.DPoP.split('.')[1], 'base64url'));
  assert.equal(claims.htu, 'https://codex-cloud-backend.chatgpt.com/');
  assert.equal(headers.authorization, 'DPoP test');
});

test('resolved API URLs cannot leak tokens through whitespace or off-origin paths', async () => {
  let calls = 0;
  const client = new ChatGptClient({ accessToken: 'test', deviceId: 'device' }, { fetcher: async () => { calls++; } });
  for (const path of ['\n//example.test', 'https://example.test', '../me']) {
    await assert.rejects(client.request({ path }), { code: 'INVALID_ENDPOINT' });
  }
  assert.equal(calls, 0);
});
