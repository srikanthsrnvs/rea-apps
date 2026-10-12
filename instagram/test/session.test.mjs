import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionFromExport, requestHeaders, updateResponseCookies, sessionStatus } from '../src/session.mjs';
import { importSession } from '../src/auth.mjs';

export const fixture = () => ({ cookies: [
  { name: 'sessionid', value: 'fixture-session', domain: '.instagram.com', path: '/', expires: 4_000_000_000 },
  { name: 'csrftoken', value: 'fixture-csrf', domain: '.instagram.com', path: '/', expires: -1 },
] });

test('credential import only accepts active Instagram cookies and validates the account', async () => {
  const input = fixture();
  input.cookies.push({ name: 'unrelated', value: 'other-site', domain: '.example.com', path: '/', expires: -1 });
  const session = await importSession(input, { validate: async () => ({ user: { pk: 123, username: 'fixture' } }) });
  assert.equal(session.cookies.length, 2);
  assert.deepEqual(session.account, { id: '123', username: 'fixture' });
  await assert.rejects(importSession(fixture(), { validate: async () => ({ status: 'ok' }) }), { code: 'INVALID_RESPONSE' });
});

test('expired, foreign-domain, and header-injecting sessions are rejected', () => {
  const expired = fixture(); expired.cookies[0].expires = 1;
  assert.throws(() => sessionFromExport(expired), { code: 'LOGIN_REQUIRED' });
  const foreign = fixture(); foreign.cookies[0].domain = '.instagram.com.evil.example';
  assert.throws(() => sessionFromExport(foreign), { code: 'LOGIN_REQUIRED' });
  const injected = fixture(); injected.cookies[0].value = 'fake\r\nAuthorization: fake';
  assert.throws(() => sessionFromExport(injected), { code: 'INVALID_SESSION' });
  assert.throws(() => sessionFromExport({ ...fixture(), userAgent: 'x\r\ny' }), { code: 'INVALID_SESSION' });
});

test('cookies respect paths; responses rotate credentials and apply cookie deletion', () => {
  const input = fixture(); input.cookies.push({ name: 'path-cookie', value: 'a', domain: '.instagram.com', path: '/private', expires: -1 });
  const session = sessionFromExport(input);
  assert.doesNotMatch(requestHeaders(session, '/api/v1/accounts/current_user/').cookie, /path-cookie/);
  const headers = new Headers();
  headers.append('set-cookie', 'csrftoken=rotated; Domain=.instagram.com; Path=/; Secure; Max-Age=3600');
  headers.append('set-cookie', 'path-cookie=deleted; Domain=.instagram.com; Path=/private; Max-Age=0');
  headers.set('x-ig-set-www-claim', 'fixture-claim');
  const updated = updateResponseCookies(session, headers, 1_000_000);
  assert.equal(updated.cookies.find(c => c.name === 'csrftoken').value, 'rotated');
  assert.equal(updated.cookies.find(c => c.name === 'csrftoken').expires, 4600);
  assert.equal(updated.cookies.some(c => c.name === 'path-cookie'), false);
  assert.equal(updated.wwwClaim, 'fixture-claim');
  assert.equal(JSON.stringify(sessionStatus(updated)).includes('fixture-session'), false);
});

test('server deletion of the session is visible locally and prevents another request', () => {
  const headers = new Headers({ 'set-cookie': 'sessionid=; Domain=.instagram.com; Path=/; Max-Age=0' });
  const updated = updateResponseCookies(sessionFromExport(fixture()), headers);
  assert.equal(sessionStatus(updated).loggedIn, false);
  assert.throws(() => requestHeaders(updated, '/api/v1/accounts/current_user/'), { code: 'LOGIN_REQUIRED' });
});
