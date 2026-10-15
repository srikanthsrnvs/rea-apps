import test from 'node:test';
import assert from 'node:assert/strict';
import { newSession, receiveCookies, cookieHeader, csrfToken, sessionFromExport, sessionStatus } from '../src/session.mjs';
import { LinkedInClient, restli } from '../src/http.mjs';
import { me } from '../src/account.mjs';

test('cookie scopes, expiry, deletion and CSRF unquoting follow server state', () => {
  const session = newSession();
  const headers = new Headers();
  headers.append('set-cookie', 'JSESSIONID="ajax:server"; Domain=.linkedin.com; Path=/; Secure');
  headers.append('set-cookie', 'scoped=secret; Path=/voyager/api/messaging; Secure');
  headers.append('set-cookie', 'bad=secret; Domain=attacker.test; Path=/');
  receiveCookies(session, headers, 'https://www.linkedin.com/voyager/api/');
  assert.equal(csrfToken(session), 'ajax:server');
  assert.doesNotMatch(cookieHeader(session, 'https://www.linkedin.com/voyager/api/graphql'), /scoped|bad/);
  assert.match(cookieHeader(session, 'https://www.linkedin.com/voyager/api/messaging/one'), /scoped=secret/);
  assert.throws(() => cookieHeader(session, 'https://attacker.test/'), { code: 'UNSAFE_URL' });
  receiveCookies(session, new Headers({ 'set-cookie': 'JSESSIONID=gone; Domain=.linkedin.com; Path=/; Max-Age=0' }), 'https://www.linkedin.com/');
  assert.equal(csrfToken(session), null);
});

test('session import preserves internal expiry units and filters foreign cookies', () => {
  const s = newSession();
  s.cookies.push({ name: 'li_at', value: 'opaque', domain: '.linkedin.com', path: '/', expires: Date.now() + 100_000 });
  assert.equal(sessionFromExport(s).cookies.find(c => c.name === 'li_at').expires, s.cookies[1].expires);
  const imported = sessionFromExport({ cookies: [{ name: 'li_at', value: 'opaque', domain: '.linkedin.com', path: '/', expires: 2_000_000_000 }, { name: 'foreign', value: 'private', domain: '.example.com' }] });
  assert.equal(imported.cookies.find(c => c.name === 'li_at').expires, 2_000_000_000_000);
  assert.equal(imported.cookies.some(c => c.name === 'foreign'), false);
});

test('Rest.li escapes scalar structure and preserves nested native map/list syntax', () => {
  assert.equal(restli({ query: { keywords: 'a,(b):c &d', queryParameters: { resultType: ['PEOPLE'] } }, count: 10 }),
    '(query:(keywords:a%2C%28b%29%3Ac%20%26d,queryParameters:(resultType:List(PEOPLE))),count:10)');
});

test('transport sends cookies only to LinkedIn, rotates before auth error and never follows redirects', async () => {
  const session = newSession();
  let calls = 0;
  const client = new LinkedInClient(session, { fetchImpl: async (url, options) => {
    calls++; assert.equal(options.redirect, 'manual'); assert.ok(options.headers['Csrf-Token'].startsWith('ajax:'));
    assert.equal(options.headers.Accept, 'application/json');
    return new Response('', { status: 302, headers: { location: 'https://attacker.test/private', 'set-cookie': 'li_at=rotated; Path=/; Secure' } });
  } });
  await assert.rejects(client.request({ path: '/voyager/api/me' }), { code: 'AUTH_REQUIRED' });
  assert.equal(calls, 1);
  assert.match(cookieHeader(session, 'https://www.linkedin.com/'), /li_at=rotated/);
  await assert.rejects(client.request({ path: '//attacker.test' }), { code: 'UNSAFE_URL' });
  assert.equal(calls, 1);
});
test('multipart native challenge polling lets fetch choose its boundary', async () => {
  const client = new LinkedInClient(newSession(), { fetchImpl: async (url, options) => {
    assert.equal(options.headers['Content-Type'], undefined);
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('recognizedDevice'), 'false');
    return Response.json({ pollingResponseChallengeStateV2: 'SOLVED' });
  } });
  assert.equal((await client.request({ path: '/checkpoint/challengesV2/poll/test', method: 'POST', multipartForm: { recognizedDevice: false } })).pollingResponseChallengeStateV2, 'SOLVED');
});

