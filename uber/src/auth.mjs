import { randomUUID } from 'node:crypto';
import * as disk from './state.mjs';
import { request } from './client.mjs';
import { createContext, createLogin, defaults, extractLoginSession, sessionExchange, withExpiry } from './protocol.mjs';
import { normalizeTripStatus } from './cancellation-protocol.mjs';
import { normalizePhone, initialLoginRequest, chooseCodeChallenge, prepareCodeRequest, codeAnswerRequest, sessionVerification } from './auth-protocol.mjs';

const duration = 15 * 60 * 1000;
const busy = new Set(['starting', 'preparing', 'submitting', 'exchanging']);
const pendingStatuses = new Set([...busy, 'waiting_for_code', 'validation_pending']);
const failure = (code, message) => Object.assign(new Error(message), { code });
const deps = options => ({ store: options.store ?? disk, send: options.send ?? request, now: options.now ?? Date.now });

function terminal(value, status, error) {
  return { version: 1, loginId: value.loginId, status, startedAt: value.startedAt, expiresAt: value.expiresAt,
    ...(error ? { error } : {}) };
}
export function loginResult(value) {
  if (!value) return { status: 'none' };
  const result = { loginId: value.loginId, status: value.status, expiresAt: new Date(value.expiresAt).toISOString() };
  if (value.status === 'waiting_for_code') {
    let contact = value.challenge.hint;
    if (value.challenge.channel === 'sms') contact = `${value.number.countryCode} ***${value.number.phoneNumber.slice(-4)}`;
    else if (contact && !contact.includes('*') && contact.includes('@')) { const [name, domain] = contact.split('@'); contact = `${name.slice(0, 1)}***@${domain}`; }
    result.challenge = { id: value.challengeId, channel: value.challenge.channel, contact,
      codeLength: value.challenge.otpWidth };
    result.next = 'Ask the user for this code, then run uber auth complete --login-id ID --challenge-id CHALLENGE_ID --code CODE. Always use the current challenge.id; Uber may require another verification code.';
  }
  if (value.status === 'validation_pending') result.next = 'Run uber auth validate --login-id ID to validate the exchanged session.';
  if (value.error) result.error = value.error;
  return result;
}

async function current(store, now) {
  const value = await store.readState('login');
  if (!value) return null;
  if (pendingStatuses.has(value.status) && value.expiresAt <= now()) {
    const expired = terminal(value, 'expired');
    await store.saveState('login', expired);
    await store.removeState('candidate-session');
    return expired;
  }
  // The state mutex excludes a currently executing request. A busy record seen
  // after acquiring it means its process exited before recording the outcome.
  if (busy.has(value.status)) {
    if (value.status === 'exchanging') {
      const candidate = await store.readState('candidate-session');
      if (candidate?.loginId === value.loginId && candidate.accessToken && candidate.context) {
        const validating = terminal(value, 'validation_pending');
        await store.saveState('login', validating);
        return validating;
      }
    }
    const unknown = terminal(value, 'outcome_unknown', { code: 'LOGIN_OUTCOME_UNKNOWN',
      message: 'A login request was interrupted. Cancel this attempt before starting again; the request will not be replayed.' });
    await store.saveState('login', unknown);
    return unknown;
  }
  return value;
}

function checkId(value, loginId) {
  if (loginId !== undefined && (!/^[a-f0-9-]{36}$/i.test(loginId) || value?.loginId !== loginId)) {
    throw failure('LOGIN_ID_MISMATCH', 'The login ID does not match the current attempt.');
  }
}

async function recordFailure(store, pending, error) {
  const uncertain = !error.status || error.status >= 500 || error.status === 408;
  const code = uncertain ? 'LOGIN_OUTCOME_UNKNOWN' : 'LOGIN_REJECTED';
  await store.saveState('login', terminal(pending, uncertain ? 'outcome_unknown' : 'failed', { code,
    message: uncertain ? 'The request outcome is unknown. Cancel this attempt before starting a new login; do not repeat the request.'
      : 'Uber rejected the login request. No existing session was replaced.' }));
}

