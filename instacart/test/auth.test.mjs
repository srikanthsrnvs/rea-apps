import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AUTH_QUERIES, authStart, authComplete, authStatus } from '../src/auth.mjs';

const now = Date.parse('2026-10-29T20:00:00Z');
const fresh = () => ({ __typename: 'UsersSendVerificationCodeResponse',
  verificationSessionToken: 'private-verification', expiresAt: '2026-10-29T20:10:00Z', nextCodeAt: '2026-10-29T20:01:00Z' });
const config = { authConfiguration: { authConfigurationToken: 'private-config', recapatchaEnterpriseAuthV4NativeKey: 'site-key' } };
function client(results) {
  const calls = [];
  return { calls, async graphql(...args) { calls.push(args); const value = results.shift(); if (value instanceof Error) throw value; return value; } };
}

test('shipped authentication documents preserve native persisted IDs', () => {
  const ids = { IdentityConfig: 'afbbbcd65b0905f94d1fac92bf242524806de58e1094fbb0163963fe9dd76d84',
    SendPhoneNumberVerificationCode: 'ff9da2c87fc18e78363834b0a2ff147336aff46cec877f85e6210c043b4650c5',
    CreateUserSessionFromPhoneNumber: '96396576c9b696042007e0630119392c42ee278d7fcd8f421536683e5f304b58',
    CreateUserSessionFromVerificationCode: 'f0b1cd16d4431b6e31b53c5970aff4c2a68bb4a46099a64c57badb20f735516e' };
  for (const [name, id] of Object.entries(ids)) assert.equal(createHash('sha256').update(AUTH_QUERIES[name]).digest('hex'), id);
});

test('pending SMS is reused and resend waits for server cooldown', async () => {
  const api = client([config, { sendVerificationCode: fresh() }]);
  const state = {};
  const result = await authStart(api, state, { phone: '+14155550123', now });
  assert.equal(result.destination, '+1 ***0123');
  assert.equal(api.calls[1][2].phoneNumber, '4155550123');
  assert.equal(api.calls[1][2].requestType, 'loginRequestInitiated');
  assert.equal(JSON.stringify(result).includes('private-'), false);
  await authStart(api, state, { phone: '+14155550123', now: now + 1000 });
  assert.equal(api.calls.length, 2);
  await assert.rejects(authStart(api, state, { phone: '+14155550123', now: now + 1000, resend: true }), { code: 'AUTH_RESEND_TOO_SOON' });
});

test('verification preserves previous session until read-only validation succeeds', async () => {
  const state = { accessToken: 'old-session' };
  const api = client([config, { sendVerificationCode: fresh() },
    { createUserSessionFromVerificationCode: { __typename: 'UsersAuthToken', token: 'candidate' } }]);
  await authStart(api, state, { email: 'person@example.com', now });
  await assert.rejects(authComplete(api, state, { code: '123456', now, validateSession: async () => { throw new Error('network unavailable'); } }), /network unavailable/);
  assert.equal(state.accessToken, 'old-session');
  assert.equal(authStatus(state).pending.status, 'validation_pending');
  const result = await authComplete(api, state, { now, validateSession: async token => token === 'candidate' });
  assert.equal(api.calls.length, 3);
  assert.equal(state.accessToken, 'candidate');
  assert.equal(state.pendingLogin, undefined);
  assert.equal(result.authenticated, true);
});

test('native identity challenge is reported without inventing a session', async () => {
  const state = {};
  const api = client([config, { sendVerificationCode: { __typename: 'SharedError', errorTypes: ['recaptcha_required'] } }]);
  await assert.rejects(authStart(api, state, { phone: '4155550123', now }), { code: 'AUTH_CHALLENGE_REQUIRED' });
  assert.equal(state.accessToken, undefined);
  assert.equal(state.pendingLogin, undefined);
});

test('accepted OTP may omit nullable verificationSessionToken', async () => {
  const state = {};
  const api = client([config, { sendVerificationCode: { ...fresh(), verificationSessionToken: null } },
    { createUserSessionFromVerificationCode: { __typename: 'UsersAuthToken', token: 'candidate' } }]);
  const result = await authStart(api, state, { phone: '4155550123', now });
  assert.equal(result.status, 'verification_required');
  await authComplete(api, state, { code: '123456', now, validateSession: async () => true });
  assert.equal(Object.hasOwn(api.calls[2][2], 'verificationSessionToken'), false);
  assert.equal(state.accessToken, 'candidate');
});

test('incomplete timing retains private response and repeated start does not send another code', async () => {
  const state = {};
  const api = client([config, { sendVerificationCode: { ...fresh(), expiresAt: null } }]);
  await assert.rejects(authStart(api, state, { phone: '4155550123', now }), { code: 'AUTH_RESPONSE_INVALID' });
  assert.equal(state.pendingLogin.verificationSessionToken, 'private-verification');
  assert.equal(authStatus(state).pending.status, 'verification_session_incomplete');
  await assert.rejects(authStart(api, state, { phone: '4155550123', now }), { code: 'AUTH_RESPONSE_INVALID' });
  assert.equal(api.calls.length, 2);
});
