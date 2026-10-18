import test from 'node:test';
import assert from 'node:assert/strict';
import { AMAZON_AUTH, createCodePairRequest, parseCodePairResponse, registerCodePairRequest, parseRegistrationResponse, refreshTokenRequest, parseRefreshResponse, refreshCookiesRequest, parseCookiesRefreshResponse } from '../src/auth-protocol.mjs';

const profile = { appName: AMAZON_AUTH.appName, appVersion: AMAZON_AUTH.appVersion, deviceType: AMAZON_AUTH.deviceType, deviceSerial: 'a123456789012345678901234567890bc', deviceModel: 'Linux aarch64', osVersion: '6.1.0' };
const pair = { publicCode: 'ABCDEF', privateCode: 'private-pair-secret', secureSessionToken: 'server-issued-sst', expiresIn: 600, pollInterval: 3 };
function registration() {
  return { response: { success: { customer_id: 'own-customer', tokens: { bearer: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: '3600' }, website_cookies: [{ Name: 'session-token', Value: 'new-cookie', Domain: '.amazon.com', Path: '/', Secure: true, HttpOnly: true, Expires: 'Sat, 18 Oct 2036 00:00:00 GMT' }] }, extensions: { customer_info: { name: 'Example Customer', given_name: 'Example' }, device_info: {} }, secureSessionToken: 'rotated-sst' } } };
}
test('pairing and registration preserve one CLI device identity without copied phone signals', () => {
  const create = createCodePairRequest(profile), register = registerCodePairRequest(profile, pair);
  assert.equal(create.url, 'https://api.amazon.com/auth/create/codepair');
  assert.equal(create.body.code_data.device_serial, register.body.registration_data.device_serial);
  assert.equal(create.body.code_data.device_model, 'Linux aarch64');
  assert.equal(register.headers['x-amzn-identity-secure-session-token'], pair.secureSessionToken);
  assert.equal(register.body.auth_data.use_global_authentication, 'true');
  assert.deepEqual(register.body.auth_data.code_pair, { public_code: pair.publicCode, private_code: pair.privateCode });
  assert.equal(register.body.cookies.domain, '.amazon.com');
  assert.equal(register.body.registration_data.software_version, '130050002');
  assert.equal(JSON.stringify(create).includes('private-pair-secret'), false);
});
test('pairing response validates expiration and server polling interval before accepting secrets', () => {
  assert.deepEqual(parseCodePairResponse({ public_code: pair.publicCode, private_code: pair.privateCode, secureSessionToken: pair.secureSessionToken, expires_in: '600', polling_interval_in_seconds: '3' }), pair);
  for (const value of [0, -1, 'NaN', 9999999999]) assert.throws(() => parseCodePairResponse({ public_code: 'A', private_code: 'secret', expires_in: value, polling_interval_in_seconds: 3 }), { code: 'AUTH_PROTOCOL_ERROR' });
});
test('registration parses native response envelope and converts cookies for the HTTP transport', () => {
  const session = parseRegistrationResponse(registration(), { now: 1000 });
  assert.equal(session.customerId, 'own-customer');
  assert.equal(session.expiresAt, 3601000);
  assert.equal(session.secureSessionToken, 'rotated-sst');
  assert.equal(session.cookies[0].domain, 'amazon.com');
  assert.equal(session.cookies[0].httpOnly, true);
  assert.equal(session.customer.givenName, 'Example');
});
test('failure and challenge envelopes cannot become sessions or expose server text', () => {
  const message = 'sensitive request payload';
  assert.throws(() => parseRegistrationResponse({ response: { error: { code: 'Unauthorized', message } } }), e => e.code === 'AUTH_REJECTED' && e.details.serverCode === 'Unauthorized' && !JSON.stringify(e).includes(message));
  assert.throws(() => parseRegistrationResponse({ response: { challenge: { url: 'https://example.invalid' } } }), { code: 'AUTH_CHALLENGE_REQUIRED' });
  const incomplete = registration(); delete incomplete.response.success.tokens.bearer.refresh_token;
  assert.throws(() => parseRegistrationResponse(incomplete), { code: 'AUTH_PROTOCOL_ERROR' });
});
test('untrusted cookie domains and header injection fail closed', () => {
  for (const change of [{ Domain: 'amazon.com.attacker.invalid' }, { Value: 'secret\r\nx: y' }, { Name: 'x; cookie' }]) {
    const input = registration(); Object.assign(input.response.success.tokens.website_cookies[0], change);
    assert.throws(() => parseRegistrationResponse(input), { code: 'AUTH_PROTOCOL_ERROR' });
  }
  assert.throws(() => registerCodePairRequest(profile, { ...pair, secureSessionToken: 'secret\r\nx: y' }), { code: 'AUTH_PROTOCOL_ERROR' });
});
test('native refresh uses new refresh token and merges only server returned rotations', () => {
  const session = parseRegistrationResponse(registration()), req = refreshTokenRequest(profile, session);
  assert.equal(req.url, 'https://api.amazon.com/auth/token');
  assert.equal(req.body.source_token, 'new-refresh');
  assert.equal(req.body.requested_token_type, 'access_token');
  assert.equal(req.body.device_metadata.device_os_family, 'linux');
  assert.equal(req.body.app_version, '130050002');
  assert.deepEqual(parseRefreshResponse({ access_token: 'refreshed-access', token_type: 'bearer', expires_in: 3600 }, { now: 1000 }), { accessToken: 'refreshed-access', expiresIn: 3600, expiresAt: 3601000 });
  assert.throws(() => parseRefreshResponse({ access_token: 'bad', token_type: 'other', expires_in: 3600 }), { code: 'AUTH_PROTOCOL_ERROR' });
});

