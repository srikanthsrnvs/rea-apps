import test from 'node:test';
import assert from 'node:assert/strict';
import { readText, requestJson, send } from '../src/http.mjs';

test('JSON requests preserve the payload and do not follow credential-bearing redirects', async () => {
  let called;
  const result = await requestJson('https://example.test/api', { method: 'POST', json: { text: 'hello' },
    headers: { authorization: 'Bearer private-token' }, fetcher: async (url, options) => {
      called = { url, ...options };
      return new Response('{"ok":true}');
    } });
  assert.deepEqual(result, { ok: true });
  assert.equal(called.redirect, 'manual');
  assert.equal(called.headers.get('content-type'), 'application/json');
  assert.equal(called.body, '{"text":"hello"}');
});

test('a rejected mutation is never retried and secrets in server bodies are not exposed', async () => {
  let calls = 0;
  await assert.rejects(requestJson('https://example.test/api', { method: 'POST', json: {}, fetcher: async () => {
    calls += 1;
    return new Response('{"error":{"code":"denied","message":"private-token email@example.test"}}', { status: 403 });
  } }), error => {
    assert.equal(error.code, 'HTTP_ERROR');
    assert.equal(error.details.serverCode, 'denied');
    assert.doesNotMatch(JSON.stringify(error), /private-token|email@example/);
    return true;
  });
  assert.equal(calls, 1);
});

test('network errors mark mutation outcomes unknown without leaking fetch details', async () => {
  await assert.rejects(send('https://example.test/api', { method: 'POST', fetcher: async () => { throw new Error('secret-url-token'); } }), error => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.details.outcome, 'unknown');
    assert.doesNotMatch(error.message, /secret-url-token/);
    return true;
  });
});

test('response limits and verification challenges produce actionable errors', async () => {
  await assert.rejects(readText(new Response('12345'), { maxBytes: 4 }), { code: 'RESPONSE_TOO_LARGE' });
  await assert.rejects(send('https://example.test/api', { fetcher: async () => new Response('<html>challenge</html>', {
    status: 403, headers: { 'cf-mitigated': 'challenge' },
  }) }), { code: 'VERIFICATION_REQUIRED' });
});
