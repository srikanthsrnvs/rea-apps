import { randomUUID } from 'node:crypto';

// Local limits, not claims about the server's OTP or access-token lifetime.
export const AUTH_FLOW_TTL_MS = 15 * 60_000;
export const AUTH_RESEND_COOLDOWN_MS = 30_000;
export const AUTH_MAX_RESENDS = 3;
export const AUTH_MAX_VERIFICATIONS = 10;

const METHODS = {
  email: { config: 'emailOtp', step: 'emailOtpChallenge', suffix: 'email_otp' },
  sms: { config: 'smsOtp', step: 'smsOtpChallenge', suffix: 'sms_otp' },
  voice: { config: 'voiceOtp', step: 'voiceOtpChallenge', suffix: 'voice_otp' },
  whatsapp: { config: 'whatsAppOtp', step: 'whatsAppOtpChallenge', suffix: 'whatsapp_otp' },
};
const TERMINAL_CONFIGS = new Set(['closeModal', 'noop']);
const KNOWN_OTHER_STEPS = new Set(['authOptions', 'password', 'google', 'apple', 'naver', 'weChat', 'signupForm',
  'communityCommitment', 'existingAccount', 'emailConfirmPrompt', 'emailConfirmChallenge', 'emailConfirmDeny',
  'passkey', 'obcPhone', 'passkeyScreen', 'line', 'googleOauth', 'lineOauth', 'airlock', 'airlock_repeated', 'captcha', 'destination_mismatch']);
const STATUSES = new Set(['ready', 'request_pending', 'code_required', 'action_required', 'validation_required',
  'denied', 'expired', 'rate_limited']);

function fail(code, message) {
  const error = new Error(message);
  error.name = 'AirbnbAuthError';
  error.code = code;
  throw error;
}
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function time(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_ARGUMENT', 'Provide a valid auth clock value.');
  return value;
}
function opaque(value, label, { nullable = true, max = 65_536 } = {}) {
  if (nullable && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    fail('INVALID_AUTH_CONTEXT', `Invalid ${label}.`);
  }
  return value;
}
function jsonCopy(value) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail('INVALID_AUTH_RESPONSE', 'The auth data must be JSON.'); }
  if (!encoded || encoded.length > 262_144) fail('INVALID_AUTH_RESPONSE', 'The auth data is invalid or too large.');
  return JSON.parse(encoded);
}
function identifier({ email, phone, countryCode }) {
  if ((email !== undefined && email !== null) === (phone !== undefined && phone !== null)) {
    fail('INVALID_ARGUMENT', 'Provide exactly one email address or phone number.');
  }
  if (email !== undefined && email !== null) {
    if (typeof email !== 'string' || email.length > 254 || !/^[^\s@\x00-\x1f\x7f]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) {
      fail('INVALID_ARGUMENT', 'Provide a valid email address.');
    }
    if (countryCode !== undefined && countryCode !== null) fail('INVALID_ARGUMENT', 'Country code applies to phone login.');
    return { type: 'email', email };
  }
  if (typeof countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(countryCode)) {
    fail('INVALID_ARGUMENT', 'Provide the two-letter phone country code, such as US.');
  }
  if (typeof phone !== 'string' || phone.length > 40 || !/^\+[0-9 ()-]+$/.test(phone)) {
    fail('INVALID_ARGUMENT', 'Provide the full international phone number, including + and calling code.');
  }
  const phoneNumber = phone.replace(/[ ()-]/g, '');
  if (!/^\+[1-9][0-9]{6,14}$/.test(phoneNumber)) {
    fail('INVALID_ARGUMENT', 'Provide a valid international phone number, such as +14155550123.');
  }
  return { type: 'phone', phoneNumber, phoneCountryCode: countryCode.toUpperCase() };
}
function validateFlow(flow) {
  if (!record(flow) || flow.version !== 1 || !STATUSES.has(flow.status) || !record(flow.identifier)
    || !Number.isSafeInteger(flow.createdAt) || !Number.isSafeInteger(flow.expiresAt)
    || flow.expiresAt <= flow.createdAt || flow.expiresAt - flow.createdAt > AUTH_FLOW_TTL_MS
    || !Array.isArray(flow.steps) || flow.steps.length > 32
    || !Array.isArray(flow.availableMethods) || !flow.availableMethods.every(method => Object.hasOwn(METHODS, method))
    || !Number.isInteger(flow.resendCount) || flow.resendCount < 0
    || !Number.isInteger(flow.verificationCount) || flow.verificationCount < 0) {
    fail('INVALID_AUTH_CONTEXT', 'The auth flow is invalid.');
  }
  if (flow.identifier.type === 'email') identifier({ email: flow.identifier.email });
  else if (flow.identifier.type === 'phone') identifier({ phone: flow.identifier.phoneNumber, countryCode: flow.identifier.phoneCountryCode });
  else fail('INVALID_AUTH_CONTEXT', 'The auth identifier is invalid.');
  opaque(flow.authSessionId, 'auth session ID', { nullable: false, max: 128 });
  opaque(flow.authAttemptId, 'auth attempt ID', { max: 128 });
  opaque(flow.deviceId, 'device ID', { nullable: false, max: 128 });
  opaque(flow.persisted, 'persisted auth data');
  opaque(flow.sessionData, 'auth session data');
}
function readHeader(headers, name) {
  let value;
  if (headers && typeof headers.get === 'function') value = headers.get(name);
  else if (record(headers)) {
    const key = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());
    if (key !== undefined) value = headers[key];
  }
  if (value === undefined || value === null) return null;
  if (value === '') return '';
  return opaque(value, 'server auth header');
}
function expired(flow, now) { return flow.status === 'expired' || now >= flow.expiresAt; }
function clearSensitive(flow) {
  flow.steps = [];
  flow.pendingRequest = null;
  flow.candidateTokens = null;
  return flow;
}