test('native multiline keys and empty deletion cookies are preserved without allowing controls', () => {
  const input = registration();
  input.response.success.tokens.mac_dms = { adp_token: 'adp', device_private_key: '-----BEGIN PRIVATE KEY-----\nexample\n-----END PRIVATE KEY-----\n' };
  input.response.success.tokens.website_cookies[0].Value = '';
  const session = parseRegistrationResponse(input);
  assert.equal(session.cookies[0].value, '');
  assert.equal(session.macDms.devicePrivateKey, input.response.success.tokens.mac_dms.device_private_key);
  input.response.success.tokens.mac_dms.device_private_key = 'bad\u0000key';
  assert.throws(() => parseRegistrationResponse(input), { code: 'AUTH_PROTOCOL_ERROR' });
});

test('device identifiers obey the native register validation before code issuance', () => {
  for (const deviceSerial of ['hyphen-uuid', 'x'.repeat(52), '', 'bad serial']) {
    assert.throws(() => createCodePairRequest({ ...profile, deviceSerial }), { code: 'AUTH_PROTOCOL_ERROR' });
    assert.throws(() => registerCodePairRequest({ ...profile, deviceSerial }, pair), { code: 'AUTH_PROTOCOL_ERROR' });
  }
});

test('cookie renewal is an independently encoded native form request', () => {
  const req = refreshCookiesRequest(profile, { refreshToken: 'token+with&reserved=', secureSessionToken: 'sst' });
  assert.equal(req.encoding, 'form');
  assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(req.body);
  assert.equal(new URLSearchParams(form.toString()).get('source_token'), 'token+with&reserved=');
  assert.equal(form.get('requested_token_type'), 'auth_cookies');
  assert.equal(form.get('di.sdk.version'), '20260904N');
  const source = registration().response.success.tokens.website_cookies;
  const result = parseCookiesRefreshResponse({ response: { tokens: { cookies: { '.amazon.com': source }, ttl: 3600 } } });
  assert.equal(result.cookies[0].domain, 'amazon.com');
  assert.equal(result.cookiesTtl, 3600);
  assert.throws(() => parseCookiesRefreshResponse({ response: { tokens: { cookies: { 'attacker.invalid': source } } } }), { code: 'AUTH_PROTOCOL_ERROR' });
  assert.throws(() => parseCookiesRefreshResponse({ response: { tokens: { cookies: {} } } }), { code: 'AUTH_PROTOCOL_ERROR' });
});

test('cookie renewal preserves genuine root secure session rotation from the live response shape', () => {
  const result = parseCookiesRefreshResponse({ secureSessionToken: 'new-server-sst', request_id: 'opaque-request', response: { age_classification: 'opaque-classification', tokens: { ttl: 3600, cookies: { '.amazon.com': [
    { Name: 'session-id', Value: 'own-session-id', Path: '/', Secure: true, HttpOnly: true },
    { Name: 'session-token', Value: 'own-session-token', Path: '/', Secure: true, HttpOnly: true },
    { Name: 'session-id-time', Value: '2082787201l', Path: '/', Secure: true, HttpOnly: false },
  ] } } } });
  assert.equal(result.secureSessionToken, 'new-server-sst');
  assert.deepEqual(result.cookies.map(c => c.name), ['session-id', 'session-token', 'session-id-time']);
  assert.equal(result.cookiesTtl, 3600);
  assert.throws(() => parseCookiesRefreshResponse({ secureSessionToken: 'bad\r\nheader', response: { tokens: { cookies: { '.amazon.com': registration().response.success.tokens.website_cookies } } } }), { code: 'AUTH_PROTOCOL_ERROR' });
});
