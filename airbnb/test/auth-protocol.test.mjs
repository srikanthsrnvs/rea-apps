import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuthFlow, buildAuthRequest, applyAuthResponse, publicAuthStatus,
  AUTH_FLOW_TTL_MS, AUTH_RESEND_COOLDOWN_MS, AUTH_MAX_RESENDS, AUTH_MAX_VERIFICATIONS,
} from '../src/auth-protocol.mjs';

const START = 1_000_000;
const create = (options = {}) => createAuthFlow({ email: 'alice@example.com', deviceId: 'cli-device', now: START, ...options });
const build = (flow, options = {}) => buildAuthRequest(flow, { now: START, ...options });
const apply = (flow, body, options = {}) => applyAuthResponse(flow, { status: 200, headers: {}, body, now: START, ...options });
const emailConfig = { nextStepConfig: { emailOtp: { email: 'alice@example.com', fallbackChallenges: [] } } };
const pendingIdentify = () => build(create(), { action: 'identify' }).nextFlow;
const identified = () => apply(pendingIdentify(), emailConfig);
const authentication = {
  userId_str: '123', isNewAccount: false,
  nativeTokens: { token: 'candidate-private-token', aaj: { aaj: 'private-aaj', maxAgeSecs: 3600 } },
};

test('email identification builds the observed native path and truthful client capabilities', () => {
  const flow = create({ persisted: 'persisted-private' }), before = structuredClone(flow);
  const request = build(flow, { action: 'identify' });
  assert.equal(request.path, '/v2/auth/identify/email');
  assert.equal(request.method, 'POST');
  assert.deepEqual(request.body, { steps: [{ identifyEmail: { email: 'alice@example.com' } }], appHashType: 'ANDROID', passkeySupport: { apiSupported: false, conditionalMediation: false } });
  assert.equal(request.headers['X-CSRF-Without-Token'], '1');
  assert.equal(request.headers['X-Airbnb-Auth-Entrypoint'], 'Other');
  assert.equal(request.headers['X-Airbnb-Flex-Auth-Options'], 'null');
  assert.equal(request.headers['X-Airbnb-Auth-Persisted'], 'persisted-private');
  assert.match(request.headers['X-Airbnb-Auth-Session-ID'], /^[0-9a-f-]{36}$/);
  assert.match(request.headers['X-Airbnb-Auth-Attempt'], /^[0-9a-f-]{36}$/);
  assert.equal(request.nextFlow.status, 'request_pending');
  assert.equal(request.body.appHashType, 'ANDROID');
  assert.deepEqual(flow, before);
  request.body.steps[0].identifyEmail.email = 'changed@example.com';
  assert.equal(request.nextFlow.steps[0].identifyEmail.email, 'alice@example.com');
});

test('phone validation uses a country code separately from the calling prefix', () => {
  const flow = createAuthFlow({ phone: '+1 (415) 555-0123', countryCode: 'us', now: START });
  assert.deepEqual(build(flow, { action: 'identify' }).body.steps, [{ identifyPhone: { phoneCountryCode: 'US', phoneNumber: '+14155550123' } }]);
  for (const input of [{}, { email: 'a@b' }, { email: 'alice@example.com', phone: '4155550123', countryCode: 'US' },
    { phone: '4155550123', countryCode: '+1' }, { phone: '123', countryCode: 'US' },
    { phone: '4155550123', countryCode: 'US' }, { phone: '(415) 555-0123', countryCode: 'US' },
    { phone: '+0123456789', countryCode: 'US' }, { phone: '+1234567890123456', countryCode: 'US' },
    { phone: '4155550123\n', countryCode: 'US' }, { email: 'a\r\n@b.com' },
    { email: 'a@example.com', countryCode: 'US' }]) {
    assert.throws(() => createAuthFlow(input), { code: 'INVALID_ARGUMENT' });
  }
  assert.throws(() => create({ persisted: 'bad\r\nheader' }), { code: 'INVALID_AUTH_CONTEXT' });
});