test('401 or rejected redirect clears prior authentication validation even when cookies remain', async () => {
  for (const status of [401, 302]) {
    const session = newSession();
    session.validatedAt = new Date().toISOString();
    session.cookies.push({ name: 'li_at', value: 'opaque', domain: '.linkedin.com', path: '/', secure: true });
    assert.equal(sessionStatus(session).authenticated, true);
    const client = new LinkedInClient(session, { fetchImpl: async () => new Response('', { status, headers: status === 302 ? { location: '/login' } : {} }) });
    await assert.rejects(client.request({ path: '/voyager/api/me' }), { code: 'AUTH_REQUIRED' });
    assert.equal(sessionStatus(session).authenticated, false);
    assert.equal(session.cookies.some(cookie => cookie.name === 'li_at'), true);
  }
});
test('known recipient restriction exposes only its recognized code, not raw server diagnostics', async () => {
  const client = new LinkedInClient(newSession(), { fetchImpl: async () => Response.json({ code: 'RECIPIENT_NOT_FIRST_DEGREE_CONNECTION', message: 'private server text', exceptionClass: 'private implementation' }, { status: 422 }) });
  await assert.rejects(client.request({ path: '/voyager/api/messages', method: 'POST', body: {} }), error => error.details.serverCode === 'RECIPIENT_NOT_FIRST_DEGREE_CONNECTION'
    && !JSON.stringify(error).includes('private'));
});

test('auth can inspect 401 challenge; errors and mutation network failures expose no body', async () => {
  const client = new LinkedInClient(newSession(), { fetchImpl: async () => new Response(JSON.stringify({ challenge_url: '/checkpoint/test', secret: 'do-not-log' }), { status: 401 }) });
  const response = await client.request({ path: '/uas/authenticate', method: 'POST', allowStatuses: [401], responseMeta: true });
  assert.equal(response.status, 401);
  assert.equal(response.data.challenge_url, '/checkpoint/test');
  await assert.rejects(client.request({ path: '/uas/authenticate' }), error => error.code === 'AUTH_REQUIRED' && !JSON.stringify(error).includes('do-not-log'));
  client.fetch = async () => { throw Error('session=secret'); };
  await assert.rejects(client.request({ path: '/voyager/api/messages', method: 'POST', body: {} }), error => error.details.ambiguous === true && !error.message.includes('secret'));
});

test('me validates a specific authenticated collection and uses returned profile identity as mailbox', async () => {
  const session = newSession();
  const client = { session, graphql: async request => {
    assert.equal(request.queryName, 'ProfilesByMe');
    return { data: { identityDashProfilesByMe: { '*elements': ['urn:li:fsd_profile:one'] } }, included: [{ entityUrn: 'urn:li:fsd_profile:one', firstName: 'Example', publicIdentifier: 'example' }] };
  } };
  assert.equal((await me(client)).mailboxUrn, 'urn:li:fsd_profile:one');
  client.graphql = async () => ({ data: { identityDashProfilesByMe: { elements: [] } } });
  await assert.rejects(me(client), { code: 'INVALID_SESSION' });
});
test('optional profile fetch failures preserve primary data while validation and root failures remain errors', async () => {
  let payload = { data: { profile: { elements: [{ entityUrn: 'urn:li:fsd_profile:one' }] } },
    errors: [{ path: ['profile', 'elements', 0, 'profileRingStatusCollection'], extensions: { classification: 'DataFetchingException' } }] };
  const client = new LinkedInClient(newSession(), { fetchImpl: async () => Response.json(payload) });
  const request = { queryId: 'voyagerIdentityDashProfiles.7186fe864099dc0343c4b65e736363e9', field: 'profile', allowPartialData: true };
  assert.ok((await client.graphql(request)).data.profile);
  await assert.rejects(client.graphql({ ...request, allowPartialData: false }), { code: 'GRAPHQL_ERROR' });
  payload.errors[0].extensions.classification = 'ValidationError';
  await assert.rejects(client.graphql(request), { code: 'GRAPHQL_ERROR' });
  payload.errors[0] = { path: ['profile'], extensions: { classification: 'DataFetchingException' } };
  await assert.rejects(client.graphql(request), { code: 'GRAPHQL_ERROR' });
});
