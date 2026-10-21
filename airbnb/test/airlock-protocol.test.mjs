import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAirlock, airlockWidget, buildAirlockQuery, buildAirlockStatus, buildAirlockSubmit, parseAirlockSubmit, requireAirlockReplay } from '../src/airlock-protocol.mjs';
const airlock = { id: 'QWlybG9jazotMTIz', internalAirlockId: '-123', airlockWebviewUrl: 'https://www.airbnb.com/airlock?al_id=-123&locale=en', flow: 'CAPTCHA_FLOW',
  viewPayload: { frictionView: 'ARKOSE_BOT_DETECTION', frictionData: { publicKey: '2F0D6CB5-ACAC-4EA9-9B2A-A5F90A2DF15E', encodedDataPayload: 'opaque-server-blob' } } };
test('verification preserves opaque and signed identifiers separately', () => {
  assert.equal(extractAirlock({ status: 200, body: {} }), null);
  assert.deepEqual(extractAirlock({ status: 420, body: { client_error_info: { airlockV2: airlock } } }), airlock);
  assert.deepEqual(buildAirlockStatus(airlock), { path: 'airlocks/-123' });
  assert.deepEqual(buildAirlockQuery(airlock).variables, { airlockId: airlock.id });
  assert.deepEqual(airlockWidget(airlock), { publicKey: airlock.viewPayload.frictionData.publicKey, dataExchangeBlob: 'opaque-server-blob' });
});
test('native submit sends the full genuine token and requires matching successful response', () => {
  const token = 'genuine-test-token|with|full|suffix';
  const request = buildAirlockSubmit(airlock, token);
  assert.equal(request.method, 'POST');
  assert.equal(request.operationName, 'AirlockArkoseBotDetectionSubmitToken');
  assert.deepEqual(request.variables, { payload: { airlockId: airlock.id, sessionToken: token } });
  const result = { data: { airlockArkoseBotDetectionSubmitToken: { airlock, errors: [] } } };
  assert.deepEqual(parseAirlockSubmit(result, airlock), airlock);
  assert.throws(() => parseAirlockSubmit({ data: { airlockArkoseBotDetectionSubmitToken: { airlock: { ...airlock, id: 'other' }, errors: [] } } }, airlock), { code: 'VERIFICATION_REJECTED' });
  assert.throws(() => buildAirlockSubmit(airlock, token + '\n'), { code: 'INVALID_VERIFICATION_TOKEN' });
});
test('page completion does not authorize replay without matching satisfied API state', () => {
  for (const response of [{}, { airlock: { id: -123, status: 1, should_replay_request: true } }, { airlock: { id: -124, status: 2, should_replay_request: true } }, { airlock: { id: -123, status: 2, should_replay_request: false } }]) {
    assert.throws(() => requireAirlockReplay(response, airlock), { code: 'VERIFICATION_INCOMPLETE' });
  }
  assert.deepEqual(requireAirlockReplay({ airlock: { id: -123, status: 2, should_replay_request: true } }, airlock), { 'x-airbnb-replay-airlock-id': '-123' });
});
test('unexpected verification hosts and unsupported frictions fail locally', () => {
  for (const url of ['https://evil.example/airlock?al_id=-123', 'https://www.airbnb.com/airlock?al_id=-124', 'https://www.airbnb.com.evil.example/airlock?al_id=-123']) {
    assert.throws(() => extractAirlock({ status: 420, body: { client_error_info: { airlockV2: { ...airlock, airlockWebviewUrl: url } } } }), { code: 'INVALID_AIRLOCK' });
  }
  assert.throws(() => airlockWidget({ ...airlock, flow: 'UNKNOWN' }), { code: 'UNSUPPORTED_VERIFICATION' });
});