test('bare national numbers in persisted flows cannot produce an identify request', () => {
  const flow = createAuthFlow({ phone: '+14155550123', countryCode: 'US', now: START });
  flow.identifier.phoneNumber = '4155550123';
  const before = structuredClone(flow);
  assert.throws(() => build(flow, { action: 'identify' }), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(flow, before);
});

test('a complete server phone destination must match the requested international number', () => {
  const start = createAuthFlow({ phone: '+14155550123', countryCode: 'US', now: START });
  const pending = build(start, { action: 'identify' }).nextFlow;
  const wrong = apply(pending, { nextStepConfig: { smsOtp: { phoneNumber: '+41 4155550123' } } });
  assert.equal(wrong.status, 'action_required');
  assert.equal(wrong.error, 'AUTH_DESTINATION_MISMATCH');
  assert.deepEqual(publicAuthStatus(wrong, { now: START }).requiredSteps, ['destination_mismatch']);
  assert.throws(() => build(wrong, { action: 'verify', code: '001234' }), { code: 'AUTH_ACTION_REQUIRED' });
  assert.throws(() => build(wrong, { action: 'resend', now: START + AUTH_RESEND_COOLDOWN_MS }), { code: 'AUTH_ACTION_REQUIRED' });
  for (const phoneNumber of ['+1 (415) 555-0123', '***0123']) {
    assert.equal(apply(pending, { nextStepConfig: { smsOtp: { phoneNumber } } }).status, 'code_required');
  }
});

test('identifier and OTP inputs are checked before any state change', () => {
  const flow = identified(), before = structuredClone(flow);
  for (const code of [123456, '12345', '1234567', '12 3456', '１２３４５６', '12345\n', null]) {
    assert.throws(() => build(flow, { action: 'verify', code }), { code: 'INVALID_VERIFICATION_CODE' });
    assert.deepEqual(flow, before);
  }
  const corrupt = structuredClone(flow);
  corrupt.identifier.email = 'invalid';
  assert.throws(() => build(corrupt, { action: 'verify', code: '001234' }), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(flow, before);
});

test('server auth headers persist case-insensitively and OTP keeps leading zeros and history', () => {
  const flow = apply(pendingIdentify(), emailConfig, { headers: new Headers({ 'x-airbnb-set-auth-persisted': 'opaque-persisted', 'X-Airbnb-Set-Auth-Session': 'opaque-session' }) });
  assert.equal(flow.status, 'code_required');
  assert.deepEqual(flow.availableMethods, ['email']);
  const request = build(flow, { action: 'verify', code: '001234' });
  assert.equal(request.path, '/v2/auth/authenticate/email_otp');
  assert.deepEqual(request.body.steps, [{ identifyEmail: { email: 'alice@example.com' } }, { emailOtpChallenge: { otp: '001234' } }]);
  assert.equal(request.headers['X-Airbnb-Auth-Persisted'], 'opaque-persisted');
  assert.equal(request.headers['X-Airbnb-Auth-Session'], 'opaque-session');
  assert.equal(request.nextFlow.authAttemptId, flow.authAttemptId);
});

test('public status is an allowlist and never exposes code, opaque flow data, or candidate credentials', () => {
  const request = build(identified(), { action: 'verify', code: '001234' });
  const pending = publicAuthStatus(request.nextFlow, { now: START });
  assert.equal(pending.destination, 'a***@example.com');
  const result = apply(request.nextFlow, { nextStepConfig: { closeModal: {} }, authentication });
  const output = JSON.stringify(publicAuthStatus(result, { now: START }));
  for (const secret of ['001234', 'candidate-private-token', 'private-aaj', result.authSessionId, result.authAttemptId]) assert.equal(output.includes(secret), false);
  assert.equal(result.status, 'validation_required');
  assert.equal(result.authenticated, false);
  assert.deepEqual(result.candidateTokens, authentication.nativeTokens);
  assert.equal(result.userId, '123');
  assert.deepEqual(result.steps, []);
  assert.equal(JSON.parse(output).validationRequired, true);
  assert.throws(() => build(result, { action: 'verify', code: '001234' }), { code: 'AUTH_ACTION_REQUIRED' });
});

test('unknown and additional challenges cannot be mistaken for login success even with tokens', () => {
  for (const nextStepConfig of [{ airlock: { token: 'server-secret' } }, { newUnknownChallenge: { token: 'server-secret' } },
    { signupForm: {} }, { smsOtp: {}, emailOtp: {} }, { passkey: { challenge: 'private' } }]) {
    const result = apply(pendingIdentify(), { nextStepConfig, authentication });
    assert.equal(result.status, 'action_required');
    assert.equal(result.candidateTokens, null);
    assert.equal(result.authenticated, false);
    assert.equal(JSON.stringify(publicAuthStatus(result, { now: START })).includes('server-secret'), false);
    assert.throws(() => build(result, { action: 'verify', code: '001234' }), { code: 'AUTH_ACTION_REQUIRED' });
  }
  const nextOTP = apply(pendingIdentify(), { nextStepConfig: { smsOtp: { fallbackChallenges: [] } }, authentication });
  assert.equal(nextOTP.status, 'code_required');
  assert.equal(nextOTP.candidateTokens, null);
});

test('HTTP success, closeModal, and malformed token responses require more evidence', () => {
  for (const body of [null, [], {}, { nextStepConfig: {} }, { nextStepConfig: { closeModal: {} } },
    { authentication }, { nextStepConfig: {}, authentication: { ...authentication, nativeTokens: { token: 'token-only' } } }]) {
    const result = apply(pendingIdentify(), body);
    assert.equal(result.status, 'action_required');
    assert.equal(result.candidateTokens, null);
  }
  const error = apply(pendingIdentify(), { nextStepConfig: {}, authentication, errorCode: 42 });
  assert.equal(error.status, 'denied');
  assert.equal(error.candidateTokens, null);
  assert.equal(apply(pendingIdentify(), { nextStepConfig: {}, authentication, errorCode: null }).status, 'validation_required');
});

test('rejected codes roll back the failed OTP step before an explicit retry', () => {
  const pending = build(identified(), { action: 'verify', code: '001234' }).nextFlow;
  const rejected = apply(pending, { ...emailConfig, errorCode: 7, error: { message: 'wrong private 001234' } }, { status: 400 });
  assert.equal(rejected.status, 'code_required');
  assert.equal(rejected.error, 'AUTH_VERIFICATION_REJECTED');
  assert.equal(rejected.steps.length, 1);
  const retry = build(rejected, { action: 'verify', code: '009876' });
  assert.equal(retry.body.steps.length, 2);
  assert.equal(retry.body.steps.at(-1).emailOtpChallenge.otp, '009876');
  assert.equal(JSON.stringify(publicAuthStatus(rejected, { now: START })).includes('001234'), false);
});

test('explicit resend reuses history and changes the attempt ID after the local cooldown', () => {
  const flow = identified();
  assert.throws(() => build(flow, { action: 'resend' }), { code: 'AUTH_RESEND_COOLDOWN' });
  const request = build(flow, { action: 'resend', now: START + AUTH_RESEND_COOLDOWN_MS });
  assert.equal(request.path, '/v2/auth/challenge/email_otp');
  assert.deepEqual(request.body.steps, flow.steps);
  assert.equal(request.body.source, 'RESEND_OTP');
  assert.notEqual(request.nextFlow.authAttemptId, flow.authAttemptId);
  assert.equal(request.nextFlow.resendCount, 1);
  assert.equal(flow.resendCount, 0);
  assert.throws(() => build(request.nextFlow, { action: 'resend', now: START + AUTH_RESEND_COOLDOWN_MS }), { code: 'AUTH_REQUEST_PENDING' });
});

test('fallback methods come exclusively from a single server challenge variant', () => {
  const server = { nextStepConfig: { smsOtp: { phoneNumber: '***0123', fallbackChallenges: [
    { voiceOtp: { phoneNumber: '***0123' } }, { whatsAppOtp: { phoneNumber: '***0123' } },
    { emailOtp: {}, captcha: {} }, { password: {} }, { newUnknown: {} },
  ] } } };
  const flow = apply(pendingIdentify(), server);
  assert.deepEqual(flow.availableMethods, ['sms', 'voice', 'whatsapp']);
  assert.throws(() => build(flow, { action: 'verify', method: 'voice', code: '001234' }), { code: 'AUTH_METHOD_NOT_ACTIVE' });
  assert.throws(() => build(flow, { action: 'resend', method: 'email', now: START + AUTH_RESEND_COOLDOWN_MS }), { code: 'AUTH_METHOD_UNAVAILABLE' });
  const request = build(flow, { action: 'resend', method: 'voice', now: START + AUTH_RESEND_COOLDOWN_MS });
  assert.equal(request.path, '/v2/auth/challenge/voice_otp');
  assert.equal(request.body.source, 'FALLBACK');
  assert.deepEqual(request.body.steps.at(-1), { challengeRequested: { challenge: { voiceOtp: { phoneNumber: '***0123' } } } });
  const voice = apply(request.nextFlow, { nextStepConfig: { voiceOtp: { fallbackChallenges: [] } } }, { now: START + AUTH_RESEND_COOLDOWN_MS });
  assert.equal(build(voice, { action: 'verify', code: '001234', now: START + AUTH_RESEND_COOLDOWN_MS }).path, '/v2/auth/authenticate/voice_otp');
});

test('SMS and WhatsApp verification use their exact DTO and path', () => {
  for (const [config, path, step] of [['smsOtp', 'sms_otp', 'smsOtpChallenge'], ['whatsAppOtp', 'whatsapp_otp', 'whatsAppOtpChallenge']]) {
    const flow = apply(pendingIdentify(), { nextStepConfig: { [config]: { fallbackChallenges: [] } } });
    const request = build(flow, { action: 'verify', code: '000001' });
    assert.equal(request.path, `/v2/auth/authenticate/${path}`);
    assert.deepEqual(request.body.steps.at(-1), { [step]: { otp: '000001' } });
  }
});

test('local and explicit server expiry prevent reuse and remove private OTPs and candidates', () => {
  const pending = build(identified(), { action: 'verify', code: '001234' }).nextFlow;
  const end = START + AUTH_FLOW_TTL_MS;
  assert.throws(() => build(identified(), { action: 'verify', code: '001234', now: end }), { code: 'AUTH_FLOW_EXPIRED' });
  const result = apply(pending, { nextStepConfig: {}, authentication }, { now: end });
  assert.equal(result.status, 'expired');
  assert.equal(result.candidateTokens, null);
  assert.deepEqual(result.steps, []);
  assert.equal(publicAuthStatus(pending, { now: end }).status, 'expired');
  for (const status of [410, 419, 440]) assert.equal(apply(pending, emailConfig, { status }).status, 'expired');
});

test('rate limiting respects Retry-After and never issues an automatic resend', () => {
  const pending = build(identified(), { action: 'verify', code: '001234' }).nextFlow;
  const flow = apply(pending, { message: 'private server message' }, { status: 429, headers: { 'Retry-After': '60' } });
  assert.equal(flow.status, 'rate_limited');
  assert.equal(flow.retryAt, START + 60_000);
  assert.equal(flow.steps.length, 1);
  assert.equal(flow.resendCount, 0);
  assert.throws(() => build(flow, { action: 'verify', code: '001234', now: START + 59_999 }), { code: 'AUTH_RATE_LIMITED' });
  assert.equal(build(flow, { action: 'verify', code: '001234', now: START + 60_000 }).path, '/v2/auth/authenticate/email_otp');
  const initial = apply(pendingIdentify(), {}, { status: 429, headers: { 'retry-after': '1' } });
  assert.equal(build(initial, { action: 'identify', now: START + 1_000 }).path, '/v2/auth/identify/email');
});

test('explicit resend and verification attempts have finite local limits', () => {
  let flow = identified(), now = START;
  for (let index = 0; index < AUTH_MAX_RESENDS; index += 1) {
    now += AUTH_RESEND_COOLDOWN_MS;
    flow = apply(build(flow, { action: 'resend', now }).nextFlow, emailConfig, { now });
  }
  assert.throws(() => build(flow, { action: 'resend', now: now + AUTH_RESEND_COOLDOWN_MS }), { code: 'AUTH_RESEND_LIMIT' });
  assert.equal(publicAuthStatus(flow, { now }).resendsRemaining, 0);
  flow = identified();
  for (let index = 0; index < AUTH_MAX_VERIFICATIONS; index += 1) {
    flow = apply(build(flow, { action: 'verify', code: '001234' }).nextFlow, { ...emailConfig, errorCode: 7 }, { status: 400 });
  }
  assert.throws(() => build(flow, { action: 'verify', code: '001234' }), { code: 'AUTH_ATTEMPT_LIMIT' });
});

test('bad headers and unsolicited responses are rejected without mutation or server detail leaks', () => {
  const flow = pendingIdentify(), before = structuredClone(flow);
  assert.throws(() => apply(flow, emailConfig, { headers: { 'X-Airbnb-Set-Auth-Session': 'x\r\nInjected: y' } }), { code: 'INVALID_AUTH_CONTEXT' });
  assert.deepEqual(flow, before);
  assert.throws(() => apply(create(), emailConfig), { code: 'AUTH_RESPONSE_UNEXPECTED' });
  const denied = apply(flow, { message: 'secret-token-or-code' }, { status: 500 });
  assert.equal(denied.status, 'denied');
  assert.equal(JSON.stringify(publicAuthStatus(denied, { now: START })).includes('secret-token-or-code'), false);
});

test('successive verification steps retain history privately but public status cannot reveal codes', () => {
  const first = build(identified(), { action: 'verify', code: '001234' });
  const second = apply(first.nextFlow, { nextStepConfig: { smsOtp: { fallbackChallenges: [] } } });
  const request = build(second, { action: 'verify', code: '005678' });
  assert.equal(request.body.steps.length, 3);
  assert.equal(request.body.steps[1].emailOtpChallenge.otp, '001234');
  const output = JSON.stringify(publicAuthStatus(request.nextFlow, { now: START }));
  assert.equal(output.includes('001234'), false);
  assert.equal(output.includes('005678'), false);
});
