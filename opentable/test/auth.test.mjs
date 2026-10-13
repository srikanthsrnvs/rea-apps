import test from 'node:test';
import assert from 'node:assert/strict';
import { startLogin, completeLogin, refreshLogin, authStatus, cancelLogin, logout, accountFromUser } from '../src/auth.mjs';
import { OpenTableError } from '../src/errors.mjs';
const token = 'synthetic-access-token-123456789', refresh = 'synthetic-refresh-token-123456789';
function setup({ confirm, grant, me } = {}) {
  const records = new Map(), calls = [];
  let clock = 1_800_000_000_000, meFail = false, networkPhase;
  const store = { async readState(name) { return structuredClone(records.get(name) ?? null); },
    async saveState(name, value) { records.set(name, structuredClone(value)); },
    async removeState(name) { records.delete(name); }, async withStateLock(fn) { return fn(); } };
  const deps = { store, now: () => clock,
    anonymous: async options => { calls.push({ name: 'anonymous', options }); return { accessToken: 'synthetic-guest-token-123456789', expiresAt: clock + 3600000 }; },
    client: settings => ({
      async request(endpoint, options) {
        calls.push({ endpoint, options, settings });
        if (networkPhase === endpoint) throw new OpenTableError('NETWORK_ERROR', 'Synthetic offline.');
        if (endpoint === '/api/v1/2fa/start') return { correlationId: 'synthetic-correlation' };
        return confirm ?? { nextStep: 'LOGIN', authorizationCode: 'synthetic-one-use-code' };
      },
      async tokenRequest(form) {
        calls.push({ form, settings });
        if (networkPhase === 'grant') throw new OpenTableError('NETWORK_ERROR', 'Synthetic offline.');
        return grant ?? { access_token: token, refresh_token: refresh, expires_in: 3600, token_type: 'bearer', scope: 'diner' };
      },
      async me() { calls.push({ name: 'me', settings }); if (meFail) throw new OpenTableError('NETWORK_ERROR', 'Synthetic offline.'); return me ?? { globalPersonId: 'synthetic-gpid', diners: [{ id: '12345678901234567890' }], firstName: 'Example' }; },
    }) };
  return { records, calls, deps, advance: value => { clock += value; }, failMe: value => { meFail = value; }, failNetwork: phase => { networkPhase = phase; } };
}

test('phone OTP start, confirm and authorization-code grant use observed native contracts', async () => {
  const env = setup();
  const started = await startLogin({ phone: '+1 (212) 555-0123' }, env.deps);
  assert.equal(started.status, 'waiting');
  assert.equal(started.contact, '+1 ********23');
  const start = env.calls.find(row => row.endpoint);
  assert.deepEqual(start.options, { method: 'POST', json: { phone: { countryCode: '1', countryId: 'US', number: '2125550123' }, target: 'SMS' } });
  assert.equal(env.calls[0].options.sessionId, start.settings.sessionId);
  await startLogin({ phone: '+12125550123' }, env.deps);
  assert.equal(env.calls.filter(row => row.endpoint === '/api/v1/2fa/start').length, 1);
  assert.equal(JSON.stringify(started).includes('correlation'), false);
  const result = await completeLogin({ code: '123456' }, env.deps);
  const confirmation = env.calls.find(row => row.endpoint === '/api/v1/2fa/confirm');
  assert.deepEqual(confirmation.options.json, { phone: { countryCode: '1', countryId: 'US', number: '2125550123' }, code: '123456', correlationId: 'synthetic-correlation', allowPhoneRecycling: false });
  assert.deepEqual(env.calls.find(row => row.form).form, { grant_type: 'authorization_code', client_id: 'ot-apps-passwordless', client_secret: '0pentab1e', code: 'synthetic-one-use-code' });
  assert.equal(result.authenticated, true);
  assert.equal(result.account.dinerId, '12345678901234567890');
  assert.equal(env.records.has('login'), false);
  assert.equal(env.records.has('candidate-session'), false);
  const privateSession = env.records.get('session');
  assert.equal(privateSession.refreshToken, refresh);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(Object.hasOwn(privateSession, 'code'), false);
  assert.equal(Object.hasOwn(privateSession, 'authorizationCode'), false);
});

test('email OTP and contact validation do not invent browser callbacks', async () => {
  const env = setup();
  const result = await startLogin({ email: 'example@example.test' }, env.deps);
  assert.equal(result.contact, 'e***@example.test');
  assert.deepEqual(env.calls.find(row => row.endpoint).options.json, { email: 'example@example.test', target: 'EMAIL' });
  await completeLogin({ code: '012345' }, env.deps);
  assert.equal(env.calls.find(row => row.endpoint === '/api/v1/2fa/confirm').options.json.email, 'example@example.test');
  const other = setup();
  for (const invalid of [{}, { phone: '2125550123', email: 'example@example.test' }, { phone: '+442012345678' }, { email: 'invalid' }, { phone: '2125550123', countryId: 'us' }]) await assert.rejects(startLogin(invalid, other.deps), { code: 'INVALID_ARGUMENT' });
  assert.equal(other.calls.length, 0);
});

