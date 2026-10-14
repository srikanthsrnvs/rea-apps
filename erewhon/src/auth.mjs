import { randomUUID, createHash } from 'node:crypto';
import * as disk from './state.mjs';
import { request, ApiError } from './http.mjs';

const duration = 15 * 60 * 1000;
const busy = new Set(['starting', 'submitting']);
const active = new Set([...busy, 'waiting_for_code', 'validation_pending']);
const failure = (code, message) => new ApiError(code, message);
function dependencies(options) {
  const store = options.store ?? disk;
  return { store, now: options.now ?? Date.now,
    send: options.send ?? ((endpoint, args) => request(endpoint, args, { ...options, store })) };
}

export function normalizePhone(phone) {
  if (typeof phone !== 'string' || !/^[+\d\s().-]+$/.test(phone)) throw failure('INVALID_PHONE', 'Supply a US phone number with country code +1.');
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (!/^\d{10}$/.test(digits) || (phone.trim().startsWith('+') && !phone.trim().startsWith('+1'))) throw failure('INVALID_PHONE', 'Supply a ten-digit US number or the same number prefixed with +1.');
  return digits;
}
function terminal(value, status, error) {
  return { version: 1, loginId: value.loginId, status, startedAt: value.startedAt, expiresAt: value.expiresAt, ...(error ? { error } : {}) };
}
function loginResult(value) {
  if (!value) return { status: 'none' };
  const result = { loginId: value.loginId, status: value.status, expiresAt: new Date(value.expiresAt).toISOString() };
  if (value.status === 'waiting_for_code') result.challenge = { channel: 'sms', contact: `+1 ***${value.phone.slice(-4)}`, codeLength: 4 };
  if (value.status === 'validation_pending') result.next = 'Run erewhon auth validate --login-id ID to validate the exchanged session without repeating a code.';
  if (value.error) result.error = value.error;
  return result;
}
function checkId(pending, loginId, required = false) {
  if ((required && typeof loginId !== 'string') || (loginId !== undefined && pending?.loginId !== loginId)) throw failure('LOGIN_ID_MISMATCH', 'Supply the login ID returned by the current attempt.');
}
async function current(store, now) {
  const value = await store.readState('login');
  if (!value) return null;
  if (active.has(value.status) && value.expiresAt <= now()) {
    const expired = terminal(value, 'expired'); await store.saveState('login', expired); await store.removeState('candidate-session'); return expired;
  }
  if (busy.has(value.status)) {
    const candidate = await store.readState('candidate-session');
    if (value.status === 'submitting' && candidate?.loginId === value.loginId && candidate.token && candidate.deviceId) {
      const validating = terminal(value, 'validation_pending'); await store.saveState('login', validating); return validating;
    }
    const unknown = terminal(value, 'outcome_unknown', { code: 'LOGIN_OUTCOME_UNKNOWN', message: 'A login request was interrupted. Cancel this attempt before starting again; it will not be replayed.' });
    await store.saveState('login', unknown); return unknown;
  }
  return value;
}
async function recordFailure(store, value, error) {
  const uncertain = !error.status || error.status >= 500 || error.status === 408;
  await store.saveState('login', terminal(value, uncertain ? 'outcome_unknown' : 'failed', {
    code: uncertain ? 'LOGIN_OUTCOME_UNKNOWN' : 'LOGIN_REJECTED',
    message: uncertain ? 'The request outcome is unknown. Cancel the attempt before starting again; do not repeat it.' : 'Erewhon rejected the login request. Existing credentials remain in place.',
  }));
}
function account(user) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) throw failure('LOGIN_PROTOCOL_CHANGED', 'Erewhon did not return a recognized account profile.');
  if (typeof user._id !== 'string' || !user._id.trim()) throw failure('LOGIN_PROTOCOL_CHANGED', 'Erewhon did not return a recognized account ID.');
  return { id: user._id,
    ...(typeof user.first_name === 'string' ? { firstName: user.first_name } : {}) };
}
function checkAccount(expected, observed) {
  if (expected.id && observed.id && expected.id !== observed.id) throw failure('LOGIN_ACCOUNT_MISMATCH', 'The validation response belongs to a different account. Existing credentials remain in place.');
}
async function validate(pending, candidate, { store, send, now }) {
  if (!candidate?.token || !candidate.deviceId || typeof candidate.account?.id !== 'string'
    || !candidate.account.id.trim() || candidate.loginId !== pending.loginId) throw failure('LOGIN_CANDIDATE_MISSING', 'No exchanged session is available for this attempt.');
  const profile = await send('/v1/userprofile', { method: 'GET', token: candidate.token, readOnly: true });
  if (profile?.error !== 0) throw failure('LOGIN_VALIDATION_FAILED', 'The account profile could not be validated.');
  const profileAccount = account(profile.user); checkAccount(candidate.account, profileAccount);
  const native = await send('/v2/myerewhon', { token: candidate.token, readOnly: true });
  if (native?.error !== 0) throw failure('LOGIN_VALIDATION_FAILED', 'The native account read could not be validated.');
  if (!['ecrs_data', 'membership_data', 'current_tier'].some(key => Object.hasOwn(native, key)
    && (native[key] === null || (typeof native[key] === 'object' && !Array.isArray(native[key]))))) {
    throw failure('LOGIN_VALIDATION_FAILED', 'The native membership response shape is not recognized.');
  }
  const { loginId: _, ...session } = candidate;
  const profileConfirmed = profile.user.ecrs_details_confirmed === 'yes';
  await store.saveState('session', { ...session, account: { ...candidate.account, ...profileAccount }, validatedAt: now(), profileConfirmed });
  if (candidate.cartId) {
    const cart = await store.readState('cart');
    const owner = createHash('sha256').update(JSON.stringify({ accountId: candidate.account.id, deviceId: candidate.deviceId })).digest('hex');
    const metadata = cart?.owner && cart.owner !== owner ? {} : cart ?? {};
    await store.saveState('cart', { ...metadata, cartId: candidate.cartId, deviceId: candidate.deviceId, owner });
  }
  await store.saveState('login', terminal(pending, 'authenticated'));
  await store.removeState('candidate-session');
  return { ...loginResult(terminal(pending, 'authenticated')), loggedIn: true,
    ...(profileConfirmed ? {} : { profileConfirmationRequired: true }) };
}

