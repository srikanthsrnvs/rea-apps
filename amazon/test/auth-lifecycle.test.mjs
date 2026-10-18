import test, { beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amazon-auth-lifecycle-'));
process.env.AMAZON_CLI_STATE_DIR = directory;
const auth = await import('../src/auth.mjs');
const state = await import('../src/state.mjs');
const originalFetch = globalThis.fetch, originalRename = fs.rename, originalRm = fs.rm;
let calls;
const profile = { appName: 'com.amazon.mShop.android.shopping', appVersion: '1243240206', deviceType: 'A1MPSLFC7L5AFK', deviceSerial: 'a'.repeat(32), deviceModel: 'Linux aarch64', osVersion: '6.1' };
const oldSession = () => ({ customerId: 'old-customer', customer: { name: 'Old Account' }, profile, accessToken: 'old-access', refreshToken: 'old-refresh', secureSessionToken: 'old-sst', cookies: [{ name: 'session-id', value: 'old-cookie', domain: 'amazon.com', path: '/' }] });
const pairResponse = () => ({ public_code: 'ABCDEF', private_code: 'private-code', secureSessionToken: 'pair-sst', expires_in: 600, polling_interval_in_seconds: 3 });
const nativeCookie = (name, value) => ({ Name: name, Value: value, Domain: '.amazon.com', Path: '/', Secure: true, HttpOnly: true });
const registration = () => ({ response: { success: { customer_id: 'new-customer', tokens: { bearer: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }, website_cookies: [nativeCookie('session-id', 'new-session')] }, extensions: { customer_info: { name: 'New Account' }, device_info: {} }, secureSessionToken: 'registration-sst' } } });
const refreshResponse = () => ({ token_type: 'bearer', access_token: 'validated-access', refresh_token: 'validated-refresh', secureSessionToken: 'validated-sst', expires_in: 3600 });
const cookiesResponse = () => ({ secureSessionToken: 'cookie-sst', response: { tokens: { ttl: 3600, cookies: { '.amazon.com': [nativeCookie('session-id', 'new-session'), nativeCookie('session-token', 'native-cookie-token')] } } } });
function responses(...values) {
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (!values.length) throw Error('Unexpected network call');
    const next = values.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.payload ?? next), { status: next.httpStatus ?? 200, headers: { 'content-type': 'application/json' } });
  };
}
async function approvedPending() {
  responses(pairResponse());
  return auth.login({ replace: true });
}
function crashAfterLoginStage(stage) {
  let armed = true;
  fs.rename = async (source, destination) => {
    const inject = armed && path.basename(destination) === 'pending-login.json' && JSON.parse(await fs.readFile(source, 'utf8')).phase === stage;
    await originalRename(source, destination);
    if (inject) { armed = false; throw Error('Simulated crash after durable journal write'); }
  };
}
beforeEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { mode: 0o700 });
  calls = [];
  fs.rename = originalRename;
  responses();
});
afterEach(() => { globalThis.fetch = originalFetch; fs.rename = originalRename; fs.rm = originalRm; });
after(async () => { await fs.rm(directory, { recursive: true, force: true }); });

test('login reuses its pending code and generates an independent native-valid serial', async () => {
  const first = await approvedPending();
  const second = await auth.login({ replace: true });
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  const pending = await state.readState('pending-login');
  assert.match(pending.profile.deviceSerial, /^[0-9a-f]{32}$/);
  assert.equal(pending.profile.deviceModel.startsWith(os.type()), true);
  const publicResult = JSON.stringify(await auth.authStatus());
  assert.equal(publicResult.includes('private-code'), false);
  assert.equal(publicResult.includes('pair-sst'), false);
});