/** Private state: store with the same protection as credentials. No transport or storage is performed. */
export function createAuthFlow({ email, phone, countryCode, persisted, deviceId, now = Date.now() } = {}) {
  const validIdentifier = identifier({ email, phone, countryCode });
  const validPersisted = opaque(persisted, 'persisted auth data');
  const validDevice = opaque(deviceId ?? randomUUID(), 'device ID', { nullable: false, max: 128 });
  const started = time(now);
  return {
    version: 1, identifier: validIdentifier, deviceId: validDevice,
    createdAt: started, updatedAt: started, expiresAt: started + AUTH_FLOW_TTL_MS,
    status: 'ready', authenticated: false, authSessionId: randomUUID(), authAttemptId: null,
    persisted: validPersisted, sessionData: null, steps: [], availableMethods: [], activeMethod: null,
    fallbackChallenges: {}, requiredSteps: [], resendCount: 0, verificationCount: 0,
    resendAvailableAt: 0, retryAt: 0, pendingRequest: null, candidateTokens: null, userId: null, error: null,
  };
}

/** Build exactly one explicit request. The caller must persist nextFlow and serialize requests. */
export function buildAuthRequest(flow, { action, code, method, now = Date.now() } = {}) {
  validateFlow(flow);
  const current = time(now);
  if (expired(flow, current)) fail('AUTH_FLOW_EXPIRED', 'This sign-in flow expired. Start a new sign-in.');
  if (!['identify', 'verify', 'resend'].includes(action)) fail('INVALID_ARGUMENT', 'Choose identify, verify, or resend.');
  if (action === 'verify' && (typeof code !== 'string' || !/^[0-9]{6}$/.test(code))) {
    fail('INVALID_VERIFICATION_CODE', 'Provide the six-digit code as a string.');
  }
  if (action !== 'verify' && code !== undefined) fail('INVALID_ARGUMENT', 'A code applies only to verification.');
  if (method !== undefined && !Object.hasOwn(METHODS, method)) fail('INVALID_ARGUMENT', 'Unknown verification method.');
  if (flow.pendingRequest || flow.status === 'request_pending') fail('AUTH_REQUEST_PENDING', 'Wait for the pending sign-in request.');
  if (flow.status === 'rate_limited' && current < flow.retryAt) fail('AUTH_RATE_LIMITED', 'Wait before another sign-in request.');
  if (['validation_required', 'action_required', 'denied'].includes(flow.status)) {
    fail('AUTH_ACTION_REQUIRED', 'This flow needs account validation or another verification action.');
  }

  let path, nextStep = null, source, selected = method ?? flow.activeMethod;
  if (action === 'identify') {
    const retryingInitial = flow.status === 'rate_limited' && flow.steps.length === 0 && flow.activeMethod === null;
    if (flow.status !== 'ready' && !retryingInitial) fail('AUTH_ALREADY_STARTED', 'Start a new flow to change the sign-in identifier.');
    if (method !== undefined) fail('INVALID_ARGUMENT', 'The server selects the initial verification method.');
    path = `auth/identify/${flow.identifier.type}`;
    nextStep = flow.identifier.type === 'email'
      ? { identifyEmail: { email: flow.identifier.email } }
      : { identifyPhone: { phoneCountryCode: flow.identifier.phoneCountryCode, phoneNumber: flow.identifier.phoneNumber } };
  } else {
    if (!selected || !flow.availableMethods.includes(selected)) fail('AUTH_METHOD_UNAVAILABLE', 'The server has not offered that verification method.');
    if (action === 'verify' && selected !== flow.activeMethod) fail('AUTH_METHOD_NOT_ACTIVE', 'Request the offered method before submitting its code.');
    if (action === 'verify') {
      if (flow.verificationCount >= AUTH_MAX_VERIFICATIONS) fail('AUTH_ATTEMPT_LIMIT', 'Start a new sign-in after too many verification attempts.');
      path = `auth/authenticate/${METHODS[selected].suffix}`;
      nextStep = { [METHODS[selected].step]: { otp: code } };
    } else {
      if (flow.resendCount >= AUTH_MAX_RESENDS) fail('AUTH_RESEND_LIMIT', 'Start a new sign-in after the resend limit.');
      if (current < flow.resendAvailableAt) fail('AUTH_RESEND_COOLDOWN', 'Wait before explicitly requesting another code.');
      path = `auth/challenge/${METHODS[selected].suffix}`;
      source = selected === flow.activeMethod ? 'RESEND_OTP' : 'FALLBACK';
      if (source === 'FALLBACK') {
        if (!record(flow.fallbackChallenges?.[selected])) fail('AUTH_METHOD_UNAVAILABLE', 'The server has not supplied that fallback.');
        nextStep = { challengeRequested: { challenge: flow.fallbackChallenges[selected] } };
      }
    }
  }

  const nextFlow = jsonCopy(flow);
  const previousSteps = jsonCopy(flow.steps);
  if (nextStep) nextFlow.steps.push(jsonCopy(nextStep));
  if (nextFlow.steps.length > 32) fail('AUTH_ATTEMPT_LIMIT', 'Start a new sign-in after too many steps.');
  if (action !== 'verify') nextFlow.authAttemptId = randomUUID();
  nextFlow.pendingRequest = { action, method: selected ?? null, previousSteps };
  nextFlow.status = 'request_pending';
  nextFlow.error = null;
  nextFlow.updatedAt = current;
  if (action === 'resend') nextFlow.resendCount += 1;
  if (action === 'verify') nextFlow.verificationCount += 1;
  const headers = {
    'X-Airbnb-Flex-Auth-Options': 'null', 'X-CSRF-Without-Token': '1',
    'X-Airbnb-Auth-Session-ID': nextFlow.authSessionId, 'X-Airbnb-Auth-Attempt': nextFlow.authAttemptId,
    'X-Airbnb-Auth-Entrypoint': 'Other',
  };
  if (nextFlow.persisted) headers['X-Airbnb-Auth-Persisted'] = nextFlow.persisted;
  if (nextFlow.sessionData) headers['X-Airbnb-Auth-Session'] = nextFlow.sessionData;
  return {
    path: `/v2/${path}`, method: 'POST', headers,
    // Shipped client's auth-message format selector; this is not a device proof.
    body: { steps: jsonCopy(nextFlow.steps), appHashType: 'ANDROID', ...(source ? { source } : {}),
      passkeySupport: { apiSupported: false, conditionalMediation: false } },
    nextFlow,
  };
}

