import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenTableClient, acquireAnonymous, parseJson } from '../src/http.mjs';
const token = 'fixture_access_token_123456';

test('native anonymous grant has exact form and routing omits bearer credentials', async () => {
  const body = await acquireAnonymous({ fetchImpl: async (url, options) => {
    assert.equal(url.href, 'https://mobile-api.opentable.com/oauth/consumer/token');
    assert.equal(options.redirect, 'manual'); assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers['user-agent'], `com.opentable/26.25.0; android; android/16; 2.4/2364x1080; ${options.headers['x-ot-sessionid']}/Anonymous`);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)), { grant_type: 'implicit', client_id: 'ot-anonymous-apps', client_secret: '0pentab1e' });
    return Response.json({ access_token: token, expires_in: 3600, scope: 'fixture', token_type: 'bearer' });
  } });
  assert.equal(body.accessToken, token); assert.ok(body.expiresAt > Date.now());
});

test('authenticated requests are origin-bound, method-allowlisted and do not follow redirects', async () => {
  let calls = 0;
  const client = new OpenTableClient({ token, fetchImpl: async (url, options) => {
    calls++; assert.equal(url.origin, 'https://mobile-api.opentable.com');
    assert.equal(options.headers.authorization, `bearer ${token}`); assert.equal(options.redirect, 'manual');
    return new Response('private payload', { status: 302, headers: { location: 'https://example.com' } });
  } });
  await assert.rejects(client.me(), { code: 'REDIRECT_REJECTED' });
  await assert.rejects(client.request('/api/v3/reservation/123', { method: 'GET' }), { code: 'INVALID_ENDPOINT' });
  await assert.rejects(client.request('https://example.com/api/v3/user'), { code: 'INVALID_ENDPOINT' });
  await assert.rejects(client.request('/api/v3/restaurant/../user'), { code: 'INVALID_ENDPOINT' });
  assert.equal(calls, 1);
});

test('availability PUT preserves request JSON and cancellation query tokens stay out of errors', async () => {
  const client = new OpenTableClient({ token, fetchImpl: async (url, options) => {
    if (options.method === 'PUT') {
      assert.equal(url.pathname, '/api/v3/restaurant/availability');
      assert.equal(JSON.parse(options.body).covers, 2);
      return Response.json({ restaurants: [] });
    }
    assert.equal(url.searchParams.get('token'), 'private-reservation-token');
    return new Response('private-reservation-token', { status: 403 });
  } });
  await client.request('/api/v3/restaurant/availability', { method: 'PUT', json: { covers: 2 } });
  await assert.rejects(client.request('/api/v3/reservation/123/456', { method: 'DELETE', query: { token: 'private-reservation-token' } }), error => error.code === 'ACCESS_REJECTED' && !JSON.stringify(error).includes('private-reservation-token'));
});

test('API errors and uncertain network failures never retry or expose response bodies', async () => {
  for (const [status, code] of [[401, 'LOGIN_REQUIRED'], [403, 'ACCESS_REJECTED'], [429, 'RATE_LIMITED'], [500, 'API_ERROR']]) {
    let calls = 0;
    const client = new OpenTableClient({ token, fetchImpl: async () => { calls++; return new Response(token, { status, headers: { 'retry-after': '5' } }); } });
    await assert.rejects(client.me(), error => error.code === code && !JSON.stringify(error).includes(token));
    assert.equal(calls, 1);
  }
  const client = new OpenTableClient({ token, fetchImpl: async () => { throw Error(token); } });
  await assert.rejects(client.me(), error => error.code === 'NETWORK_ERROR' && !error.message.includes(token));
  assert.equal(parseJson('{"id":9007199254740993001}').id, '9007199254740993001');
  assert.throws(() => new OpenTableClient({ token: 'bad\r\nheader' }), { code: 'INVALID_SESSION' });
  await assert.rejects(new OpenTableClient().me(), { code: 'LOGIN_REQUIRED' });
});
