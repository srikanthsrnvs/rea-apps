import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_CONFIG, AUTH_FLOW_VERSION, authorizationCodeGrant, buildAuthorizeRequest, buildBrowserAuthorizeRequest, buildEmailCodeStep,
  buildNativeStep, buildUsernameStep, createAuthAttempt, nativeTokenGrant,
  parseAuthPage, parseAuthorizationCallback, parseTokenResponse, refreshTokenGrant,
} from '../src/auth-protocol.mjs';

test('each login has independent PKCE, state and nonce with the versioned browser return flow', () => {
  const first = createAuthAttempt({ email: 'name+account@example.test' });
  const second = createAuthAttempt();
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.pkce.verifier, second.pkce.verifier);
  const url = new URL(first.request.url);
  assert.equal(url.origin + url.pathname, AUTH_CONFIG.authorizeUrl);
  assert.equal(first.flowVersion, AUTH_FLOW_VERSION);
  assert.equal(url.searchParams.get('login_hint'), null);
  assert.equal(url.searchParams.get('code_challenge'), first.pkce.challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), AUTH_CONFIG.redirectUri);
  assert.equal(url.searchParams.get('scope'), AUTH_CONFIG.scopes.join(' '));
  assert.equal(url.searchParams.get('preauth_cookie_failed'), 'other');
  for (const key of ['ccaps', 'issuer', 'screen_hint', 'hydra_flow', 'preauth_cookie']) {
    assert.equal(url.searchParams.has(key), false);
  }
  assert.equal(first.request.method, 'GET');
  assert.equal(first.request.headers.Accept, 'text/html');
});

test('native JSON authorization keeps its native capabilities and initialization parameters', () => {
  const request = buildAuthorizeRequest({ ...createAuthAttempt(), email: 'name+account@example.test' });
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('login_hint'), 'name+account@example.test');
  assert.equal(url.searchParams.get('ccaps'), 'email_otp_deeplink default_otp_v2 login_methods');
  assert.equal(url.searchParams.get('issuer'), AUTH_CONFIG.issuer);
  assert.equal(url.searchParams.get('screen_hint'), 'login_or_signup');
  assert.equal(url.searchParams.get('hydra_flow'), 'condense');
  assert.equal(url.searchParams.has('preauth_cookie_failed'), false);
  assert.equal(request.headers.Accept, 'application/json');
});

test('browser authorization accepts only one real preauthorization outcome and always requests OpenID', () => {
  const attempt = createAuthAttempt();
  const request = buildBrowserAuthorizeRequest({ ...attempt, scopes: ['email'], preauthCookie: 'genuine-provider-cookie' });
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('scope'), 'email openid');
  assert.equal(url.searchParams.get('preauth_cookie'), 'genuine-provider-cookie');
  assert.equal(url.searchParams.has('preauth_cookie_failed'), false);
  assert.throws(() => buildBrowserAuthorizeRequest({ ...attempt, preauthCookie: 'cookie', preauthCookieFailure: 'other' }), { code: 'INVALID_AUTH_INPUT' });
  assert.throws(() => buildBrowserAuthorizeRequest({ ...attempt, preauthCookie: '' }), { code: 'INVALID_AUTH_INPUT' });
  assert.throws(() => buildBrowserAuthorizeRequest({ ...attempt, preauthCookieFailure: 'other\r\nInjected' }), { code: 'INVALID_AUTH_INPUT' });
});

test('authorize input cannot inject headers or omit PKCE', () => {
  assert.throws(() => buildAuthorizeRequest({}), { code: 'INVALID_AUTH_INPUT' });
  const attempt = createAuthAttempt();
  assert.throws(() => buildAuthorizeRequest({ ...attempt, deviceId: 'device\r\nX-Header: value' }), { code: 'INVALID_AUTH_INPUT' });
});

test('native username request preserves the identifier object and server page state', () => {
  const request = buildUsernameStep('reader@example.test', 'login_start');
  assert.equal(request.url, AUTH_CONFIG.nextUrl);
  assert.equal(request.method, 'POST');
  assert.deepEqual(request.body, {
    origin_page_type: 'login_start', data: { username: { value: 'reader@example.test', kind: 'email' } },
  });
  assert.throws(() => buildNativeStep('https://example.test', {}), { code: 'INVALID_AUTH_INPUT' });
});