function retryTime(value, now) {
  if (value === null) return now + AUTH_RESEND_COOLDOWN_MS;
  const seconds = /^\d+$/.test(value) ? Number(value) : null;
  const target = seconds === null ? Date.parse(value) : now + seconds * 1_000;
  return Number.isFinite(target) ? Math.max(now, Math.min(target, now + AUTH_FLOW_TTL_MS)) : now + AUTH_RESEND_COOLDOWN_MS;
}
function configuredMethods(config) {
  return Object.keys(METHODS).filter(method => record(config[METHODS[method].config]));
}
function destinationMismatch(flow, method, challenge) {
  if (flow.identifier.type !== 'phone' || method === 'email' || typeof challenge.phoneNumber !== 'string') return false;
  const number = challenge.phoneNumber.replace(/[ ().-]/g, '');
  // A masked destination cannot establish a mismatch. A complete E.164 number can.
  return /^\+[1-9][0-9]{6,14}$/.test(number) && number !== flow.identifier.phoneNumber;
}
function candidate(authentication) {
  if (!record(authentication) || typeof authentication.userId_str !== 'string' || !authentication.userId_str
    || typeof authentication.isNewAccount !== 'boolean' || !record(authentication.nativeTokens)) return null;
  const tokens = authentication.nativeTokens;
  if (!record(tokens.aaj) || typeof tokens.aaj.aaj !== 'string' || !tokens.aaj.aaj
    || (tokens.aaj.maxAgeSecs !== null && tokens.aaj.maxAgeSecs !== undefined
      && (!Number.isSafeInteger(tokens.aaj.maxAgeSecs) || tokens.aaj.maxAgeSecs < 0))) return null;
  opaque(tokens.token, 'candidate access token', { nullable: false });
  opaque(tokens.aaj.aaj, 'candidate AAJ value', { nullable: false });
  opaque(authentication.userId_str, 'candidate user ID', { nullable: false, max: 128 });
  return { token: tokens.token, aaj: jsonCopy(tokens.aaj) };
}

