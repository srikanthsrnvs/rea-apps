import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createClient } from '../src/http.mjs';
import { parseCommand, dispatch } from '../src/cli.mjs';
import { tools } from '../src/tools.mjs';

test('transport sends only registered APQ identity and keeps native session context', async () => {
  const document = 'query TestOperation { field }';
  let request;
  const state = { deviceId: 'device-one', accessToken: 'private-token' };
  const client = createClient(state, { fetchImpl: async (url, options) => {
    request = { url, ...options };
    return Response.json({ data: { field: true } });
  } });
  assert.deepEqual(await client.graphql('TestOperation', document, { key: 'value' }), { field: true });
  const body = JSON.parse(request.body);
  assert.equal(request.url, 'https://www.instacart.com/graphql');
  assert.equal(body.extensions.persistedQuery.sha256Hash, createHash('sha256').update(document).digest('hex'));
  assert.equal(body.query, undefined);
  assert.deepEqual(body.variables, { key: 'value' });
  assert.equal(request.headers.authorization, 'Bearer private-token');
  assert.equal(request.headers['x-device-uuid'], 'device-one');
  assert.equal(request.redirect, 'manual');
});

test('uncertain mutations are never retried and private upstream text is not printed', async () => {
  let calls = 0;
  const failed = createClient({}, { fetchImpl: async () => { calls++; throw new Error('private-token'); } });
  await assert.rejects(failed.graphql('UpdateSomething', 'mutation UpdateSomething { changed }'), error => error.code === 'NETWORK_ERROR' && !error.message.includes('private-token'));
  assert.equal(calls, 1);
  const rejected = createClient({}, { fetchImpl: async () => Response.json({ errors: [{ message: 'private-token', extensions: { code: 'NOT_AUTHENTICATED' } }] }) });
  await assert.rejects(rejected.graphql('ReadSomething', 'query ReadSomething { value }'), error => error.code === 'GRAPHQL_ERROR' && !error.message.includes('private-token'));
});

test('CLI rejects unknown and duplicate flags before dispatch, preserves zero quantity', () => {
  assert.throws(() => parseCommand(['cart', 'set', '--cart-id', 'c', '--item-id', 'i', '--quantity', 'NaN']));
  assert.throws(() => parseCommand(['cart', 'create', '--shop-id', 's', '--confirm']));
  assert.throws(() => parseCommand(['search', '--shop-id', 's', '--shop-id', 'other']));
  assert.equal(parseCommand(['cart', 'set', '--cart-id', 'c', '--item-id', 'i', '--quantity', '0']).args.quantity, 0);
  assert.equal(parseCommand(['stores', '--postal-code', '90291', '--latitude', '33.9', '--longitude', '-118.4']).args.longitude, -118.4);
  const call = parseCommand(['call', 'cart_set', '--input', '{"cartId":"c","itemId":"i","quantity":0}']);
  assert.equal(call.tool.name, 'cart_set');
});

test('CLI persists a candidate token after failed validation without replacing the previous session', async () => {
  const initial = { accessToken: 'old', pendingLogin: { identifier: '4155550100', type: 'phoneNumber', countryCallingCode: '1', expiresAt: new Date(Date.now() + 60_000).toISOString() } };
  let stored;
  const store = { withStateLock: op => op(), readState: async () => structuredClone(initial), saveState: async (_, value) => { stored = structuredClone(value); } };
  const clientFactory = state => ({ graphql: async operation => {
    if (operation === 'CreateUserSessionFromPhoneNumber') return { createUserSessionFromVerificationCode: { __typename: 'UsersAuthToken', token: 'candidate' } };
    assert.equal(state.accessToken, 'candidate');
    throw Object.assign(new Error('Validation unavailable'), { code: 'NETWORK_ERROR' });
  } });
  await assert.rejects(dispatch(tools.find(tool => tool.name === 'auth_complete'), { code: '123456' }, { store, clientFactory }));
  assert.equal(stored.accessToken, 'old');
  assert.equal(stored.pendingLogin.candidateAccessToken, 'candidate');
});
