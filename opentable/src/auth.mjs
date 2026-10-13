import { randomUUID, createHash } from 'node:crypto';
import { OpenTableClient, acquireAnonymous, nativeClient, checkToken } from './http.mjs';
import { OpenTableError } from './errors.mjs';
import * as diskState from './state.mjs';

const passwordlessClient = { client_id: nativeClient.passwordless, client_secret: nativeClient.sharedValue };
const pendingDurationMs = 10 * 60 * 1000; // Local login deadline; server OTP lifetime is not exposed.
const fail = (code, message, details) => new OpenTableError(code, message, details);
const fingerprint = value => createHash('sha256').update(value).digest('hex');
function dependencies(options) {
  return { store: options.store ?? diskState, now: options.now ?? Date.now,
    anonymous: options.anonymous ?? acquireAnonymous,
    client: options.client ?? (settings => new OpenTableClient(settings)),
    fetchImpl: options.fetchImpl ?? fetch };
}
function contact({ phone, email, countryCode = '1', countryId = 'US' }) {
  if (Boolean(phone) === Boolean(email)) throw fail('INVALID_ARGUMENT', 'Supply exactly one phone number or email address.');
  if (email) {
    if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw fail('INVALID_ARGUMENT', 'Supply a valid email address.');
    return { email: email.trim(), target: 'EMAIL' };
  }
  if (typeof phone !== 'string' || !/^\+?[\d ()-]+$/.test(phone) || !/^[1-9]\d{0,2}$/.test(countryCode) || !/^[A-Z]{2}$/.test(countryId)) throw fail('INVALID_ARGUMENT', 'Supply a phone number, numeric country code and two-letter uppercase country ID.');
  let number = phone.replace(/\D/g, '');
  if (phone.startsWith('+')) {
    if (!number.startsWith(countryCode)) throw fail('INVALID_ARGUMENT', 'The phone country prefix must match --country-code.');
    number = number.slice(countryCode.length);
  }
  if (!/^\d{7,14}$/.test(number) || number.length + countryCode.length > 15) throw fail('INVALID_ARGUMENT', 'Supply a valid national or matching international phone number.');
  return { phone: { countryCode, countryId, number }, target: 'SMS' };
}
function contactLabel(value) {
  if (value.phone) return `+${value.phone.countryCode} ${'*'.repeat(Math.max(0, value.phone.number.length - 2))}${value.phone.number.slice(-2)}`;
  if (value.email) { const [name, domain] = value.email.split('@'); return `${name.slice(0, 1)}***@${domain}`; }
  return null;
}
function loginResult(pending, now) {
  if (!pending) return { status: 'none' };
  return { loginId: pending.loginId, status: pending.expiresAt <= now && pending.status === 'waiting' ? 'expired' : pending.status,
    contact: pending.contactLabel ?? null, expiresAt: new Date(pending.expiresAt).toISOString() };
}
function stripPending(pending, status) {
  return { version: 1, loginId: pending.loginId, status, startedAt: pending.startedAt,
    expiresAt: pending.expiresAt, contactLabel: pending.contactLabel };
}
function tokenSession(raw, previous, now) {
  if (!raw || typeof raw.access_token !== 'string' || !raw.access_token || !Number.isFinite(raw.expires_in) || raw.expires_in <= 0 || raw.expires_in > 366 * 86400
    || (raw.token_type !== undefined && !/^bearer$/i.test(raw.token_type))) throw fail('PROTOCOL_CHANGED', 'OpenTable returned an invalid token response.');
  const refreshToken = raw.refresh_token ?? previous?.refreshToken;
  if (refreshToken !== undefined && (typeof refreshToken !== 'string' || !refreshToken)) throw fail('PROTOCOL_CHANGED', 'OpenTable returned an invalid refresh token.');
  return { version: 1, ...(previous?.loginId ? { loginId: previous.loginId } : {}), accessToken: checkToken(raw.access_token), ...(previous?.account ? { account: previous.account } : {}), ...(refreshToken ? { refreshToken } : {}),
    expiresAt: now + raw.expires_in * 1000, scope: typeof raw.scope === 'string' ? raw.scope : null,
    tokenType: 'Bearer', sessionId: previous?.sessionId ?? randomUUID(),
    acquiredBy: previous?.acquiredBy ?? 'verification-code', acquiredAt: previous?.acquiredAt ?? now };
}
// Exact native User fields are validated here; never infer an account from a generic id.
export function accountFromUser(user) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) throw fail('PROTOCOL_CHANGED', 'OpenTable returned an invalid user profile.');
  const identifier = value => (typeof value === 'string' && value.length > 0 && value.length <= 200) || (Number.isSafeInteger(value) && value > 0) ? String(value) : null;
  const gpid = identifier(user.globalPersonId);
  if (!gpid) throw fail('PROTOCOL_CHANGED', 'OpenTable global person ID is missing.');
  const dinerIds = Array.isArray(user.diners) ? [...new Set(user.diners.map(diner => identifier(diner?.id)).filter(Boolean))] : [];
  return { dinerId: dinerIds.length === 1 ? dinerIds[0] : null, dinerIds, gpid, ...(typeof user.firstName === 'string' ? { firstName: user.firstName } : {}) };
}
async function validateCandidate(candidate, deps) {
  const { store, client, fetchImpl, now } = deps;
  const account = accountFromUser(await client({ token: candidate.accessToken, sessionId: candidate.sessionId, fetchImpl }).me());
  if (candidate.account && ['dinerId', 'gpid'].some(key => candidate.account[key] && account[key] && candidate.account[key] !== account[key])) throw fail('SESSION_ACCOUNT_MISMATCH', 'Refreshed OpenTable session belongs to a different account.');
  const session = { ...candidate, account, validatedAt: now() };
  delete session.loginId;
  await store.saveState('session', session);
  await store.removeState('candidate-session');
  if ((await store.readState('login'))?.loginId === candidate.loginId) await store.removeState('login');
  await store.removeState('refresh');
  return { authenticated: true, account, expiresAt: new Date(session.expiresAt).toISOString(), acquiredBy: session.acquiredBy };
}