/** A token response is only a candidate; independently query the account before replacing a saved session. */
export function applyAuthResponse(flow, { status, headers, body, now = Date.now() } = {}) {
  validateFlow(flow);
  const current = time(now);
  if (!Number.isInteger(status) || status < 100 || status > 599) fail('INVALID_AUTH_RESPONSE', 'Invalid auth HTTP status.');
  if (expired(flow, current)) return { ...clearSensitive(jsonCopy(flow)), status: 'expired', updatedAt: current, error: 'AUTH_FLOW_EXPIRED' };
  if (!record(flow.pendingRequest)) fail('AUTH_RESPONSE_UNEXPECTED', 'There is no pending sign-in request.');
  const persisted = readHeader(headers, 'X-Airbnb-Set-Auth-Persisted');
  const sessionData = readHeader(headers, 'X-Airbnb-Set-Auth-Session');
  const retryAfter = readHeader(headers, 'Retry-After');
  const data = record(body) ? jsonCopy(body) : null;
  const next = jsonCopy(flow);
  const pending = next.pendingRequest;
  next.pendingRequest = null;
  next.candidateTokens = null;
  next.updatedAt = current;
  if (persisted !== null) next.persisted = persisted || null;
  if (sessionData !== null) next.sessionData = sessionData || null;
  const rejected = status < 200 || status >= 300 || (data?.errorCode !== undefined && data.errorCode !== null && data.errorCode !== 0)
    || Boolean(data?.error) || (Array.isArray(data?.errors) && data.errors.length > 0);
  if (rejected) next.steps = pending.previousSteps;
  if ([410, 419, 440].includes(status)) return { ...clearSensitive(next), status: 'expired', error: 'AUTH_FLOW_EXPIRED' };
  if (status === 429) return { ...next, status: 'rate_limited', error: 'AUTH_RATE_LIMITED', retryAt: retryTime(retryAfter, current) };

  const config = record(data?.nextStepConfig) ? data.nextStepConfig : null;
  if (!config) {
    next.status = rejected ? 'denied' : 'action_required';
    next.error = rejected ? 'AUTH_REJECTED' : 'AUTH_RESPONSE_UNRECOGNIZED';
    return clearSensitive(next);
  }
  const active = Object.entries(config).filter(([, value]) => value !== null && value !== undefined);
  const unsupported = active.filter(([key]) => !TERMINAL_CONFIGS.has(key) && !Object.values(METHODS).some(method => method.config === key));
  const offered = configuredMethods(config);
  next.requiredSteps = unsupported.map(([key]) => KNOWN_OTHER_STEPS.has(key) ? key : 'unsupported_step');
  if (unsupported.length || offered.length > 1 || (active.length && offered.length === 0 && !active.every(([key]) => TERMINAL_CONFIGS.has(key)))) {
    next.status = 'action_required'; next.error = 'AUTH_ACTION_REQUIRED';
    next.availableMethods = []; next.activeMethod = null;
    return next;
  }
  if (offered.length === 1) {
    const method = offered[0], challenge = config[METHODS[method].config];
    if (destinationMismatch(next, method, challenge)) {
      next.status = 'action_required'; next.error = 'AUTH_DESTINATION_MISMATCH';
      next.requiredSteps = ['destination_mismatch']; next.activeMethod = null; next.availableMethods = [];
      return clearSensitive(next);
    }
    const fallbacks = Array.isArray(challenge.fallbackChallenges) ? challenge.fallbackChallenges : [];
    next.fallbackChallenges = {};
    for (const fallback of fallbacks) {
      if (!record(fallback)) continue;
      const methods = configuredMethods(fallback);
      const keys = Object.entries(fallback).filter(([, value]) => value !== null && value !== undefined);
      if (methods.length === 1 && keys.length === 1) next.fallbackChallenges[methods[0]] = fallback;
    }
    next.activeMethod = method;
    next.availableMethods = [...new Set([method, ...Object.keys(next.fallbackChallenges)])];
    next.status = 'code_required';
    next.error = rejected ? 'AUTH_VERIFICATION_REJECTED' : null;
    if (!rejected && pending.action !== 'verify') next.resendAvailableAt = current + AUTH_RESEND_COOLDOWN_MS;
    return next;
  }
  const tokens = !rejected ? candidate(data.authentication) : null;
  if (tokens) {
    clearSensitive(next);
    next.candidateTokens = tokens;
    next.userId = data.authentication.userId_str;
    next.isNewAccount = data.authentication.isNewAccount;
    next.status = 'validation_required'; next.error = null;
    next.availableMethods = []; next.activeMethod = null;
    return next;
  }
  next.status = rejected ? 'denied' : 'action_required';
  next.error = rejected ? 'AUTH_REJECTED' : 'AUTH_RESPONSE_UNRECOGNIZED';
  return clearSensitive(next);
}

