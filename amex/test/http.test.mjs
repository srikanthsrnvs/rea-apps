import test from 'node:test';
import assert from 'node:assert/strict';
import { request, buildRequest, requireSuccess, API_BASE } from '../src/http.mjs';
test('native transport pins origin and paths, encodes query values, and keeps financial mutations explicit', () => {
  const wire = buildRequest({ path: '/services/payment/v3/submit', method: 'PUT', body: { value: { amount: '123.45', currency: 'USD' } } });
  assert.equal(wire.method, 'PUT'); assert.ok(wire.url.href.startsWith(API_BASE));
  assert.equal(JSON.parse(wire.body).value.amount, '123.45');
  const read = buildRequest({ path: '/services/transactions/v1/search', query: { description: 'A & B', offset: 0 } });
  assert.equal(read.url.searchParams.get('description'), 'A & B');
  for (const path of ['https://example.invalid/steal', '/services/../account', '/services/%2e%2e/account', '/services/a?auth=secret', '/services/a\\b']) assert.throws(() => buildRequest({ path }), { code: 'INVALID_REQUEST' });
});
test('missing responses never retry and redirects cannot forward an account session', async () => {
  let calls = 0;
  await assert.rejects(request({ path: '/services/payment/v3/submit', method: 'PUT', body: {} }, { fetchImpl: async () => { calls++; throw Error('lost'); } }), { code: 'NETWORK_UNCERTAIN' });
  assert.equal(calls, 1);
  const response = await request({ path: '/services/accountservicing/v1/summary', method: 'POST', body: {} }, { fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'manual'); return new Response('', { status: 302, headers: { location: 'https://example.invalid/' } });
  } });
  assert.throws(() => requireSuccess(response), { code: 'AMEX_HTTP_ERROR' });
  assert.throws(() => requireSuccess({ status: 200, headers: { 'x-axp-business-layer-status': 'FAIL' }, body: {} }), { code: 'AMEX_BUSINESS_ERROR' });
  await assert.rejects(request({ path: '/services/payment/v1/activity' }, { maxBytes: 2, fetchImpl: async () => Response.json({ secret: 'synthetic' }) }), { code: 'RESPONSE_TOO_LARGE' });
  await assert.rejects(request({ path: '/services/payment/v1/activity' }, { fetchImpl: async () => new Response('<html>') }), { code: 'NON_JSON_RESPONSE' });
});
test('streaming login stops and cancels after its first LOGIN result rather than waiting for the timeline', async () => {
  let cancelled = false;
  const source = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: LOGIN\ndata: {"status":{"success":false}}\n\n')); }, cancel() { cancelled = true; } });
  const result = await request({ path: '/services/accountservicing/streaming/v1/loginsummarytimeline', method: 'POST', body: {}, responseType: 'login-sse' }, {
    fetchImpl: async () => new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
  });
  assert.deepEqual(result.body, { status: { success: false } });
  assert.equal(cancelled, true);
});
test('native expiration headers discard apparent HTTP 200 success and require a fresh session', async () => {
  for (const header of ['x-axp-session-expired', 'x-axp-jwt-expired']) {
    const result = await request({ path: '/services/example' }, { fetchImpl: async () => new Response('{"status":{"success":true}}', { status: 200, headers: { [header]: 'true' } }) });
    assert.equal(result.status, 401); assert.equal(result.body, null);
    assert.throws(() => requireSuccess(result), { code: 'AUTH_REQUIRED' });
  }
});
