import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_AUTH_CONFIG, deviceCodeRequest, parseDeviceCodeResponse,
  deviceTokenPollRequest, parseDeviceTokenPollResponse, deviceCodeGrant,
} from '../src/device-auth-protocol.mjs';

// RFC 7636's published S256 example, independent of the implementation.
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

test('device login requests the public Codex client with JSON and no Android proof', () => {
  const request = deviceCodeRequest();
  assert.equal(request.url, 'https://auth.openai.com/api/accounts/deviceauth/usercode');
  assert.equal(request.method, 'POST');
  assert.deepEqual(request.body, { client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.equal(request.headers.DPoP, undefined);
  assert.equal(request.headers.Authorization, undefined);
  assert.equal(DEVICE_AUTH_CONFIG.maxLifetimeMs, 900_000);
  assert.equal(DEVICE_AUTH_CONFIG.verificationUrl, 'https://auth.openai.com/codex/device');
});

test('device response supports both code spellings and string or numeric intervals', () => {
  const expected = { deviceAuthId: 'attempt-fixture', userCode: 'ABCD-EFGH', intervalMs: 7000, verificationUrl: DEVICE_AUTH_CONFIG.verificationUrl };
  assert.deepEqual(parseDeviceCodeResponse({ device_auth_id: 'attempt-fixture', user_code: 'ABCD-EFGH', interval: ' 7 ' }), expected);
  assert.deepEqual(parseDeviceCodeResponse({ device_auth_id: 'attempt-fixture', usercode: 'ABCD-EFGH', interval: 7 }), expected);
  for (const interval of [undefined, 0, '0', 1, '4', 5]) {
    assert.equal(parseDeviceCodeResponse({ device_auth_id: 'attempt-fixture', user_code: 'ABCD-EFGH', interval }).intervalMs, 5000);
  }
});

test('device response rejects missing identifiers and invalid polling schedules', () => {
  for (const interval of [-1, '-1', 1.5, '1.5', '', null, NaN, Infinity, 901, '9007199254740993', true]) {
    assert.throws(() => parseDeviceCodeResponse({ device_auth_id: 'attempt-fixture', user_code: 'ABCD-EFGH', interval }), { code: 'INVALID_DEVICE_AUTH_RESPONSE' });
  }
  for (const value of [null, [], {}, { device_auth_id: 'id' }, { device_auth_id: '', user_code: 'code' }, { device_auth_id: 'id', user_code: 'one', usercode: 'two' }]) {
    assert.throws(() => parseDeviceCodeResponse(value), { code: 'INVALID_DEVICE_AUTH_RESPONSE' });
  }
});

test('poll request preserves the issued code and cannot include invalid identifiers', () => {
  assert.deepEqual(deviceTokenPollRequest({ deviceAuthId: 'attempt-fixture', userCode: 'ABCD-EFGH' }).body, {
    device_auth_id: 'attempt-fixture', user_code: 'ABCD-EFGH',
  });
  assert.equal(deviceTokenPollRequest({ deviceAuthId: 'id', userCode: 'code' }).url, 'https://auth.openai.com/api/accounts/deviceauth/token');
  assert.throws(() => deviceTokenPollRequest({ deviceAuthId: 'id', userCode: 'code\r\nother' }), { code: 'INVALID_DEVICE_AUTH_INPUT' });
  assert.throws(() => deviceTokenPollRequest(), { code: 'INVALID_DEVICE_AUTH_INPUT' });
});

test('successful poll validates the server-issued PKCE pair against an independent vector', () => {
  assert.deepEqual(parseDeviceTokenPollResponse({ authorization_code: 'authorization-fixture', code_verifier: verifier, code_challenge: challenge }), {
    code: 'authorization-fixture', verifier, challenge,
  });
  assert.throws(() => parseDeviceTokenPollResponse({ authorization_code: 'authorization-fixture', code_verifier: verifier, code_challenge: 'a'.repeat(43) }), { code: 'AUTH_PKCE_MISMATCH' });
  assert.throws(() => parseDeviceTokenPollResponse({ authorization_code: 'authorization-fixture', code_verifier: verifier, code_challenge: 'short' }), { code: 'INVALID_DEVICE_AUTH_RESPONSE' });
  assert.throws(() => parseDeviceTokenPollResponse({ authorization_code: 'authorization-fixture', code_verifier: 'short', code_challenge: challenge }), { code: 'INVALID_DEVICE_AUTH_RESPONSE' });
  assert.throws(() => parseDeviceTokenPollResponse({ error: 'authorization_pending' }), { code: 'INVALID_DEVICE_AUTH_RESPONSE' });
});

test('device token grant uses the dedicated HTTPS callback and form-safe fields', () => {
  const grant = deviceCodeGrant({ code: 'authorization-fixture', verifier });
  assert.deepEqual(grant, {
    grant_type: 'authorization_code', client_id: DEVICE_AUTH_CONFIG.clientId,
    code: 'authorization-fixture', code_verifier: verifier,
    redirect_uri: 'https://auth.openai.com/deviceauth/callback',
  });
  assert.equal(DEVICE_AUTH_CONFIG.tokenUrl, 'https://auth.openai.com/oauth/token');
  assert.equal(new URLSearchParams(grant).get('redirect_uri'), DEVICE_AUTH_CONFIG.redirectUri);
  assert.equal(grant.scope, undefined);
  assert.throws(() => deviceCodeGrant({ code: 'authorization-fixture', verifier: 'invalid' }), { code: 'INVALID_DEVICE_AUTH_INPUT' });
});
