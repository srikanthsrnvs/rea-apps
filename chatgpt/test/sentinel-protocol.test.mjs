import test from 'node:test';
import assert from 'node:assert/strict';
import { chatRequirementsRequest, parseChatRequirements, sentinelHeaders } from '../src/sentinel-protocol.mjs';

test('native requirements request uses an empty JSON object and separate authenticated client', () => {
  assert.deepEqual(chatRequirementsRequest(), { method: 'POST', path: 'sentinel/chat-requirements', body: {} });
});

test('requirements token can be attached without inventing an integrity payload', () => {
  const requirements = parseChatRequirements({ token: 'opaque-server-token' });
  assert.deepEqual(sentinelHeaders(requirements), { 'OpenAI-Sentinel-Chat-Requirements-Token': 'opaque-server-token' });
  assert.deepEqual(sentinelHeaders(requirements, { integrityPayload: 'opaque-provider-payload' }), {
    'OpenAI-Sentinel-Chat-Requirements-Token': 'opaque-server-token', 'X-Sentinel-Payload': 'opaque-provider-payload',
  });
});

test('server-required verification stops header preparation and does not leak the token in the error', () => {
  const requirements = parseChatRequirements({ token: 'private-value', turnstile: { required: true }, future: { nested: { required: true } } });
  assert.deepEqual(requirements.requiredChallenges, ['turnstile', 'future.nested']);
  assert.throws(() => sentinelHeaders(requirements), error => {
    assert.equal(error.code, 'VERIFICATION_REQUIRED');
    assert.ok(!JSON.stringify(error).includes('private-value'));
    return true;
  });
});

test('empty and header-injecting tokens or payloads are rejected', () => {
  for (const token of [null, 3, '', '   ', 'value\r\nInjected: true']) {
    assert.throws(() => parseChatRequirements({ token }), { code: 'INVALID_SENTINEL_RESPONSE' });
  }
  assert.throws(() => sentinelHeaders(parseChatRequirements({ token: 'valid' }), { integrityPayload: 'x\nInjected: true' }), { code: 'INVALID_SENTINEL_RESPONSE' });
});