test('email verification preserves leading zeroes and distinguishes resend from validate', () => {
  assert.deepEqual(buildEmailCodeStep('010923').body, {
    origin_page_type: 'email_otp_verification', data: { code: '010923', intent: 'validate' },
  });
  assert.deepEqual(buildEmailCodeStep(undefined, { intent: 'resend' }).body.data, { code: '', intent: 'resend' });
  assert.throws(() => buildEmailCodeStep(10923), { code: 'INVALID_AUTH_INPUT' });
  assert.throws(() => buildEmailCodeStep(123456), { code: 'INVALID_AUTH_INPUT' });
  assert.throws(() => buildEmailCodeStep('123456', { intent: 'anything' }), { code: 'INVALID_AUTH_INPUT' });
});

test('callback requires the exact redirect and one matching state and code', () => {
  const options = { state: 'state-one' };
  const callback = `${AUTH_CONFIG.redirectUri}?state=state-one&code=authorization-code`;
  assert.deepEqual(parseAuthorizationCallback(callback, options), { code: 'authorization-code', state: 'state-one' });
  assert.throws(() => parseAuthorizationCallback(callback, { state: 'other-state' }), { code: 'AUTH_STATE_MISMATCH' });
  assert.throws(() => parseAuthorizationCallback(`${callback}&state=state-one`, options), { code: 'AUTH_STATE_MISMATCH' });
  assert.throws(() => parseAuthorizationCallback(`${callback}&code=second`, options), { code: 'INVALID_AUTH_CALLBACK' });
  assert.throws(() => parseAuthorizationCallback(callback.replace('/callback?', '/other?'), options), { code: 'INVALID_AUTH_CALLBACK' });
  assert.throws(() => parseAuthorizationCallback(`${callback}#state=state-one`, options), { code: 'INVALID_AUTH_CALLBACK' });
});

test('denied callbacks fail without reflecting private query parameters', () => {
  const callback = `${AUTH_CONFIG.redirectUri}?state=one&error=access_denied&error_description=secret-data`;
  assert.throws(() => parseAuthorizationCallback(callback, { state: 'one' }), error => {
    assert.equal(error.code, 'AUTHORIZATION_DENIED');
    assert.ok(!JSON.stringify(error).includes('secret-data'));
    return true;
  });
});

test('native page parser retains unrecognized pages without claiming authentication', () => {
  const response = { page: { type: 'email_otp_verification', payload: { email: 'reader@example.test' }, errors: [{ code: 'invalid_code' }] } };
  const page = parseAuthPage(response);
  assert.equal(page.type, 'email_otp_verification');
  assert.deepEqual(page.payload, response.page.payload);
  assert.deepEqual(page.errors, response.page.errors);
  assert.equal(parseAuthPage({ page: { type: 'future_supported_step' } }).type, 'future_supported_step');
  assert.throws(() => parseAuthPage({ access_token: 'not-a-page' }), { code: 'INVALID_AUTH_RESPONSE' });
});

test('grant builders keep native identity exchange distinct from authorization-code exchange', () => {
  assert.deepEqual(authorizationCodeGrant({ code: 'code', verifier: 'verifier' }), {
    client_id: AUTH_CONFIG.clientId, code: 'code', code_verifier: 'verifier', redirect_uri: AUTH_CONFIG.redirectUri, grant_type: 'authorization_code',
  });
  const native = nativeTokenGrant({ subjectToken: 'identity' });
  assert.equal(native.subject_token_type, 'urn:authapi:id-token');
  assert.equal(native.grant_type, 'urn:ietf:params:oauth:grant-type:token-exchange');
  assert.equal(native.subject_token, 'identity');
  assert.equal(refreshTokenGrant({ refreshToken: 'refresh' }).grant_type, 'refresh_token');
  assert.throws(() => authorizationCodeGrant({ code: '', verifier: 'verifier' }), { code: 'INVALID_AUTH_INPUT' });
});

test('tokens must have positive lifetimes; server errors never become saved sessions', () => {
  assert.deepEqual(parseTokenResponse({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, token_type: 'DPoP' }), {
    accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600, tokenType: 'DPoP',
  });
  for (const expires_in of [-1, 0, undefined, Infinity, '3600']) {
    assert.throws(() => parseTokenResponse({ access_token: 'access', expires_in }), { code: 'INVALID_AUTH_RESPONSE' });
  }
  assert.throws(() => parseTokenResponse({ error: 'invalid_grant', error_description: 'secret-details' }), { code: 'TOKEN_EXCHANGE_FAILED' });
});