test('pending expiry removes contacts and tokens; cancel and logout clear owned secrets', async () => {
  const env = setup();
  await startLogin({ phone: '2125550123' }, env.deps);
  await assert.rejects(startLogin({ email: 'other@example.test' }, env.deps), { code: 'LOGIN_PENDING' });
  env.advance(601000);
  const status = await authStatus(env.deps);
  assert.equal(status.login.status, 'expired');
  const expired = env.records.get('login');
  assert.equal(Object.hasOwn(expired, 'anonymousToken'), false);
  assert.equal(Object.hasOwn(expired, 'contact'), false);
  await cancelLogin(env.deps);
  assert.equal(env.records.has('login'), false);
  await startLogin({ phone: '2125550123' }, env.deps);
  await completeLogin({ code: '123456' }, env.deps);
  await logout(env.deps);
  assert.equal(env.records.size, 0);
});

test('additional account steps never register or recycle a phone', async () => {
  for (const nextStep of ['REGISTRATION', 'CONFIRM_CREDENTIALS', 'CONFIRM_PHONE_RECYCLING', 'FAILURE', 'UNKNOWN']) {
    const env = setup({ confirm: { nextStep, authorizationCode: 'sensitive-code' } });
    await startLogin({ phone: '2125550123' }, env.deps);
    await assert.rejects(completeLogin({ code: '123456' }, env.deps), { code: 'LOGIN_STEP_REQUIRED' });
    assert.equal(env.calls.some(row => row.form), false);
    assert.equal(env.records.has('session'), false);
    assert.equal(JSON.stringify(env.records.get('login')).includes('sensitive-code'), false);
  }
});

test('uncertain confirmation or grant is not replayed and contact secrets are cleared', async () => {
  for (const phase of ['/api/v1/2fa/confirm', 'grant']) {
    const env = setup();
    await startLogin({ phone: '2125550123' }, env.deps);
    env.failNetwork(phase);
    await assert.rejects(completeLogin({ code: '123456' }, env.deps), { code: 'NETWORK_ERROR' });
    const count = env.calls.length;
    await assert.rejects(completeLogin({ code: '123456' }, env.deps), { code: 'LOGIN_UNCERTAIN' });
    assert.equal(env.calls.length, count);
    assert.equal(Object.hasOwn(env.records.get('login'), 'anonymousToken'), false);
    assert.equal(Object.hasOwn(env.records.get('login'), 'contact'), false);
  }
});

test('successful exchanged candidate survives validation failure without replacing prior account', async () => {
  const env = setup();
  const old = { version: 1, accessToken: 'synthetic-old-session-123456789', expiresAt: 1_800_000_100_000, account: { dinerId: 'older' } };
  env.records.set('session', old);
  await startLogin({ phone: '2125550123' }, env.deps);
  env.failMe(true);
  await assert.rejects(completeLogin({ code: '123456' }, env.deps), { code: 'LOGIN_VALIDATION_PENDING' });
  assert.deepEqual(env.records.get('session'), old);
  assert.equal(env.records.get('candidate-session').accessToken, token);
  assert.equal((await authStatus(env.deps)).validationPending, true);
  env.failMe(false);
  const before = env.calls.filter(row => row.form).length;
  assert.equal((await refreshLogin(env.deps)).authenticated, true);
  assert.equal(env.calls.filter(row => row.form).length, before);
  assert.equal(env.records.has('candidate-session'), false);
});

test('refresh rotates and persists tokens before validation; uncertain refresh is not replayed', async () => {
  const env = setup();
  await startLogin({ phone: '2125550123' }, env.deps);
  await completeLogin({ code: '123456' }, env.deps);
  env.failMe(true);
  await assert.rejects(refreshLogin(env.deps), { code: 'NETWORK_ERROR' });
  const form = env.calls.filter(row => row.form).at(-1).form;
  assert.deepEqual(form, { grant_type: 'refresh_token', client_id: 'ot-apps-passwordless', client_secret: '0pentab1e', refresh_token: refresh });
  assert.equal(env.records.get('candidate-session').refreshToken, refresh);
  env.failMe(false);
  await refreshLogin(env.deps);
  env.failNetwork('grant');
  await assert.rejects(refreshLogin(env.deps), { code: 'NETWORK_ERROR' });
  const before = env.calls.length;
  await assert.rejects(refreshLogin(env.deps), { code: 'REFRESH_UNCERTAIN' });
  assert.equal(env.calls.length, before);
});

