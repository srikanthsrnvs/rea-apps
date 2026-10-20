import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DEVICE_AUTH_CONFIG } from '../src/device-auth-protocol.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-device-auth-'));
process.env.CHATGPT_STATE_DIR = root;
const { login, pollLogin, authorizedSession } = await import('../src/auth.mjs');
const { readState, saveState, removeState } = await import('../src/state.mjs');
after(() => fs.rm(root, { recursive: true, force: true }));

const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'test-device-key', alg: 'ES256' };

function idToken() {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: key.kid })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: [DEVICE_AUTH_CONFIG.clientId],
    exp: Math.floor(Date.now() / 1000) + 3600, email: 'person@example.test' })).toString('base64url');
  const data = `${header}.${claims}`;
  return `${data}.${sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

async function reset() {
  await removeState('pending-login');
  await removeState('session');
}

function server({ wait = false, lostExchange = false } = {}) {
  const calls = [];
  return { calls, fetcher: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/deviceauth/usercode')) return Response.json({ device_auth_id: 'device-request', user_code: 'ABCD-EFGHI', interval: '5' });
    if (url.endsWith('/deviceauth/token')) {
      if (wait) { wait = false; return Response.json({ error: 'authorization_pending' }, { status: 403 }); }
      return Response.json({ authorization_code: 'test-code', code_verifier: verifier, code_challenge: challenge });
    }
    if (url.endsWith('/oauth/token')) {
      if (lostExchange) throw new Error('response lost');
      return Response.json({ access_token: 'device-access-token', refresh_token: 'device-refresh',
        id_token: idToken(), expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.endsWith('/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json' });
    if (url.endsWith('/jwks.json')) return Response.json({ keys: [key] });
    if (url.endsWith('/me')) return Response.json({ id: 'test-user', email: 'person@example.test', name: 'Person' });
    throw new Error(`Unexpected test endpoint: ${url}`);
  } };
}

test('device login exchanges the approved code with form encoding and verifies the account', async () => {
  await reset();
  const mock = server();
  const started = await login({ email: 'person@example.test', fetcher: mock.fetcher });
  assert.equal(started.method, 'device');
  assert.equal(started.userCode, 'ABCDEFGHI');
  assert.equal(started.approvalUrl, 'https://auth.openai.com/codex/device');
  assert.doesNotMatch(JSON.stringify(started), /deviceAuthId|verifier|privateJwk/);
  const result = await pollLogin({ loginId: started.loginId, fetcher: mock.fetcher });
  assert.equal(result.status, 'authenticated');
  assert.equal(result.validation, 'independent_account_read');
  const exchange = mock.calls.find(call => call.url.endsWith('/oauth/token'));
  assert.equal(exchange.options.headers.get('content-type'), 'application/x-www-form-urlencoded');
  assert.equal(exchange.options.headers.has('dpop'), false);
  assert.equal(new URLSearchParams(exchange.options.body).get('redirect_uri'), DEVICE_AUTH_CONFIG.redirectUri);
  const me = mock.calls.find(call => call.url.endsWith('/me'));
  assert.equal(me.options.headers.get('authorization'), 'Bearer device-access-token');
  const session = await readState('session');
  assert.equal(session.grantEncoding, 'form');
  assert.equal(session.authMethod, 'device');
  assert.equal(session.privateJwk, undefined);
  assert.equal(await readState('pending-login'), null);
  const callCount = mock.calls.length;
  assert.equal((await pollLogin({ loginId: started.loginId, fetcher: mock.fetcher })).status, 'authenticated');
  assert.equal(mock.calls.length, callCount, 'completed login must not repeat its token exchange');
});

test('pending device approval observes the interval before polling again', async () => {
  await reset();
  const mock = server({ wait: true });
  const started = await login({ fetcher: mock.fetcher });
  const waiting = await pollLogin({ loginId: started.loginId, fetcher: mock.fetcher });
  assert.ok(waiting.retryAfterMs > 0);
  const calls = mock.calls.length;
  await pollLogin({ loginId: started.loginId, fetcher: mock.fetcher });
  assert.equal(mock.calls.length, calls);
  const pending = await readState('pending-login');
  pending.nextPollAt = 0;
  await saveState('pending-login', pending);
  assert.equal((await pollLogin({ loginId: started.loginId, fetcher: mock.fetcher })).status, 'authenticated');
});

test('an uncertain device token exchange is never replayed', async () => {
  await reset();
  const mock = server({ lostExchange: true });
  const started = await login({ fetcher: mock.fetcher });
  await assert.rejects(pollLogin({ loginId: started.loginId, fetcher: mock.fetcher }), { code: 'NETWORK_ERROR' });
  await assert.rejects(pollLogin({ loginId: started.loginId, fetcher: mock.fetcher }), { code: 'LOGIN_OUTCOME_UNKNOWN' });
  assert.equal(mock.calls.filter(call => call.url.endsWith('/oauth/token')).length, 1);
});

test('device refresh keeps form encoding and bearer authorization', async () => {
  await reset();
  await saveState('session', { accessToken: 'old', refreshToken: 'refresh', clientId: DEVICE_AUTH_CONFIG.clientId,
    grantEncoding: 'form', authMethod: 'device', deviceId: 'test-device', expiresAt: 0, generation: 'test', account: { id: 'test-user' } });
  let request;
  const session = await authorizedSession({ fetcher: async (url, options) => {
    request = { url, options };
    return Response.json({ access_token: 'new', refresh_token: 'next', token_type: 'Bearer', expires_in: 3600 });
  } });
  assert.equal(session.accessToken, 'new');
  assert.equal(request.options.headers.get('content-type'), 'application/x-www-form-urlencoded');
  assert.equal(request.options.headers.has('dpop'), false);
  assert.equal(new URLSearchParams(request.options.body).get('grant_type'), 'refresh_token');
});
