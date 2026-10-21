import { AirbnbError } from './errors.mjs';
import { publicAuthStatus } from './auth-protocol.mjs';
import { extractAirlock, requireAirlockReplay } from './airlock-protocol.mjs';

const OTP_METHODS = ['email_otp', 'sms_otp', 'voice_otp', 'whatsapp_otp'];
const AUTH_ROUTES = new Map([
  ['auth/identify/email', 'identify'], ['auth/identify/phone', 'identify'],
  ...OTP_METHODS.map(method => [`auth/challenge/${method}`, 'resend']),
  ...OTP_METHODS.map(method => [`auth/authenticate/${method}`, 'verify']),
  // Shipped PhoneOTPRequest.forRequestVerificationCode; no booking routes.
  ['phone_one_time_passwords', 'legacy_code_request'],
]);
const SPEC_KEYS = new Set(['path', 'method', 'headers', 'body', 'query', 'currency']);
const REPLAY_HEADER = 'x-airbnb-replay-airlock-id';

function fail(code, message) { throw new AirbnbError(code, message); }
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function clock(now) {
  if (!Number.isSafeInteger(now) || now < 0) fail('INVALID_ARGUMENT', 'Provide a valid verification clock value.');
  return now;
}
function copy(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value, (_key, item) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol'
        || (typeof item === 'number' && !Number.isFinite(item))) throw new Error();
      return item;
    });
  } catch { fail('INVALID_AIRLOCK_CHECKPOINT', 'The verification checkpoint must contain JSON data.'); }
  if (!encoded || encoded.length > 1_048_576) fail('INVALID_AIRLOCK_CHECKPOINT', 'The verification checkpoint is invalid or too large.');
  return JSON.parse(encoded);
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function headerEntries(headers = {}) {
  if (!record(headers)) fail('INVALID_AIRLOCK_CHECKPOINT', 'The original auth headers are invalid.');
  const result = new Map();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || result.has(lower)
      || typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) {
      fail('INVALID_AIRLOCK_CHECKPOINT', 'The original auth headers are invalid.');
    }
    result.set(lower, value);
  }
  return result;
}
function validateFlow(flow, now) {
  try { publicAuthStatus(flow, { now }); }
  catch { fail('INVALID_AIRLOCK_CHECKPOINT', 'The original sign-in state is invalid.'); }
  if (now >= flow.expiresAt || flow.status === 'expired') fail('AUTH_FLOW_EXPIRED', 'This sign-in flow expired. Start a new sign-in.');
  if (flow.createdAt > now || flow.status !== 'request_pending' || !record(flow.pendingRequest)
    || !Array.isArray(flow.pendingRequest.previousSteps)) {
    fail('INVALID_AIRLOCK_CHECKPOINT', 'The checkpoint needs the original pending sign-in request.');
  }
}
function validateSpec(flow, spec) {
  if (!record(spec) || Object.keys(spec).some(key => !SPEC_KEYS.has(key))
    || typeof spec.path !== 'string' || spec.method !== 'POST' || !record(spec.body)
    || (spec.query !== undefined && (!record(spec.query) || Object.keys(spec.query).length > 0))) {
    fail('AIRLOCK_ROUTE_UNSUPPORTED', 'Only an original supported sign-in POST can be resumed.');
  }
  const route = spec.path.replace(/^\/?v2\//, '').replace(/^\//, '');
  const action = AUTH_ROUTES.get(route);
  if (!action) fail('AIRLOCK_ROUTE_UNSUPPORTED', 'Only an original supported sign-in POST can be resumed.');
  const headers = headerEntries(spec.headers);
  if (headers.has(REPLAY_HEADER)) fail('AIRLOCK_ALREADY_REPLAYED', 'This request already contains verification replay context.');
  if (action === 'legacy_code_request') {
    if (!['identify', 'resend'].includes(flow.pendingRequest.action)) {
      fail('AUTH_REQUEST_MISMATCH', 'The original request does not match the pending sign-in state.');
    }
  } else if (flow.pendingRequest.action !== action
    || headers.get('x-airbnb-auth-session-id') !== flow.authSessionId
    || headers.get('x-airbnb-auth-attempt') !== flow.authAttemptId
    || JSON.stringify(spec.body.steps) !== JSON.stringify(flow.steps)) {
    fail('AUTH_REQUEST_MISMATCH', 'The original request does not match the pending sign-in state.');
  }
}

/** Private checkpoint: contains OTPs, opaque headers and challenge data. Never print it. */
export function createAirlockCheckpoint(flow, spec, response, { now = Date.now() } = {}) {
  if (!record(response) || response.status !== 420) return null;
  const airlock = extractAirlock(response);
  if (!airlock) return null;
  const current = clock(now);
  validateFlow(flow, current);
  validateSpec(flow, spec);
  return freeze(copy({ version: 1, phase: 'waiting', createdAt: current, expiresAt: flow.expiresAt,
    flow, request: spec, airlock }));
}

/** Persist nextCheckpoint atomically before sending request; an old snapshot must not be reused. */
export function buildAirlockResume(checkpoint, legacyStatus, { now = Date.now() } = {}) {
  const current = clock(now);
  if (!record(checkpoint) || checkpoint.version !== 1) fail('INVALID_AIRLOCK_CHECKPOINT', 'The verification checkpoint is invalid.');
  if (checkpoint.phase === 'replay_pending') fail('AIRLOCK_REPLAY_PENDING', 'The verification retry is already pending. Check its recorded result.');
  if (checkpoint.phase !== 'waiting' || !Number.isSafeInteger(checkpoint.createdAt) || checkpoint.createdAt > current
    || checkpoint.expiresAt !== checkpoint.flow?.expiresAt) {
    fail('INVALID_AIRLOCK_CHECKPOINT', 'The verification checkpoint is invalid.');
  }
  validateFlow(checkpoint.flow, current);
  validateSpec(checkpoint.flow, checkpoint.request);
  // Revalidate the server URL and identifiers after loading a checkpoint from storage.
  extractAirlock({ status: 420, body: { client_error_info: { airlockV2: checkpoint.airlock } } });
  const replayHeaders = requireAirlockReplay(legacyStatus, checkpoint.airlock);
  const nextCheckpoint = freeze(copy({ ...checkpoint, phase: 'replay_pending', replayStartedAt: current }));
  const request = freeze(copy({ ...checkpoint.request, headers: { ...checkpoint.request.headers, ...replayHeaders } }));
  return freeze({ request, nextCheckpoint });
}