export async function startLogin(arguments_ = {}, options = {}) {
  const selected = contact(arguments_), deps = dependencies(options), { store, now, anonymous, client, fetchImpl } = deps;
  return store.withStateLock(async () => {
    const previous = await store.readState('login');
    if (previous && previous.expiresAt > now() && previous.status === 'waiting') {
      const same = JSON.stringify(previous.contact) === JSON.stringify(selected);
      if (same) return loginResult(previous, now());
      throw fail('LOGIN_PENDING', 'A different login is pending. Cancel it before requesting another code.');
    }
    if (previous && ['starting', 'start_uncertain', 'confirming', 'exchanging', 'confirmation_uncertain', 'exchange_uncertain'].includes(previous.status)) {
      await store.saveState('login', stripPending(previous, previous.status));
      throw fail('LOGIN_UNCERTAIN', 'The previous login request has an uncertain result. Cancel it before starting a new login.');
    }
    if (await store.readState('candidate-session')) throw fail('LOGIN_VALIDATION_PENDING', 'An exchanged session awaits validation. Run auth refresh or cancel the pending login first.');
    const pending = { version: 1, loginId: randomUUID(), status: 'starting', startedAt: now(),
      expiresAt: now() + pendingDurationMs, contact: selected, contactLabel: contactLabel(selected), sessionId: randomUUID() };
    await store.saveState('login', pending);
    let guest;
    try { guest = await anonymous({ fetchImpl, sessionId: pending.sessionId }); }
    catch (error) { await store.removeState('login'); throw error; }
    try {
      const response = await client({ token: guest.accessToken, sessionId: pending.sessionId, fetchImpl }).request('/api/v1/2fa/start', { method: 'POST', json: selected });
      if (typeof response?.correlationId !== 'string' || !response.correlationId || response.correlationId.length > 1000) throw fail('PROTOCOL_CHANGED', 'OpenTable did not return a login correlation ID.');
      const waiting = { ...pending, status: 'waiting', correlationId: response.correlationId, anonymousToken: guest.accessToken };
      await store.saveState('login', waiting);
      return loginResult(waiting, now());
    } catch (error) {
      await store.saveState('login', stripPending(pending, 'start_uncertain'));
      throw error;
    }
  });
}

