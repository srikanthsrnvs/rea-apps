import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthFlow, buildAuthRequest, applyAuthResponse, publicAuthStatus } from '../src/auth-protocol.mjs';
import { createAirlockCheckpoint, buildAirlockResume } from '../src/airlock-flow.mjs';

const NOW = 1_000_000;
const CODE = '001234';
const airlock = { id: 'QWlybG9jazotMTIz', internalAirlockId: '-123',
  airlockWebviewUrl: 'https://www.airbnb.com/airlock?al_id=-123&locale=en',
  flow: 'CAPTCHA_FLOW', viewPayload: { frictionView: 'ARKOSE_BOT_DETECTION',
    frictionData: { encodedDataPayload: 'private-challenge-blob' } } };
const challenged = () => ({ status: 420, headers: {}, body: { error_message: 'private-server-message',
  client_error_info: { airlockV2: structuredClone(airlock) } } });
const satisfied = () => ({ airlock: { id: -123, status: 2, should_replay_request: true } });
function pending(action = 'identify') {
  const initial = createAuthFlow({ phone: '+14155550123', countryCode: 'US', persisted: 'private-persisted', now: NOW });
  let request = buildAuthRequest(initial, { action: 'identify', now: NOW });
  if (action !== 'identify') {
    const identified = applyAuthResponse(request.nextFlow, { status: 200, headers: {}, now: NOW,
      body: { nextStepConfig: { smsOtp: { phoneNumber: '+14155550123', fallbackChallenges: [] } } } });
    request = buildAuthRequest(identified, { action, ...(action === 'verify' ? { code: CODE } : {}), now: NOW + 30_000 });
  }
  const { nextFlow: flow, ...spec } = request;
  return { flow, spec };
}
function checkpoint(action) {
  const { flow, spec } = pending(action);
  return createAirlockCheckpoint(flow, spec, challenged(), { now: NOW + 30_000 });
}
function assertFrozen(value) {
  if (value && typeof value === 'object') {
    assert.ok(Object.isFrozen(value));
    Object.values(value).forEach(assertFrozen);
  }
}

test('only a real HTTP420 Airlock creates a checkpoint', () => {
  for (const response of [undefined, { status: 200 }, { status: 420, body: {} }, { status: 429, body: challenged().body }]) {
    assert.equal(createAirlockCheckpoint(null, null, response), null);
  }
  const { flow, spec } = pending();
  const result = createAirlockCheckpoint(flow, spec, challenged(), { now: NOW });
  assert.equal(result.phase, 'waiting');
  assert.equal(result.expiresAt, flow.expiresAt);
  assert.deepEqual(result.flow, flow);
  assert.deepEqual(result.request, spec);
  assert.deepEqual(result.airlock, airlock);
  assert.equal(result.error_message, undefined);
});

test('checkpoint recursively clones and freezes request, flow and challenge without mutating inputs', () => {
  const { flow, spec } = pending('verify'), response = challenged();
  const before = structuredClone({ flow, spec, response });
  const result = createAirlockCheckpoint(flow, spec, response, { now: NOW + 30_000 });
  assert.deepEqual({ flow, spec, response }, before);
  assertFrozen(result);
  assert.notEqual(result.flow, flow);
  assert.notEqual(result.request.body, spec.body);
  assert.notEqual(result.airlock.viewPayload, response.body.client_error_info.airlockV2.viewPayload);
  spec.body.steps[1].smsOtpChallenge.otp = '999999';
  flow.authAttemptId = 'changed';
  response.body.client_error_info.airlockV2.internalAirlockId = '-999';
  assert.equal(result.request.body.steps[1].smsOtpChallenge.otp, CODE);
  assert.equal(result.flow.authAttemptId, before.flow.authAttemptId);
  assert.equal(result.airlock.internalAirlockId, '-123');
  assert.throws(() => { result.request.body.steps[1].smsOtpChallenge.otp = '999999'; }, TypeError);
});

test('resume returns the exact original request with only the replay header added', () => {
  for (const action of ['identify', 'verify', 'resend']) {
    const saved = checkpoint(action), before = structuredClone(saved);
    const { request: spec, nextCheckpoint } = buildAirlockResume(saved, satisfied(), { now: NOW + 40_000 });
    assert.deepEqual(spec, { ...saved.request, headers: { ...saved.request.headers, 'x-airbnb-replay-airlock-id': '-123' } });
    assert.deepEqual(nextCheckpoint.flow, saved.flow);
    assert.deepEqual(nextCheckpoint.request, saved.request);
    assert.equal(nextCheckpoint.phase, 'replay_pending');
    assert.equal(nextCheckpoint.replayStartedAt, NOW + 40_000);
    assert.equal(spec.headers['X-Airbnb-Auth-Attempt'], saved.flow.authAttemptId);
    assert.equal(spec.headers['X-Airbnb-Auth-Session-ID'], saved.flow.authSessionId);
    assert.deepEqual(saved, before);
    assertFrozen(spec); assertFrozen(nextCheckpoint);
  }
});