export async function startLogin({ phone, replace = false } = {}, options = {}) {
  const number = normalizePhone(phone), d = dependencies(options), { store, send, now } = d;
  return store.withStateLock(async () => {
    const previous = await current(store, now);
    if (previous && active.has(previous.status) && !replace) {
      if (previous.status === 'waiting_for_code' && previous.phone === number) return loginResult(previous);
      throw failure('LOGIN_PENDING', 'Complete or cancel the pending login, or use --replace explicitly.');
    }
    if (previous?.status === 'outcome_unknown' && !replace) throw failure('LOGIN_OUTCOME_UNKNOWN', 'Cancel the interrupted login before requesting another code, or use --replace explicitly.');
    await store.removeState('candidate-session');
    const existingContext = await store.readState('context');
    const context = existingContext?.deviceId ? existingContext : { deviceId: randomUUID() };
    await store.saveState('context', context);
    const pending = { version: 1, loginId: randomUUID(), status: 'starting', phone: number, deviceId: context.deviceId, startedAt: now(), expiresAt: now() + duration };
    await store.saveState('login', pending);
    let response;
    try { response = await send('/v1/login', { form: { phone: number }, allowErrors: true }); }
    catch (error) { await recordFailure(store, pending, error); throw error; }
    if (response?.error === 2 && response.net_new_user) {
      const stopped = terminal(pending, 'registration_required'); await store.saveState('login', stopped); await store.removeState('last-response'); return loginResult(stopped);
    }
    if (response?.error !== 0) {
      await store.saveState('login', terminal(pending, 'failed', { code: 'LOGIN_REJECTED', message: 'Erewhon did not accept this existing-account login.' }));
      throw failure('LOGIN_REJECTED', 'Erewhon did not accept this existing-account login.');
    }
    const waiting = { ...pending, status: 'waiting_for_code' }; await store.saveState('login', waiting); return loginResult(waiting);
  });
}

