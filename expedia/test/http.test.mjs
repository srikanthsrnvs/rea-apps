import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CookieJar, ExpediaHttpClient } from '../src/http.mjs';

test('cookies follow host, path, HTTPS and expiry boundaries and survive loading without extending lifetime', () => {
  const expiresAt = Date.now() + 60000;
  const jar = new CookieJar([
    { name: 'session', value: 'private', domain: 'expedia.com', path: '/checkout', secure: true, expiresAt, maxAge: 60000 },
    { name: 'host', value: 'one', domain: 'www.expedia.com', path: '/', hostOnly: true },
    { name: 'bad', value: 'no', domain: 'other.example', path: '/' },
    { name: 'injection', value: 'hello; evil=1', domain: 'expedia.com', path: '/' },
  ]);
  assert.equal(jar.header('https://www.expedia.com/checkout/session/a'), 'session=private; host=one');
  assert.equal(jar.header('https://www.expedia.com/checkout-malicious'), 'host=one');
  assert.equal(jar.header('http://www.expedia.com/checkout'), 'host=one');
  assert.equal(jar.header('https://api.expedia.com/checkout'), 'session=private');
  assert.equal(jar.header('https://expedia.com.evil.example/checkout'), '');
  assert.equal(new CookieJar(jar.cookies).cookies[0].expiresAt, expiresAt);
});
test('Set-Cookie handles separate expiry commas, domain rejection, replacement and explicit deletion', () => {
  const jar = new CookieJar();
  const headers = new Headers();
  headers.append('set-cookie', 'a=first; Path=/; Secure; Expires=Tue, 19 Jan 2038 03:14:07 GMT');
  headers.append('set-cookie', 'b=second; Domain=.expedia.com; HttpOnly; Path=/');
  headers.append('set-cookie', 'stolen=no; Domain=evil.example; Path=/');
  jar.receive(headers, 'https://www.expedia.com/graphql');
  assert.equal(jar.cookies.length, 2);
  assert.equal(jar.cookies[1].httpOnly, true);
  jar.receive(new Headers({ 'set-cookie': 'a=; Max-Age=0; Path=/' }), 'https://www.expedia.com/graphql');
  assert.equal(jar.header('https://www.expedia.com/'), 'b=second');
});
test('HTTP client refuses other services and never follows a credential-bearing redirect', async () => {
  let calls = 0;
  const client = new ExpediaHttpClient({ fetchImpl: async (url, options) => {
    calls++; assert.equal(options.redirect, 'manual');
    return new Response('', { status: 302, headers: { location: 'https://other.example/' } });
  } });
  await assert.rejects(client.request('https://expedia.com.evil.example/graphql'), { code: 'INVALID_ENDPOINT' });
  assert.equal(calls, 0);
  await assert.rejects(client.request('https://www.expedia.com/graphql'), e => e.code === 'HTTP_ERROR' && e.details.status === 302);
  assert.equal(calls, 1);
});
test('APQ executes exact shipped document only after a pure cache miss', async () => {
  const calls = [];
  const client = new ExpediaHttpClient({ fetchImpl: async (url, options) => {
    calls.push(JSON.parse(options.body));
    assert.equal(options.headers['x-page-id'], 'APP.UL,U,90');
    return Response.json(calls.length === 1 ? { errors: [{ message: 'PersistedQueryNotFound' }] } : { data: { result: 'ok' } });
  } });
  const result = await client.graphql({ operationName: 'IdentityLayoutQuery', group: 'auth', variables: { supplied: 'unchanged' } });
  const document = (await readFile(new URL('../src/graphql/auth/IdentityLayoutQuery.graphql', import.meta.url), 'utf8')).trimEnd();
  assert.equal(result.data.result, 'ok');
  assert.equal(calls.length, 2); assert.equal(calls[0].query, undefined);
  assert.equal(calls[1].query, document);
  assert.equal(calls[1].extensions.persistedQuery.sha256Hash, createHash('sha256').update(document).digest('hex'));
  assert.deepEqual(calls[0].variables, calls[1].variables);
});
test('network errors and partially executed mutation responses never retry', async () => {
  let calls = 0;
  const client = new ExpediaHttpClient({ fetchImpl: async () => { calls++; throw new Error('private network diagnostic'); } });
  await assert.rejects(client.request('https://www.expedia.com/graphql', { method: 'POST', body: {} }), { code: 'NETWORK_ERROR' });
  assert.equal(calls, 1);
  const partial = new ExpediaHttpClient({ fetchImpl: async () => { calls++; return Response.json({ data: { identityFormSubmit: null }, errors: [{ message: 'PersistedQueryNotFound' }] }); } });
  await partial.graphql({ operationName: 'identityFormSubmit', group: 'auth', variables: {} });
  assert.equal(calls, 2);
});

test('a rate limited auth mutation reports the server delay without replaying or discarding the session', async () => {
  let calls = 0;
  const client = new ExpediaHttpClient({ cookies: [{ name: 'EG_SESSIONTOKEN', value: 'private', domain: 'expedia.com', path: '/' }], fetchImpl: async () => {
    calls++;
    return Response.json({ error: 'Too Many Requests' }, { status: 429, headers: { 'retry-after': '120' } });
  } });
  await assert.rejects(client.graphql({ operationName: 'identityFormSubmit', group: 'auth', variables: {} }), error =>
    error.code === 'RATE_LIMITED' && error.details.retryAfterSeconds === 120);
  assert.equal(calls, 1);
  assert.equal(client.jar.header('https://www.expedia.com/'), 'EG_SESSIONTOKEN=private');
});

test('an absent or invalid retry delay stays unknown', async () => {
  for (const value of [null, 'invalid', '999999999999999999999999999999999999']) {
    const client = new ExpediaHttpClient({ fetchImpl: async () => new Response('', { status: 429, headers: value === null ? {} : { 'retry-after': value } }) });
    await assert.rejects(client.request('https://www.expedia.com/graphql'), error => error.code === 'RATE_LIMITED' && error.details.retryAfterSeconds === null);
  }
});

test('scoped card tokenization omits account cookies and ignores returned cookies', async () => {
  const client = new ExpediaHttpClient({ context: { identity: { duaid: 'same-native-device' } }, cookies: [{ name: 'account', value: 'private', domain: 'expedia.com', path: '/' }], fetchImpl: async (url, options) => {
    assert.equal(new URL(url).hostname, 'api.expedia.com');
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers['Device-User-Agent-ID'], undefined);
    return Response.json({ id: 'scoped-card-token' }, { headers: { 'set-cookie': 'account=replacement; Domain=.expedia.com; Path=/' } });
  } });
  await client.request('https://api.expedia.com/v2/edge-tokens/instruments', { method: 'POST', body: {}, includeCookies: false });
  assert.equal(client.jar.header('https://www.expedia.com/'), 'account=private');
});

test('account requests preserve the session device ID and reject header injection', async () => {
  const client = new ExpediaHttpClient({ context: { identity: { duaid: 'same-native-device' } }, fetchImpl: async (url, options) => {
    assert.equal(options.headers['Device-User-Agent-ID'], 'same-native-device');
    return Response.json({ ok: true });
  } });
  await client.request('https://www.expedia.com/graphql');
  assert.throws(() => new ExpediaHttpClient({ context: { identity: { duaid: 'id\r\nInjected:value' } } }), { code: 'INVALID_DEVICE_ID' });
});