test('the next checkpoint cannot be replayed twice or recycled with a new challenge', () => {
  const saved = checkpoint();
  const { request: spec, nextCheckpoint } = buildAirlockResume(saved, satisfied(), { now: NOW + 40_000 });
  assert.throws(() => buildAirlockResume(nextCheckpoint, satisfied(), { now: NOW + 50_000 }), { code: 'AIRLOCK_REPLAY_PENDING' });
  assert.throws(() => createAirlockCheckpoint(saved.flow, spec, challenged(), { now: NOW + 50_000 }), { code: 'AIRLOCK_ALREADY_REPLAYED' });
});

test('booking, payment, traversal, GraphQL overrides and unknown auth paths are rejected', () => {
  const { flow, spec } = pending();
  for (const path of ['reservations', '/v2/payments', 'auth/authenticate/password',
    '/v2/auth/identify/phone?override=true', '/v2/auth/identify/../payments', '//auth/identify/phone',
    'https://api.airbnb.com/v2/auth/identify/phone']) {
    assert.throws(() => createAirlockCheckpoint(flow, { ...spec, path }, challenged(), { now: NOW }), { code: 'AIRLOCK_ROUTE_UNSUPPORTED' });
  }
  for (const override of [{ method: 'GET' }, { operationName: 'BookingMutation' }, { query: { override: 'payments' } }]) {
    assert.throws(() => createAirlockCheckpoint(flow, { ...spec, ...override }, challenged(), { now: NOW }), { code: 'AIRLOCK_ROUTE_UNSUPPORTED' });
  }
});

test('the shipped legacy phone code-request route is allowed without expanding the route family', () => {
  const { flow } = pending();
  const spec = { path: 'phone_one_time_passwords', method: 'POST', body: {
    workFlow: 'GLOBAL_SIGNUP_LOGIN', phoneNumber: '+14155550123', otpMethod: 'AUTO', appHashType: 'ANDROID' } };
  const saved = createAirlockCheckpoint(flow, spec, challenged(), { now: NOW });
  assert.deepEqual(buildAirlockResume(saved, satisfied(), { now: NOW + 1 }).request.body, spec.body);
  assert.throws(() => createAirlockCheckpoint(flow, { ...spec, path: 'authentications' }, challenged(), { now: NOW }), { code: 'AIRLOCK_ROUTE_UNSUPPORTED' });
});

test('the blocked modern request must match its session, attempt, action and exact steps', () => {
  const { flow, spec } = pending('verify');
  for (const altered of [
    { ...spec, headers: { ...spec.headers, 'X-Airbnb-Auth-Attempt': 'other-attempt' } },
    { ...spec, headers: { ...spec.headers, 'X-Airbnb-Auth-Session-ID': 'other-session' } },
    { ...spec, body: { ...spec.body, steps: [] } },
    { ...spec, path: '/v2/auth/identify/phone' },
  ]) assert.throws(() => createAirlockCheckpoint(flow, altered, challenged(), { now: NOW + 30_000 }), { code: 'AUTH_REQUEST_MISMATCH' });
});

test('unsatisfied state, wrong IDs and missing replay authorization cannot resume', () => {
  const saved = checkpoint('verify');
  for (const status of [{}, { airlock: { id: -124, status: 2, should_replay_request: true } },
    { airlock: { id: -123, status: 1, should_replay_request: true } },
    { airlock: { id: -123, status: 2, should_replay_request: false } }]) {
    assert.throws(() => buildAirlockResume(saved, status, { now: NOW + 40_000 }), { code: 'VERIFICATION_INCOMPLETE' });
  }
});

test('expiry and nonpending state prevent checkpoint creation and resume', () => {
  const saved = checkpoint();
  assert.throws(() => buildAirlockResume(saved, satisfied(), { now: saved.expiresAt }), { code: 'AUTH_FLOW_EXPIRED' });
  assert.throws(() => createAirlockCheckpoint(saved.flow, saved.request, challenged(), { now: saved.expiresAt }), { code: 'AUTH_FLOW_EXPIRED' });
  assert.throws(() => createAirlockCheckpoint({ ...saved.flow, status: 'code_required' }, saved.request, challenged(), { now: NOW + 30_000 }), { code: 'INVALID_AIRLOCK_CHECKPOINT' });
  assert.throws(() => buildAirlockResume({ ...saved, expiresAt: saved.expiresAt + 1 }, satisfied(), { now: NOW + 40_000 }), { code: 'INVALID_AIRLOCK_CHECKPOINT' });
});

test('loaded checkpoints revalidate the official handoff and never expose private values in errors', () => {
  const saved = checkpoint('verify');
  const altered = structuredClone(saved);
  altered.airlock.airlockWebviewUrl = 'https://untrusted.example/airlock?al_id=-123';
  assert.throws(() => buildAirlockResume(altered, satisfied(), { now: NOW + 40_000 }), { code: 'INVALID_AIRLOCK' });
  let error;
  try { buildAirlockResume(saved, { airlock: { id: -124, status: 2, should_replay_request: true,
    token: 'private-result-token', otp: CODE } }, { now: NOW + 40_000 }); } catch (caught) { error = caught; }
  assert.ok(error);
  const publicError = JSON.stringify({ name: error.name, code: error.code, message: error.message, details: error.details });
  for (const secret of [CODE, 'private-persisted', 'private-challenge-blob', 'private-result-token', '+14155550123']) {
    assert.ok(!publicError.includes(secret));
    assert.ok(!JSON.stringify(publicAuthStatus(saved.flow, { now: NOW + 30_000 })).includes(secret));
  }
});
