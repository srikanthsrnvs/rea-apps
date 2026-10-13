import test from 'node:test';
import assert from 'node:assert/strict';
import { ResyClient, parseJson } from '../src/http.mjs';
const token = 'fixture_session_token_123456';

test('client scopes session to exact allowlisted origin and never follows redirects', async () => {
  let calls = 0;
  const client = new ResyClient({ token, fetchImpl: async (url, options) => {
    calls++; assert.equal(url.origin, 'https://api.resy.com');
    assert.equal(options.redirect, 'manual'); assert.equal(options.headers['x-resy-auth-token'], token);
    assert.equal(options.headers['x-resy-universal-auth'], token);
    return new Response('private response', { status: 302, headers: { location: 'https://example.com' } });
  } });
  await assert.rejects(client.me(), { code: 'REDIRECT_REJECTED' });
  await assert.rejects(client.request('https://example.com/2/user'), { code: 'INVALID_ENDPOINT' });
  await assert.rejects(client.request('/3/book', { method: 'GET' }), { code: 'INVALID_ENDPOINT' });
  await assert.rejects(client.request('/2/user/payment_method'), { code: 'INVALID_ENDPOINT' });
  assert.equal(calls, 1);
});

test('public reads omit auth headers and form objects preserve first-party serialization', async () => {
  const calls = [];
  const client = new ResyClient({ token, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json({ ok: true });
  } });
  await client.request('/4/find', { method: 'POST', json: { party_size: 2 }, authenticated: false });
  assert.equal(calls[0].options.headers['x-resy-auth-token'], undefined);
  assert.equal(calls[0].options.headers['x-resy-universal-auth'], undefined);
  await client.request('/3/book', { method: 'POST', form: { book_token: 'opaque', struct_payment_method: { id: '42' }, venue_marketing_opt_in: 0 } });
  const fields = new URLSearchParams(calls[1].options.body);
  assert.equal(fields.get('struct_payment_method'), '{"id":"42"}');
  assert.equal(fields.get('venue_marketing_opt_in'), '0');
});

test('rate limits, auth expiry, server failures and network errors do not retry or leak payloads', async () => {
  for (const [status, code] of [[429, 'RATE_LIMITED'], [419, 'LOGIN_REQUIRED'], [403, 'APPROVAL_REQUIRED'], [500, 'API_ERROR']]) {
    let calls = 0;
    const client = new ResyClient({ token, fetchImpl: async () => { calls++; return new Response(token, { status, headers: { 'retry-after': '7' } }); } });
    await assert.rejects(client.me(), error => error.code === code && !JSON.stringify(error).includes(token));
    assert.equal(calls, 1);
  }
  const broken = new ResyClient({ token, fetchImpl: async () => { throw Error(token); } });
  await assert.rejects(broken.me(), error => error.code === 'NETWORK_ERROR' && !error.message.includes(token));
});

test('precision parsing and account validation retain exact IDs', async () => {
  const client = new ResyClient({ token, fetchImpl: async () => new Response('{"id":9007199254740993001,"first_name":"Fixture"}') });
  assert.equal((await client.me()).id, '9007199254740993001');
  assert.equal(parseJson('{"id":42}').id, 42);
  assert.throws(() => new ResyClient({ token: 'bad\r\nheader' }), { code: 'INVALID_SESSION' });
  await assert.rejects(new ResyClient().me(), { code: 'LOGIN_REQUIRED' });
  await assert.rejects(new ResyClient({ token, fetchImpl: async () => Response.json({ token }) }).me(), { code: 'INVALID_RESPONSE' });
});
