import test from 'node:test';
import assert from 'node:assert/strict';
import { newSession } from '../src/session.mjs';
import { nativeAuthResult, loginWithPassword, loginWithGoogleToken, completeWebLogin, passwordlessEmailTokens,
  checkPasswordlessEmailEligibility } from '../src/auth-protocol.mjs';

function client(response = { status: 200, data: { login_result: 'PASS' } }) {
  const calls = [];
  return { calls, session: newSession(), async request(request) {
    calls.push(request);
    return request.responseMeta ? response : { eligibilityResult: 'PASS' };
  } };
}

test('native password login establishes cookies, encodes credentials and requires profile validation', async () => {
  const c = client();
  c.session.cookies.push({ name: 'bscookie', value: 'v=1&test', domain: '.linkedin.com', path: '/', secure: true });
  const result = await loginWithPassword(c, { identifier: 'someone@example.com', password: 'a&secret=1' });
  assert.equal(c.calls.length, 2);
  assert.equal(c.calls[0].path, '/uas/authenticate');
  assert.equal(c.calls[0].method, undefined);
  assert.equal(c.calls[1].method, 'POST');
  assert.deepEqual(c.calls[1].allowStatuses, [401]);
  assert.equal(c.calls[1].form.session_password, 'a&secret=1');
  assert.equal(c.calls[1].form.bscookie, 'v=1&test');
  assert.equal(c.calls[1].form.rememberMeOptIn, 'true');
  assert.deepEqual(result, { authenticated: false, status: 'validation_required', loginResult: 'PASS' });
  assert.equal(JSON.stringify(c.session).includes('a&secret=1'), false);
  assert.equal(JSON.stringify(result).includes('a&secret=1'), false);
});

test('native challenge keeps official URL but explicitly requires a session handoff', () => {
  const result = nativeAuthResult({ status: 401, data: { login_result: 'CHALLENGE', challenge_url: '/checkpoint/challenge/123?token=a' } });
  assert.equal(result.verificationUrl, 'https://www.linkedin.com/checkpoint/challenge/123?token=a');
  assert.equal(result.completion, 'session_handoff_required');
  assert.equal(result.authenticated, false);
  assert.equal('pollUrl' in result, false);
});

test('unrecognized success and rejected credentials never become authenticated', () => {
  for (const data of [{}, { login_result: 'BAD_PASSWORD' }, null, []]) {
    assert.throws(() => nativeAuthResult({ status: 200, data }));
  }
  assert.throws(() => nativeAuthResult({ status: 401, data: { login_result: 'BAD_PASSWORD', session_password: 'secret' } }),
    error => error.code === 'LOGIN_DENIED' && !JSON.stringify(error.details).includes('secret'));
});

test('verification destinations cannot send credentials to other origins', () => {
  for (const challenge_url of ['https://evil.example/a', '//evil.example/a', 'http://www.linkedin.com/a', 'https://user@www.linkedin.com/a']) {
    assert.throws(() => nativeAuthResult({ status: 401, data: { login_result: 'CHALLENGE', challenge_url } }),
      { code: 'UNSAFE_AUTH_RESPONSE' });
  }
});

test('invalid login inputs do not make a request', async () => {
  const c = client();
  await assert.rejects(loginWithPassword(c, { identifier: 'a@example.com', password: '' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(loginWithPassword(c, { identifier: 'a@example.com', password: 'valid', rememberMe: 'true' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(c.calls.length, 0);
});

test('cookie exchange uses native endpoint without claiming the account was validated', async () => {
  const c = client();
  assert.equal((await completeWebLogin(c, 'li_at=private; JSESSIONID="ajax:123"')).status, 'validation_required');
  assert.deepEqual(c.calls[0].form, { cookies: 'li_at=private; JSESSIONID="ajax:123"' });
  assert.equal(c.calls[0].path, '/uas/issueLoginCookie');
  assert.equal(c.calls[0].method, 'POST');
});

test('email link parser is limited to existing official token pairs', () => {
  const valid = 'https://www.linkedin.com/ssr-login/passwordless-email-login?midToken=a&otpToken=b';
  assert.deepEqual(passwordlessEmailTokens(valid), { midToken: 'a', otpToken: 'b' });
  for (const url of [valid.replace('www.linkedin.com', 'evil.example'), valid + '&otpToken=c', valid.replace('otpToken=b', ''), valid.replace('/ssr-login/passwordless-email-login', '/login')]) {
    assert.throws(() => passwordlessEmailTokens(url), { code: 'INVALID_ARGUMENT' });
  }
});

test('email token eligibility preserves login context and is never a login success', async () => {
  const c = client();
  const link = 'https://www.linkedin.com/ssr-login/passwordless-email-login?midToken=a&otpToken=b';
  await assert.rejects(checkPasswordlessEmailEligibility(c, link), { code: 'AUTH_CONTEXT_REQUIRED' });
  c.session.cookies.push({ name: 'bscookie', value: 'v=1&test', domain: '.linkedin.com', path: '/', secure: true });
  assert.deepEqual(await checkPasswordlessEmailEligibility(c, link), { eligible: true, authenticated: false });
  assert.deepEqual(c.calls[0].body, { bscookie: 'v=1&test', midToken: 'a', otpToken: 'b' });
  assert.equal(c.calls[0].path, '/checkpoint/lg/passwordless-email-check-eligibility');
});


test('native Google token authentication uses the token alternative without password or username', async () => {
  const c = client();
  const result = await loginWithGoogleToken(c, { idToken: 'private-google-token' });
  assert.equal(c.calls.length, 2);
  assert.equal(c.calls[1].path, '/uas/authenticate');
  assert.equal(c.calls[1].method, 'POST');
  assert.equal(c.calls[1].form.googleIdToken, 'private-google-token');
  for (const key of ['session_key', 'session_password', 'session_midToken', 'rememberMeOptIn']) {
    assert.equal(key in c.calls[1].form, false);
  }
  assert.equal(result.status, 'validation_required');
  assert.equal(result.authenticated, false);
  assert.equal(JSON.stringify(c.session).includes('private-google-token'), false);
});

test('Google token challenge is reported without claiming a completed login', async () => {
  const c = client({ status: 401, data: { login_result: 'CHALLENGE', challenge_url: '/checkpoint/challenge/123' } });
  assert.equal((await loginWithGoogleToken(c, { idToken: 'token' })).status, 'verification_required');
  const empty = client();
  await assert.rejects(loginWithGoogleToken(empty, { idToken: '' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(empty.calls.length, 0);
});
