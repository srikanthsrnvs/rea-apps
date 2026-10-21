import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, request, requireSuccess } from '../src/http.mjs';

test('persisted query uses the native endpoint and changes to POST for large inputs', () => {
  const spec = { operationName: 'Account', hash: 'a'.repeat(64), variables: {} };
  const get = buildRequest(spec);
  assert.equal(get.url.origin, 'https://api.airbnb.com');
  assert.equal(get.url.pathname, '/v3');
  assert.equal(get.method, 'GET');
  assert.equal(JSON.parse(get.url.searchParams.get('extensions')).persistedQuery.sha256Hash, spec.hash);
  const post = buildRequest({ ...spec, variables: { value: 'x'.repeat(4000) } });
  assert.equal(post.method, 'POST');
  assert.equal(post.url.searchParams.has('variables'), false);
  assert.equal(post.url.searchParams.get('client_id'), '3092nxybyb0otqw18e8nh5nty');
  assert.deepEqual(JSON.parse(post.body).variables, { value: 'x'.repeat(4000) });
});

test('mutations remain POST even for small bodies', () => {
  const wire = buildRequest({ operationName: 'ExampleMutation', hash: 'a'.repeat(64), method: 'POST', variables: {} });
  assert.equal(wire.method, 'POST');
  assert.equal(wire.url.searchParams.has('variables'), false);
});

test('explicit non-dollar currencies reach the native query configuration', () => {
  const wire = buildRequest({ operationName: 'StaysSearch', hash: 'a'.repeat(64), variables: {}, currency: 'EUR' });
  assert.equal(wire.url.searchParams.get('currency'), 'EUR');
});

test('network failure is never automatically replayed', async () => {
  let calls = 0;
  await assert.rejects(request({ path: 'auth/identify/phone', method: 'POST', body: {} }, { fetchImpl: async () => { calls++; throw Error('lost'); } }), { code: 'NETWORK_UNCERTAIN' });
  assert.equal(calls, 1);
});

test('redirects are not followed and HTML is not accepted as a successful result', async () => {
  await assert.rejects(request({ path: 'autocompletes' }, { fetchImpl: async (_, options) => {
    assert.equal(options.redirect, 'manual');
    return new Response('<html>blocked</html>', { status: 403 });
  } }), { code: 'NON_JSON_RESPONSE' });
});

test('bounded response size and GraphQL errors fail explicitly', async () => {
  await assert.rejects(request({ path: 'autocompletes' }, { maxBytes: 4, fetchImpl: async () => new Response('{"a":1}') }), { code: 'RESPONSE_TOO_LARGE' });
  assert.throws(() => requireSuccess({ status: 200, body: { data: null, errors: [{ message: 'No access', extensions: { code: 'FORBIDDEN' } }] } }), { code: 'AIRBNB_GRAPHQL_ERROR' });
  assert.throws(() => requireSuccess({ status: 401, body: {} }), { code: 'AUTH_REQUIRED' });
});

test('path traversal and malformed operation hashes are rejected locally', () => {
  assert.throws(() => buildRequest({ path: '../users' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => buildRequest({ operationName: 'Account', hash: 'oops' }), { code: 'INVALID_REQUEST' });
});

test('payment GraphQL Long identifiers keep every digit on the wire without coercing opaque strings', () => {
  const variables = { input: { placeOrder: { paymentParams: { paymentQuoteId: '1801580046660776048', selectedPaymentOption: { businessEntityGroupId: '1801580046660776049', gibraltarInstrumentToken: '1801580046660776050' } } } } };
  const request = buildRequest({ operationName: 'CheckoutFulfillmentMutation', hash: 'a'.repeat(64), method: 'POST', variables });
  assert.match(request.body, /"paymentQuoteId":1801580046660776048[,}]/);
  assert.match(request.body, /"businessEntityGroupId":1801580046660776049[,}]/);
  assert.match(request.body, /"gibraltarInstrumentToken":"1801580046660776050"/);
  assert.equal(variables.input.placeOrder.paymentParams.paymentQuoteId, '1801580046660776048');
  assert.throws(() => buildRequest({ operationName: 'CheckoutFulfillmentMutation', hash: 'a'.repeat(64), method: 'POST', variables: { input: { placeOrder: { paymentParams: { paymentQuoteId: '9223372036854775808' } } } } }), { code: 'INVALID_REQUEST' });
});