export async function completeLogin({ code } = {}, options = {}) {
  if (typeof code !== 'string' || !/^\d{4,10}$/.test(code)) throw fail('INVALID_ARGUMENT', 'Supply the numeric verification code.');
  const deps = dependencies(options), { store, now, client, fetchImpl } = deps;
  return store.withStateLock(async () => {
    const pending = await store.readState('login');
    if (!pending) throw fail('LOGIN_REQUIRED', 'Request a verification code first.');
    if (pending.expiresAt <= now()) { await store.saveState('login', stripPending(pending, 'expired')); throw fail('LOGIN_EXPIRED', 'The local login deadline expired. Request a new code.'); }
    if (pending.status !== 'waiting' || !pending.correlationId || !pending.anonymousToken) {
      await store.saveState('login', stripPending(pending, pending.status));
      throw fail('LOGIN_UNCERTAIN', 'This login cannot be submitted again. Cancel it and request a new code.');
    }
    await store.saveState('login', { ...pending, status: 'confirming' });
    const api = client({ token: pending.anonymousToken, sessionId: pending.sessionId, fetchImpl });
    let confirmed;
    try { confirmed = await api.request('/api/v1/2fa/confirm', { method: 'POST', json: {
      ...(pending.contact.phone ? { phone: pending.contact.phone } : { email: pending.contact.email }),
      code, correlationId: pending.correlationId, allowPhoneRecycling: false,
    } }); }
    catch (error) {
      const status = error.details?.status ?? error.details?.httpStatus;
      await store.saveState('login', status === 400 ? { ...pending, status: 'waiting' } : stripPending(pending, 'confirmation_uncertain'));
      throw error;
    }
    if (confirmed?.nextStep !== 'LOGIN') {
      await store.saveState('login', stripPending(pending, 'additional_step_required'));
      throw fail('LOGIN_STEP_REQUIRED', 'OpenTable requires an additional account step. Complete it in the official app or website, then request a new code.', { nextStep: ['REGISTRATION', 'CONFIRM_CREDENTIALS', 'CONFIRM_PHONE_RECYCLING', 'UNKNOWN', 'FAILURE'].includes(confirmed?.nextStep) ? confirmed.nextStep : 'UNKNOWN' });
    }
    if (typeof confirmed.authorizationCode !== 'string' || !confirmed.authorizationCode) {
      await store.saveState('login', stripPending(pending, 'failed'));
      throw fail('PROTOCOL_CHANGED', 'OpenTable login confirmation did not return an authorization code.');
    }
    await store.saveState('login', stripPending(pending, 'exchanging'));
    let candidate;
    try {
      const raw = await api.tokenRequest({ grant_type: 'authorization_code', ...passwordlessClient, code: confirmed.authorizationCode });
      candidate = tokenSession(raw, { sessionId: pending.sessionId, loginId: pending.loginId }, now());
      await store.saveState('candidate-session', candidate);
      await store.saveState('login', stripPending(pending, 'validating'));
    } catch (error) { await store.saveState('login', stripPending(pending, 'exchange_uncertain')); throw error; }
    try { return await validateCandidate(candidate, deps); }
    catch (error) { throw fail('LOGIN_VALIDATION_PENDING', 'The new session was saved, but account validation failed. Run auth refresh to validate it without repeating login.', { cause: error instanceof OpenTableError ? error.code : 'VALIDATION_FAILED' }); }
  });
}

export async function refreshLogin(options = {}) {
  const deps = dependencies(options), { store, now, client, fetchImpl } = deps;
  return store.withStateLock(async () => {
    let candidate = await store.readState('candidate-session');
    if (candidate?.accessToken && candidate.expiresAt > now() + 30_000) return validateCandidate(candidate, deps);
    const previous = candidate ?? await store.readState('session');
    if (!previous?.refreshToken) throw fail('LOGIN_REQUIRED', 'No refreshable OpenTable session is available. Request a new code.');
    const tokenHash = fingerprint(previous.refreshToken), attempt = await store.readState('refresh');
    if (attempt?.tokenHash === tokenHash && ['refreshing', 'uncertain'].includes(attempt.status)) throw fail('REFRESH_UNCERTAIN', 'The last refresh has an uncertain result and cannot be replayed. Request a new login.');
    await store.saveState('refresh', { version: 1, status: 'refreshing', startedAt: now(), tokenHash });
    try {
      const raw = await client({ sessionId: previous.sessionId, fetchImpl }).tokenRequest({ grant_type: 'refresh_token', ...passwordlessClient, refresh_token: previous.refreshToken });
      candidate = tokenSession(raw, previous, now());
      await store.saveState('candidate-session', candidate);
      await store.saveState('refresh', { version: 1, status: 'validating', startedAt: now(), tokenHash });
    } catch (error) { await store.saveState('refresh', { version: 1, status: 'uncertain', startedAt: now(), tokenHash }); throw error; }
    return validateCandidate(candidate, deps);
  });
}

export async function authStatus(options = {}) {
  const { store, now } = dependencies(options);
  return store.withStateLock(async () => {
    let pending = await store.readState('login');
    if (pending && ['starting', 'confirming', 'exchanging'].includes(pending.status)) { pending = stripPending(pending, `${pending.status}_uncertain`); await store.saveState('login', pending); }
    if (pending?.status === 'waiting' && pending.expiresAt <= now()) { pending = stripPending(pending, 'expired'); await store.saveState('login', pending); }
    const session = await store.readState('session'), candidate = await store.readState('candidate-session');
    return { authenticated: Boolean(session?.accessToken && session?.account && session.expiresAt > now()),
      account: session?.account ?? null, expiresAt: session?.expiresAt ? new Date(session.expiresAt).toISOString() : null,
      acquiredBy: session?.acquiredBy ?? null, login: loginResult(pending, now()), validationPending: Boolean(candidate?.accessToken) };
  });
}
export async function cancelLogin(options = {}) {
  const { store } = dependencies(options);
  return store.withStateLock(async () => {
    const pending = await store.readState('login'), candidate = await store.readState('candidate-session');
    await store.removeState('login');
    if (candidate?.loginId && candidate.loginId === pending?.loginId) await store.removeState('candidate-session');
    return { status: 'canceled', validationPending: Boolean(candidate && candidate.loginId !== pending?.loginId) };
  });
}
export async function logout(options = {}) {
  const { store } = dependencies(options);
  return store.withStateLock(async () => { for (const name of ['session', 'candidate-session', 'login', 'refresh']) await store.removeState(name); return { authenticated: false }; });
}