export async function completeLogin({ loginId, code } = {}, options = {}) {
  const d = dependencies(options), { store, send, now } = d;
  return store.withStateLock(async () => {
    const pending = await current(store, now); checkId(pending, loginId, true);
    if (pending?.status !== 'waiting_for_code') throw failure('LOGIN_CODE_NOT_EXPECTED', 'There is no verification code waiting for this login.');
    if (typeof code !== 'string' || !/^\d{4}$/.test(code)) throw failure('INVALID_CODE', 'Supply the four-digit verification code as a string.');
    const form = { phone: pending.phone, otp: code, userDetails: '{}', device_id: pending.deviceId };
    const cart = await store.readState('cart');
    if (typeof cart?.cartId === 'string' && cart.cartId) form.cart_id = cart.cartId;
    await store.saveState('login', { ...pending, status: 'submitting' });
    let response;
    try { response = await send('/v1/phoneverify', { form, allowErrors: true }); }
    catch (error) { await recordFailure(store, pending, error); throw error; }
    if (response?.error === 1) {
      await store.saveState('login', pending);
      throw failure('LOGIN_CODE_REJECTED', 'Erewhon rejected this code. Supply the correct code for the same login; no message was resent.');
    }
    if (response?.error !== 0 || typeof response.token !== 'string' || !response.token || /[\r\n]/.test(response.token)) {
      await store.saveState('login', terminal(pending, 'failed')); throw failure('LOGIN_PROTOCOL_CHANGED', 'Erewhon did not return a recognized authenticated session.');
    }
    let candidate;
    try {
      candidate = { loginId: pending.loginId, token: response.token, deviceId: pending.deviceId, account: account(response.user), phoneLast4: pending.phone.slice(-4), acquiredAt: now(),
        ...(typeof response.cart_id === 'string' && response.cart_id ? { cartId: response.cart_id } : {}) };
    } catch (error) { await store.saveState('login', terminal(pending, 'failed')); throw error; }
    await store.saveState('candidate-session', candidate);
    const validating = terminal(pending, 'validation_pending'); await store.saveState('login', validating);
    return validate(validating, candidate, d);
  });
}

export async function validateLogin({ loginId } = {}, options = {}) {
  const d = dependencies(options);
  return d.store.withStateLock(async () => {
    const pending = await current(d.store, d.now); checkId(pending, loginId, true);
    if (pending?.status !== 'validation_pending') throw failure('LOGIN_VALIDATION_NOT_PENDING', 'No exchanged session is waiting for validation.');
    return validate(pending, await d.store.readState('candidate-session'), d);
  });
}
export async function pollLogin({ loginId } = {}, options = {}) {
  const { store, now } = dependencies(options);
  return store.withStateLock(async () => { const pending = await current(store, now); checkId(pending, loginId); return loginResult(pending); });
}
export async function cancelLogin({ loginId } = {}, options = {}) {
  const { store, now } = dependencies(options);
  return store.withStateLock(async () => {
    const pending = await current(store, now); checkId(pending, loginId);
    if (pending) await store.saveState('login', terminal(pending, 'cancelled'));
    await store.removeState('candidate-session'); await store.removeState('last-response');
    return pending ? loginResult(terminal(pending, 'cancelled')) : { status: 'none' };
  });
}
export async function authStatus(options = {}) {
  const { store, now } = dependencies(options);
  return store.withStateLock(async () => {
    const session = await store.readState('session');
    return { loggedIn: Boolean(session?.token), account: session?.account ?? null, acquiredAt: session?.acquiredAt ?? null,
      validatedAt: session?.validatedAt ?? null, profileConfirmationRequired: session?.profileConfirmed === false,
      login: loginResult(await current(store, now)) };
  });
}
export async function logout(options = {}) {
  const { store } = dependencies(options);
  return store.withStateLock(async () => {
    for (const name of ['session', 'login', 'candidate-session', 'last-response']) await store.removeState(name);
    return { loggedIn: false, status: 'logged_out' };
  });
}