test('fresh login validates new credentials and renews shopping cookies before replacing the old account', async () => {
  await state.saveState('session', oldSession());
  const pending = await approvedPending();
  responses(registration(), refreshResponse(), cookiesResponse());
  const result = await auth.completeLogin({ loginId: pending.loginId });
  assert.equal(result.account.name, 'New Account');
  assert.equal(result.shoppingCookieCount, 2);
  const session = await state.readState('session');
  assert.equal(session.accessToken, 'validated-access');
  assert.equal(session.refreshToken, 'validated-refresh');
  assert.equal(session.secureSessionToken, 'cookie-sst');
  assert.equal(session.cookies.some(c => c.name === 'session-token'), true);
  const cookieRequest = calls.at(-1).options;
  assert.equal(cookieRequest.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(new URLSearchParams(cookieRequest.body).get('source_token'), 'validated-refresh');
  assert.equal(cookieRequest.headers.cookie.includes('new-session'), true);
  assert.equal(JSON.stringify(result).includes('validated-refresh'), false);
  assert.equal(await state.readState('pending-login'), null);
});

for (const [stage, remaining] of [['registration_received', 2], ['validation_received', 1], ['cookies_received', 0], ['commit_pending', 0]]) {
  test(`a crash after ${stage} resumes the saved result without repeating completed requests`, async () => {
    await state.saveState('session', oldSession());
    const pending = await approvedPending();
    responses(registration(), refreshResponse(), cookiesResponse());
    crashAfterLoginStage(stage);
    await assert.rejects(auth.completeLogin({ loginId: pending.loginId }), /Simulated crash/);
    assert.equal((await state.readState('session')).customerId, 'old-customer');
    fs.rename = originalRename;
    calls = [];
    responses(...(stage === 'registration_received' ? [refreshResponse(), cookiesResponse()] : stage === 'validation_received' ? [cookiesResponse()] : []));
    const result = await auth.completeLogin({ loginId: pending.loginId });
    assert.equal(result.status, 'authenticated');
    assert.equal(calls.length, remaining);
    assert.equal(calls.some(c => c.url.endsWith('/auth/register')), false);
  });
}

test('an uncertain cookie renewal preserves the old account and is never replayed', async () => {
  await state.saveState('session', oldSession());
  const pending = await approvedPending();
  responses(registration(), refreshResponse(), new Error('Connection lost'));
  await assert.rejects(auth.completeLogin({ loginId: pending.loginId }), { code: 'NETWORK_ERROR' });
  assert.equal((await state.readState('session')).refreshToken, 'old-refresh');
  assert.equal((await state.readState('pending-login')).phase, 'cookies_pending');
  const count = calls.length;
  await assert.rejects(auth.completeLogin({ loginId: pending.loginId }), { code: 'LOGIN_OUTCOME_UNKNOWN' });
  assert.equal(calls.length, count);
});

test('a success-shaped body with a failing HTTP status cannot replace an account', async () => {
  await state.saveState('session', oldSession());
  const pending = await approvedPending();
  responses({ httpStatus: 500, payload: registration() });
  await assert.rejects(auth.completeLogin({ loginId: pending.loginId }), { code: 'REGISTRATION_REJECTED' });
  assert.equal((await state.readState('session')).customerId, 'old-customer');
  assert.equal(calls.filter(c => c.url.endsWith('/auth/token')).length, 0);
});

test('a known login result cannot overwrite an account changed since pairing began', async () => {
  await state.saveState('session', oldSession());
  const pending = await approvedPending();
  await state.saveState('session', { ...oldSession(), customerId: 'different-account', profile: { ...profile, deviceSerial: 'b'.repeat(32) } });
  const count = calls.length;
  await assert.rejects(auth.completeLogin({ loginId: pending.loginId }), { code: 'SESSION_CHANGED' });
  assert.equal((await state.readState('session')).customerId, 'different-account');
  assert.equal(calls.length, count);
});

test('standalone token rotation journals uncertainty and recovers a subsequently retained known response locally', async () => {
  await state.saveState('session', oldSession());
  responses(new Error('Connection lost'));
  await assert.rejects(auth.refreshLogin(), { code: 'NETWORK_ERROR' });
  const journal = await state.readState('auth-refresh');
  assert.equal(journal.phase, 'submission_pending');
  assert.equal((await state.readState('session')).refreshToken, 'old-refresh');
  await assert.rejects(auth.refreshLogin(), { code: 'AUTH_OUTCOME_UNKNOWN' });
  assert.equal(calls.length, 1);
  await state.saveState('auth-refresh', { ...journal, phase: 'response_received', response: { httpStatus: 200, receivedAt: Date.now(), payload: refreshResponse() } });
  const result = await auth.refreshLogin();
  assert.equal(result.status, 'authenticated');
  assert.equal(calls.length, 1);
  assert.equal((await state.readState('session')).refreshToken, 'validated-refresh');
  assert.equal(await state.readState('auth-refresh'), null);
});

test('standalone refresh recovers a session-write failure without repeating a token request', async () => {
  await state.saveState('session', oldSession());
  responses(refreshResponse());
  let armed = true;
  fs.rename = async (source, destination) => {
    if (armed && path.basename(destination) === 'session.json') { armed = false; throw Error('Simulated session write failure'); }
    return originalRename(source, destination);
  };
  await assert.rejects(auth.refreshLogin(), /Simulated session write failure/);
  assert.equal((await state.readState('auth-refresh')).phase, 'commit_pending');
  fs.rename = originalRename;
  await auth.refreshLogin();
  assert.equal(calls.length, 1);
  assert.equal((await state.readState('session')).accessToken, 'validated-access');
});

test('old refresh journals cannot apply to a changed account or device', async () => {
  await state.saveState('session', oldSession());
  responses(new Error('Connection lost'));
  await assert.rejects(auth.refreshLogin());
  const journal = await state.readState('auth-refresh');
  await state.saveState('auth-refresh', { ...journal, phase: 'response_received', response: { httpStatus: 200, receivedAt: Date.now(), payload: refreshResponse() } });
  await state.saveState('session', { ...oldSession(), customerId: 'different-account' });
  await assert.rejects(auth.refreshLogin(), { code: 'SESSION_CHANGED' });
  assert.equal(calls.length, 1);
  assert.equal((await state.readState('session')).customerId, 'different-account');
});

test('standalone cookie renewal journals rotations and blocks conflicting operations after an unknown result', async () => {
  await state.saveState('session', oldSession());
  responses(new Error('Connection lost'));
  await assert.rejects(auth.refreshShoppingCookies(), { code: 'NETWORK_ERROR' });
  const journal = await state.readState('auth-cookies');
  await assert.rejects(auth.refreshLogin(), { code: 'AUTH_OPERATION_PENDING' });
  await assert.rejects(auth.withClient(async () => 'read'), { code: 'AUTH_OPERATION_PENDING' });
  await state.saveState('auth-cookies', { ...journal, phase: 'response_received', response: { httpStatus: 200, receivedAt: Date.now(), payload: cookiesResponse() } });
  await auth.refreshShoppingCookies();
  assert.equal((await state.readState('session')).secureSessionToken, 'cookie-sst');
  assert.equal(calls.length, 1);
  assert.equal(await state.readState('auth-cookies'), null);
});

test('concurrent refresh commands cannot replay the same uncertain rotation', async () => {
  await state.saveState('session', oldSession());
  globalThis.fetch = async () => { calls.push({}); await new Promise(resolve => setTimeout(resolve, 20)); throw Error('Connection lost'); };
  const outcomes = await Promise.allSettled([auth.refreshLogin(), auth.refreshLogin()]);
  assert.deepEqual(outcomes.map(r => r.reason?.code).sort(), ['AUTH_OUTCOME_UNKNOWN', 'NETWORK_ERROR']);
  assert.equal(calls.length, 1);
  assert.equal((await state.readState('session')).refreshToken, 'old-refresh');
});

test('a committed fresh login recovers cleanup failure without replaying any request', async () => {
  await state.saveState('session', oldSession());
  const pending = await approvedPending();
  responses(registration(), refreshResponse(), cookiesResponse());
  let armed = true;
  fs.rm = async (target, options) => {
    if (armed && path.basename(target) === 'pending-login.json') { armed = false; throw Error('Simulated cleanup failure'); }
    return originalRm(target, options);
  };
  await assert.rejects(auth.completeLogin({ loginId: pending.loginId }), /Simulated cleanup failure/);
  assert.equal((await state.readState('session')).customerId, 'new-customer');
  const count = calls.length;
  fs.rm = originalRm;
  await auth.completeLogin({ loginId: pending.loginId });
  assert.equal(calls.length, count);
  assert.equal(await state.readState('pending-login'), null);
});