async function prepareNext(pending, response, { store, send, now }) {
  const selected = chooseCodeChallenge(response);
  if (!selected) {
    const error = failure('LOGIN_CHALLENGE_UNSUPPORTED', 'Uber requires a login challenge this CLI cannot complete. Use the explicit browser recovery flow.');
    await store.saveState('login', terminal(pending, 'unsupported_challenge', { code: error.code, message: error.message }));
    throw error;
  }
  const preparing = { ...pending, status: 'preparing' };
  await store.saveState('login', preparing);
  let prepared;
  try { prepared = await send(pending.pending.context, '/rt/silk-screen/prepare-field', prepareCodeRequest(response, selected)); }
  catch (error) { await recordFailure(store, preparing, error); throw error; }
  if (prepared?.success !== true || !prepared.formContainer?.inAuthSessionID) {
    await store.saveState('login', terminal(pending, 'failed', { code: 'LOGIN_PREPARATION_FAILED', message: 'Uber did not confirm delivery of the verification code.' }));
    throw failure('LOGIN_PREPARATION_FAILED', 'Uber did not confirm delivery of the verification code.');
  }
  const challenge = chooseCodeChallenge(prepared);
  if (!challenge || challenge.channel !== selected.channel) {
    await store.saveState('login', terminal(pending, 'failed', { code: 'LOGIN_PROTOCOL_CHANGED', message: 'Uber returned an unsupported verification form.' }));
    throw failure('LOGIN_PROTOCOL_CHANGED', 'Uber returned an unsupported verification form.');
  }
  const waiting = { ...pending, status: 'waiting_for_code', challenge, challengeId: randomUUID(),
    sessionID: prepared.formContainer.inAuthSessionID, step: (pending.step ?? 0) + 1 };
  if (waiting.expiresAt <= now()) {
    await store.saveState('login', terminal(waiting, 'expired'));
    throw failure('LOGIN_EXPIRED', 'The login attempt expired. Start a new login.');
  }
  await store.saveState('login', waiting);
  return loginResult(waiting);
}

async function validate(pending, candidate, { store, send, now }) {
  if (!candidate?.accessToken || !candidate.context || candidate.loginId !== pending.loginId) {
    throw failure('LOGIN_CANDIDATE_MISSING', 'No exchanged session is available for this login attempt.');
  }
  if (!Number.isSafeInteger(candidate.expiresAt)) throw failure('LOGIN_PROTOCOL_CHANGED', 'Uber did not return a recognized access-token expiry. Cancel this attempt and start a new login.');
  if (candidate.expiresAt <= now()) throw failure('LOGIN_CANDIDATE_EXPIRED', 'The exchanged access token expired. Cancel this attempt and start a new login.');
  const exemption = await send(candidate.context, '/rt/devices/exemption', { request: { token: '', exemptToken: '' } }, candidate.accessToken);
  if (typeof exemption?.token !== 'string' || !exemption.token || !Number.isSafeInteger(exemption.metadata?.expiry)
    || exemption.metadata.expiry * 1000 <= now() + 5000) {
    throw failure('LOGIN_VALIDATION_FAILED', 'Uber did not issue a usable integrity exemption for this session.');
  }
  const status = await send(candidate.context, '/rt/riders/me/status', {}, candidate.accessToken, { integrityToken: exemption.token });
  normalizeTripStatus(status);
  const { loginId: _, ...session } = candidate;
  await store.saveState('session', { ...session, acquiredBy: 'verification-code', validatedAt: now() });
  await store.saveState('integrity', { token: exemption.token, expiresAt: exemption.metadata.expiry * 1000, contextDeviceId: candidate.context.deviceId });
  await store.saveState('context', candidate.context);
  await store.saveState('login', terminal(pending, 'authenticated'));
  await store.removeState('candidate-session');
  await store.removeState('pending-login');
  return { ...loginResult(terminal(pending, 'authenticated')), loggedIn: true, refreshTokenAvailable: Boolean(candidate.refreshToken) };
}

export async function startLogin({ phone, countryCode = '1', replace = false } = {}, options = {}) {
  const number = normalizePhone(phone, countryCode), d = deps(options), { store, now, send } = d;
  return store.withStateLock(async () => {
    const previous = await current(store, now);
    if (previous && pendingStatuses.has(previous.status) && !replace) {
      if (previous.status === 'waiting_for_code' && JSON.stringify(previous.number) === JSON.stringify(number)) return loginResult(previous);
      throw failure('LOGIN_PENDING', 'A login is already pending. Complete or cancel it, or use --replace.');
    }
    if (previous?.status === 'outcome_unknown' && !replace) throw failure('LOGIN_OUTCOME_UNKNOWN', 'Cancel the interrupted login before requesting another code, or use --replace explicitly.');
    await store.removeState('candidate-session');
    await store.removeState('pending-login');
    const context = await store.readState('context') ?? createContext();
    const pending = { version: 1, loginId: randomUUID(), status: 'starting', number, startedAt: now(), expiresAt: now() + duration,
      pending: createLogin(context, defaults.callback) };
    await store.saveState('login', pending);
    let response;
    try { response = await send(context, '/rt/silk-screen/submit-form', initialLoginRequest(context, pending.pending, number)); }
    catch (error) { await recordFailure(store, pending, error); throw error; }
    return prepareNext(pending, response, d);
  });
}

