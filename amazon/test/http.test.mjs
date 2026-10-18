import test from 'node:test';
import assert from 'node:assert/strict';
import { AmazonClient, CookieJar } from '../src/http.mjs';

test('account cookies follow host, path, expiry and HTTPS boundaries', () => {
  const jar = new CookieJar([
    { name: 'session-id', value: 'test-session', domain: '.amazon.com', path: '/', secure: true },
    { name: 'host', value: 'only-www', domain: 'www.amazon.com', path: '/', hostOnly: true },
    { name: 'scoped', value: 'checkout-only', domain: 'www.amazon.com', path: '/checkout' },
    { name: 'expired', value: 'gone', domain: 'amazon.com', path: '/', expiresAt: Date.now() - 1000 },
    { name: 'bad', value: 'foreign-cookie', domain: 'amazon.com.example.test', path: '/' },
  ]);
  assert.equal(jar.header('https://api.amazon.com/auth/token'), 'session-id=test-session');
  assert.equal(jar.header('http://api.amazon.com/auth/token'), '');
  assert.equal(jar.header('https://www.amazon.com/checkout/review').startsWith('scoped=checkout-only;'), true);
  assert.equal(jar.header('https://www.amazon.com/checkout-other').includes('checkout-only'), false);
});

test('foreign endpoints and redirects cannot forward account credentials', async () => {
  const calls = [];
  const client = new AmazonClient({ cookies: [{ name: 'session', value: 'private-test', domain: 'amazon.com', path: '/' }], fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response('', { status: 302, headers: { location: 'https://example.test/' } });
  } });
  for (const url of ['http://www.amazon.com/', 'https://amazon.com.example.test/', 'https://user:pass@www.amazon.com/']) await assert.rejects(client.request(url), { code: 'INVALID_ENDPOINT' });
  await assert.rejects(client.request('https://www.amazon.com/'), { code: 'REDIRECT_REQUIRED' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'manual');
});

test('unknown mutation outcomes and rate limits are never automatically retried', async () => {
  let calls = 0;
  const client = new AmazonClient({ fetchImpl: async () => { calls++; throw Error('Connection lost'); } });
  await assert.rejects(client.request('https://api.amazon.com/auth/register', { method: 'POST', json: { fixture: true } }), { code: 'NETWORK_ERROR' });
  assert.equal(calls, 1);
  client.fetch = async () => { calls++; return new Response('', { status: 429 }); };
  await assert.rejects(client.request('https://api.amazon.com/auth/token'), { code: 'RATE_LIMITED' });
  assert.equal(calls, 2);
});