test('auth status hides token/correlation and does not report expired sessions as authenticated', async () => {
  const env = setup();
  await startLogin({ phone: '2125550123' }, env.deps);
  const status = await authStatus(env.deps);
  const encoded = JSON.stringify(status);
  assert.equal(encoded.includes('guest-token'), false);
  assert.equal(encoded.includes('synthetic-correlation'), false);
  assert.equal(encoded.includes('2125550123'), false);
  await completeLogin({ code: '123456' }, env.deps);
  env.advance(3_601_000);
  assert.equal((await authStatus(env.deps)).authenticated, false);
});

test('real HTTP client sends OTP JSON and token forms only to native first-party API', async () => {
  const env = setup();
  const wire = [];
  const fetchImpl = async (url, request) => {
    wire.push({ url: new URL(url), request });
    assert.equal(new URL(url).origin, 'https://mobile-api.opentable.com');
    assert.equal(request.redirect, 'manual');
    const path = new URL(url).pathname;
    let body;
    if (path === '/oauth/consumer/token') {
      assert.equal(request.headers.authorization, undefined);
      assert.match(request.headers['content-type'], /^application\/x-www-form-urlencoded/);
      const form = new URLSearchParams(request.body);
      body = form.get('grant_type') === 'implicit'
        ? { access_token: 'synthetic-anonymous-access-123456789', expires_in: 3600, token_type: 'bearer' }
        : { access_token: token, refresh_token: refresh, expires_in: 3600, token_type: 'bearer' };
    } else {
      assert.match(request.headers.authorization, /^bearer synthetic-/);
      if (path === '/api/v1/2fa/start') body = { correlationId: 'synthetic-correlation' };
      else if (path === '/api/v1/2fa/confirm') body = { nextStep: 'LOGIN', authorizationCode: 'synthetic-authorization' };
      else body = { globalPersonId: 'synthetic-gpid', diners: [{ id: 'synthetic-diner' }] };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const options = { store: env.deps.store, now: env.deps.now, fetchImpl };
  await startLogin({ email: 'example@example.test' }, options);
  const result = await completeLogin({ code: '123456' }, options);
  assert.equal(result.account.gpid, 'synthetic-gpid');
  assert.deepEqual(wire.map(row => row.url.pathname), ['/oauth/consumer/token', '/api/v1/2fa/start', '/api/v1/2fa/confirm', '/oauth/consumer/token', '/api/v3/user']);
  assert.equal(wire[3].request.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(wire[2].request.body), { email: 'example@example.test', code: '123456', correlationId: 'synthetic-correlation', allowPhoneRecycling: false });
});

test('user identity comes from globalPersonId and does not guess among multiple diners', async () => {
  assert.deepEqual(accountFromUser({ global: true, globalPersonId: 'global-account', customerId: 'not-a-diner-id' }), { gpid: 'global-account', dinerId: null, dinerIds: [] });
  const env = setup({ me: { globalPersonId: 'synthetic-gpid', diners: [{ id: 'diner-a' }, { id: 'diner-b' }] } });
  await startLogin({ phone: '2125550123' }, env.deps);
  const result = await completeLogin({ code: '123456' }, env.deps);
  assert.deepEqual(result.account, { gpid: 'synthetic-gpid', dinerId: null, dinerIds: ['diner-a', 'diner-b'] });
  const invalid = setup({ me: { id: 'generic-id', dinerId: 'guessed-diner', gpid: 'wrong-wire-key' } });
  await startLogin({ phone: '2125550123' }, invalid.deps);
  await assert.rejects(completeLogin({ code: '123456' }, invalid.deps), { code: 'LOGIN_VALIDATION_PENDING' });
  assert.equal(invalid.records.has('session'), false);
});

test('refresh preserves an independent pending OTP and cancel preserves exchanged refresh recovery', async () => {
  const env = setup();
  await startLogin({ phone: '2125550123' }, env.deps);
  await completeLogin({ code: '123456' }, env.deps);
  await startLogin({ email: 'other@example.test' }, env.deps);
  const pending = env.records.get('login');
  await refreshLogin(env.deps);
  assert.deepEqual(env.records.get('login'), pending);
  env.failMe(true);
  await assert.rejects(refreshLogin(env.deps), { code: 'NETWORK_ERROR' });
  assert.equal(env.records.has('candidate-session'), true);
  assert.equal((await cancelLogin(env.deps)).validationPending, true);
  assert.equal(env.records.has('login'), false);
  assert.equal(env.records.has('candidate-session'), true);
  env.failMe(false);
  const grants = env.calls.filter(row => row.form).length;
  await refreshLogin(env.deps);
  assert.equal(env.calls.filter(row => row.form).length, grants);
});

test('refresh never replaces the active account with a mismatched profile', async () => {
  const env = setup();
  env.records.set('session', { version: 1, accessToken: token, refreshToken: refresh, expiresAt: 1_800_000_100_000, account: { gpid: 'expected-account', dinerId: null } });
  await assert.rejects(refreshLogin(env.deps), { code: 'SESSION_ACCOUNT_MISMATCH' });
  assert.equal(env.records.get('session').account.gpid, 'expected-account');
  assert.equal(env.records.has('candidate-session'), true);
});