function maskedIdentifier(value) {
  if (value.type === 'email') {
    const [local, domain] = value.email.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  return `***${value.phoneNumber.slice(-4)}`;
}

/** Deliberate allowlist: safe for CLI JSON, logs, and user-facing status. */
export function publicAuthStatus(flow, { now = Date.now() } = {}) {
  validateFlow(flow);
  const current = time(now), isExpired = expired(flow, current);
  return {
    status: isExpired ? 'expired' : flow.status, authenticated: false,
    destination: maskedIdentifier(flow.identifier), method: isExpired ? null : flow.activeMethod,
    availableMethods: isExpired ? [] : [...flow.availableMethods],
    requiredSteps: isExpired ? [] : [...new Set((flow.requiredSteps ?? []).map(step => KNOWN_OTHER_STEPS.has(step) ? step : 'unsupported_step'))],
    expiresAt: flow.expiresAt, validationRequired: !isExpired && flow.status === 'validation_required',
    resendsRemaining: Math.max(0, AUTH_MAX_RESENDS - flow.resendCount),
    resendAvailableAt: flow.resendAvailableAt || null,
    retryAt: flow.status === 'rate_limited' ? flow.retryAt : null,
    error: isExpired ? 'AUTH_FLOW_EXPIRED' : new Set(['AUTH_FLOW_EXPIRED', 'AUTH_RATE_LIMITED', 'AUTH_REJECTED',
      'AUTH_RESPONSE_UNRECOGNIZED', 'AUTH_ACTION_REQUIRED', 'AUTH_VERIFICATION_REJECTED', 'AUTH_DESTINATION_MISMATCH',
      'AUTH_VERIFICATION_REQUIRED', 'AUTH_VERIFICATION_REPEATED']).has(flow.error) ? flow.error : null,
  };
}