export async function completeLogin({ code, loginId, challengeId } = {}, options = {}) {
  const d = deps(options), { store, send, now } = d;
  return store.withStateLock(async () => {
    const pending = await current(store, now);
    checkId(pending, loginId);
    if (!pending || pending.status !== 'waiting_for_code') throw failure('LOGIN_CODE_NOT_EXPECTED', 'There is no pending verification code. Inspect uber auth poll or start a login.');
    if (typeof challengeId !== 'string' || pending.challengeId !== challengeId) throw failure('LOGIN_CHALLENGE_MISMATCH', 'Supply the ID of the current verification challenge. A previous step cannot be submitted again.');
    if (typeof code !== 'string' || !/^\d{4,10}$/.test(code) || (pending.challenge.otpWidth && code.length !== pending.challenge.otpWidth)) {
      throw failure('INVALID_CODE', 'Supply the numeric code of the length shown by the current challenge.');
    }
    await store.saveState('login', { ...pending, status: 'submitting' });
    let response;
    try { response = await send(pending.pending.context, '/rt/silk-screen/submit-form', codeAnswerRequest(pending.pending, pending.sessionID, pending.challenge, code)); }
    catch (error) {
      if ([400, 422].includes(error.status) && ['SMS_OTP_INCORRECT', 'EMAIL_OTP_INCORRECT'].includes(error.code)) await store.saveState('login', pending);
      else await recordFailure(store, pending, error);
      throw error;
    }
    const verification = sessionVerification(response);
    if (!verification) return prepareNext(pending, response, d);
    await store.saveState('login', { ...pending, status: 'exchanging' });
    let oauth;
    try {
      const payload = await send(pending.pending.context, '/rt/silk-screen/submit-form', sessionExchange(pending.pending.context, pending.pending, verification, {}));
      oauth = extractLoginSession(payload);
      if (!oauth?.accessToken || !oauth.userUUID) throw failure('LOGIN_PROTOCOL_CHANGED', 'Uber did not return a recognized rider session.');
    } catch (error) { await recordFailure(store, pending, error); throw error; }
    let candidate;
    try {
      candidate = { ...withExpiry({ ...oauth, context: pending.pending.context }, now()), loginId: pending.loginId };
      if (!Number.isSafeInteger(candidate.expiresAt) || candidate.expiresAt <= now()) throw failure('LOGIN_PROTOCOL_CHANGED', 'Uber did not return a usable access-token expiry.');
    } catch (error) { await recordFailure(store, pending, error); throw error; }
    await store.saveState('candidate-session', candidate);
    const validating = terminal(pending, 'validation_pending');
    await store.saveState('login', validating);
    return validate(validating, candidate, d);
  });
}

export async function validateLogin({ loginId } = {}, options = {}) {
  const d = deps(options);
  return d.store.withStateLock(async () => {
    const pending = await current(d.store, d.now);
    checkId(pending, loginId);
    if (pending?.status !== 'validation_pending') throw failure('LOGIN_VALIDATION_NOT_PENDING', 'No exchanged session is waiting for validation.');
    return validate(pending, await d.store.readState('candidate-session'), d);
  });
}

export async function pollLogin({ loginId } = {}, options = {}) {
  const { store, now } = deps(options);
  return store.withStateLock(async () => { const value = await current(store, now); checkId(value, loginId); return loginResult(value); });
}
export async function authStatus(options = {}) {
  const { store, now } = deps(options);
  return store.withStateLock(async () => {
    const login = await current(store, now), session = await store.readState('session'), integrity = await store.readState('integrity');
    return { loggedIn: Boolean(session?.accessToken), accessTokenExpired: Boolean(session?.expiresAt && session.expiresAt <= now()),
      refreshTokenAvailable: Boolean(session?.refreshToken), receivedAt: session?.receivedAt ?? null, expiresAt: session?.expiresAt ?? null,
      integrityExpiresAt: integrity?.expiresAt ?? null, login: loginResult(login) };
  });
}

// The manual recovery command replaces a pending code attempt in one state
// transaction so two CLI invocations cannot leave competing login challenges.
export async function startBrowserRecovery({ callback = defaults.callback, clientId } = {}, options = {}) {
  const { store, now } = deps(options);
  return store.withStateLock(async () => {
    const previous = await current(store, now);
    if (previous) await store.saveState('login', terminal(previous, 'canceled'));
    await store.removeState('candidate-session');
    const context = await store.readState('context') ?? createContext();
    if (clientId) context.firstPartyClientID = clientId;
    const pending = createLogin(context, callback);
    await store.saveState('context', context);
    await store.saveState('pending-login', pending);
    return { url: pending.url, expiresInMinutes: 15, status: 'waiting_for_login',
      next: 'Explicit manual recovery: open this URL in a browser, sign in, copy its final URL, and run uber auth complete --callback-url URL.' };
  });
}
export async function cancelLogin({ loginId } = {}, options = {}) {
  const { store, now } = deps(options);
  return store.withStateLock(async () => {
    const value = await current(store, now); checkId(value, loginId);
    if (!value) return { status: 'none' };
    if (value.status === 'authenticated') return loginResult(value);
    const canceled = terminal(value, 'canceled');
    await store.saveState('login', canceled); await store.removeState('candidate-session');
    return loginResult(canceled);
  });
}

export async function logout(options = {}) {
  const { store, now } = deps(options);
  return store.withStateLock(async () => {
    const value = await current(store, now);
    if (value) await store.saveState('login', terminal(value, 'canceled'));
    for (const name of ['session', 'candidate-session', 'integrity', 'pending-login', 'last-response', 'last-login-response', 'last-refresh-response']) await store.removeState(name);
    return { loggedOut: true };
  });
}
