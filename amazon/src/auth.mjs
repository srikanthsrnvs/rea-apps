import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { AmazonClient, CookieJar } from './http.mjs';
import { AmazonError } from './errors.mjs';
import { readState, saveState, removeState, withStateLock } from './state.mjs';
import { AMAZON_AUTH, createCodePairRequest, parseCodePairResponse, registerCodePairRequest, parseRegistrationResponse, refreshTokenRequest, parseRefreshResponse, refreshCookiesRequest, parseCookiesRefreshResponse } from './auth-protocol.mjs';

const CREDENTIAL_JOURNALS = ['auth-refresh', 'auth-cookies'];
const fail = (code, message, details) => { throw new AmazonError(code, message, details); };
function account(session) { return { name: session.customer?.name ?? session.customer?.givenName ?? null }; }
// Bind recovered results to the account, CLI device, and credentials that sent
// the request. Cookie changes from ordinary reads do not change this identity.
function binding(session) {
  if (!session) return null;
  return createHash('sha256').update(JSON.stringify({ customerId: session.customerId, profile: session.profile,
    accessToken: session.accessToken, refreshToken: session.refreshToken, secureSessionToken: session.secureSessionToken,
    authGeneration: session.authGeneration })).digest('hex');
}
function publicPending(pending) {
  return { loginId: pending.id, status: pending.phase === 'ready' ? 'approval_required' : pending.phase,
    approvalUrl: pending.pair ? AMAZON_AUTH.approvalUrl : null, code: pending.pair?.publicCode ?? null,
    expiresAt: pending.expiresAt, error: pending.error ?? null };
}
async function request(client, operation) {
  const response = await client.request(operation.url, { method: operation.method, headers: operation.headers,
    ...(operation.encoding === 'form' ? { form: operation.body } : { json: operation.body }),
    includeCookies: operation.includeCookies === true, responseType: 'response' });
  let payload;
  try { payload = JSON.parse(response.text); } catch { payload = null; }
  return { httpStatus: response.status, receivedAt: Date.now(), payload,
    ...(operation.includeCookies ? { transportCookies: client.jar.cookies } : {}) };
}
function requireSuccess(response, code, message) {
  if (response?.httpStatus !== 200) fail(code, message, { httpStatus: response?.httpStatus ?? null });
}
function applyRefresh(session, response) {
  requireSuccess(response, 'SESSION_NOT_VALIDATED', 'Amazon did not validate the session. Any saved account was preserved.');
  return { ...session, ...parseRefreshResponse(response.payload, { now: response.receivedAt }), validatedAt: new Date(response.receivedAt).toISOString() };
}
function applyCookies(session, response) {
  requireSuccess(response, 'COOKIES_NOT_REFRESHED', 'Amazon did not renew the shopping session. Any saved account was preserved.');
  const refreshed = parseCookiesRefreshResponse(response.payload), jar = new CookieJar(session.cookies);
  jar.merge(response.transportCookies ?? []);
  jar.merge(refreshed.cookies);
  return { ...session, ...refreshed, cookies: jar.cookies, cookiesRefreshedAt: new Date(response.receivedAt).toISOString() };
}
async function assertNoCredentialJournal(except) {
  for (const name of CREDENTIAL_JOURNALS) {
    if (name !== except && await readState(name)) fail('AUTH_OPERATION_PENDING', 'Finish the pending authentication operation before changing or using these credentials.');
  }
}
function checkSavedAccount(pending, current) {
  if (!Object.hasOwn(pending, 'savedSessionBinding')) fail('LOGIN_STATE_UNBOUND', 'Cancel this old pending login and start a new one.');
  const currentBinding = binding(current);
  if (currentBinding !== pending.savedSessionBinding && currentBinding !== pending.committedBinding)
    fail('SESSION_CHANGED', 'The saved account changed after this login started. Its credentials were preserved.');
}
export async function login({ replace = false } = {}) {
  return withStateLock(async () => {
    const session = await readState('session');
    if (session && !replace) return { status: 'authenticated', account: account(session), validation: 'saved_session', validatedAt: session.validatedAt };
    const previous = await readState('pending-login');
    // Known registration/validation results survive the pairing code's expiry.
    if (previous && (previous.phase !== 'ready' || Date.parse(previous.expiresAt) > Date.now())) return publicPending(previous);
    const profile = { appName: AMAZON_AUTH.appName, appVersion: AMAZON_AUTH.appVersion, deviceType: AMAZON_AUTH.deviceType,
      deviceSerial: randomUUID().replaceAll('-', ''), deviceModel: `${os.type()} ${os.arch()}`, osVersion: os.release() };
    const pending = { id: randomUUID(), phase: 'creating', profile, savedSessionBinding: binding(session), expiresAt: new Date(Date.now() + 15 * 60000).toISOString() };
    await saveState('pending-login', pending);
    const response = await request(new AmazonClient(), createCodePairRequest(profile));
    pending.lastResponse = response;
    pending.phase = 'response_received';
    await saveState('pending-login', pending);
    requireSuccess(response, 'PAIRING_REJECTED', 'Amazon did not issue a pairing code. Inspect auth status before starting again.');
    pending.pair = parseCodePairResponse(response.payload);
    pending.expiresAt = new Date(response.receivedAt + pending.pair.expiresIn * 1000).toISOString();
    pending.phase = 'ready';
    delete pending.lastResponse;
    await saveState('pending-login', pending);
    return publicPending(pending);
  });
}
export async function completeLogin({ loginId } = {}) {
  return withStateLock(async () => {
    const pending = await readState('pending-login');
    if (!pending || pending.id !== loginId) fail('LOGIN_NOT_FOUND', 'Use the loginId returned by amazon login.');
    checkSavedAccount(pending, await readState('session'));
    const recoverable = ['ready', 'registration_received', 'validation_received', 'cookies_received', 'commit_pending'];
    if (!recoverable.includes(pending.phase)) fail('LOGIN_OUTCOME_UNKNOWN', 'A previous request has an uncertain outcome and was not replayed.');
    if (pending.phase === 'ready') {
      if (Date.parse(pending.expiresAt) <= Date.now()) fail('LOGIN_EXPIRED', 'This pairing code expired. Cancel this login and start again.');
      const operation = registerCodePairRequest(pending.profile, pending.pair);
      pending.phase = 'submission_pending';
      await saveState('pending-login', pending);
      pending.registration = await request(new AmazonClient(), operation);
      pending.phase = 'registration_received';
      await saveState('pending-login', pending);
    }
    if (pending.phase === 'registration_received') {
      requireSuccess(pending.registration, 'REGISTRATION_REJECTED', 'Amazon did not authorize device registration. Any saved account was preserved.');
      pending.candidate = { ...parseRegistrationResponse(pending.registration.payload, { now: pending.registration.receivedAt }), profile: pending.profile, authGeneration: pending.id };
      const operation = refreshTokenRequest(pending.candidate.profile, pending.candidate);
      pending.phase = 'validation_pending';
      await saveState('pending-login', pending);
      pending.validation = await request(new AmazonClient(), operation);
      pending.phase = 'validation_received';
      await saveState('pending-login', pending);
    }
    if (pending.phase === 'validation_received') {
      pending.candidate = applyRefresh(pending.candidate, pending.validation);
      const operation = refreshCookiesRequest(pending.candidate.profile, pending.candidate);
      pending.phase = 'cookies_pending';
      await saveState('pending-login', pending);
      pending.cookieResponse = await request(new AmazonClient({ cookies: pending.candidate.cookies }), operation);
      pending.phase = 'cookies_received';
      await saveState('pending-login', pending);
    }
    if (pending.phase === 'cookies_received') {
      pending.completedSession = applyCookies(pending.candidate, pending.cookieResponse);
      pending.committedBinding = binding(pending.completedSession);
      pending.phase = 'commit_pending';
      await saveState('pending-login', pending);
    }
    checkSavedAccount(pending, await readState('session'));
    const session = pending.completedSession;
    if (!session || binding(session) !== pending.committedBinding) fail('LOGIN_STATE_INVALID', 'The saved login result is incomplete.');
    await saveState('session', session);
    for (const name of CREDENTIAL_JOURNALS) await removeState(name);
    await removeState('pending-login');
    return { status: 'authenticated', account: account(session), shoppingCookieCount: session.cookies.length, validation: 'fresh_token_refresh', cookieRenewal: 'native_http' };
  });
}
export async function authStatus() {
  return withStateLock(async () => {
    const session = await readState('session'), pending = await readState('pending-login');
    const operations = [];
    for (const kind of CREDENTIAL_JOURNALS) {
      const journal = await readState(kind);
      if (journal) operations.push({ kind, status: journal.phase });
    }
    return { authenticated: !!session, account: session ? account(session) : null, validatedAt: session?.validatedAt ?? null,
      pending: pending ? publicPending(pending) : null, credentialOperations: operations };
  });
}
async function credentialOperation(kind, build, apply) {
  return withStateLock(async () => {
    const session = await readState('session');
    if (!session) fail('LOGIN_REQUIRED', 'Use amazon login and approve its code on Amazon’s website.');
    await assertNoCredentialJournal(kind);
    let journal = await readState(kind);
    if (journal && binding(session) !== journal.binding && binding(session) !== journal.committedBinding)
      fail('SESSION_CHANGED', 'This authentication result belongs to different saved credentials and was not applied.');
    if (!journal) {
      const operation = build(session.profile, session);
      journal = { id: randomUUID(), kind, phase: 'submission_pending', binding: binding(session), createdAt: new Date().toISOString() };
      await saveState(kind, journal);
      journal.response = await request(new AmazonClient({ cookies: session.cookies }), operation);
      journal.phase = 'response_received';
      await saveState(kind, journal);
    }
    if (journal.phase === 'submission_pending') fail('AUTH_OUTCOME_UNKNOWN', 'A previous authentication request has an uncertain outcome and was not replayed. Start a new login to recover.');
    if (journal.phase === 'response_received') {
      journal.completedSession = apply(session, journal.response);
      journal.committedBinding = binding(journal.completedSession);
      journal.phase = 'commit_pending';
      await saveState(kind, journal);
    }
    if (journal.phase !== 'commit_pending' || !journal.completedSession || binding(journal.completedSession) !== journal.committedBinding)
      fail('AUTH_JOURNAL_INVALID', 'The saved authentication operation is incomplete.');
    // The mutex prevents a simultaneous command from changing the account here.
    await saveState('session', journal.completedSession);
    await removeState(kind);
    return { status: 'authenticated', account: account(journal.completedSession), ...(kind === 'auth-cookies' ? { shoppingCookieCount: journal.completedSession.cookies.length } : { validation: 'fresh_token_refresh' }) };
  });
}
export async function refreshLogin() { return credentialOperation('auth-refresh', refreshTokenRequest, applyRefresh); }
export async function refreshShoppingCookies() { return credentialOperation('auth-cookies', refreshCookiesRequest, applyCookies); }
export async function cancelLogin({ loginId } = {}) {
  return withStateLock(async () => {
    const pending = await readState('pending-login');
    if (pending && pending.id !== loginId) fail('LOGIN_NOT_FOUND', 'Use the current loginId.');
    await removeState('pending-login');
    return { status: 'cancelled' };
  });
}
export async function logout() {
  return withStateLock(async () => {
    await removeState('session'); await removeState('pending-login');
    for (const name of CREDENTIAL_JOURNALS) await removeState(name);
    return { status: 'logged_out' };
  });
}
export async function withClient(operation, { authenticated = false } = {}) {
  return withStateLock(async () => {
    const session = await readState('session');
    if (!session && authenticated) fail('LOGIN_REQUIRED', 'Use amazon login before accessing your account.');
    if (session) await assertNoCredentialJournal();
    const client = new AmazonClient({ cookies: session?.cookies });
    try { return await operation(client, session); }
    finally { if (session) await saveState('session', { ...session, cookies: client.jar.cookies }); }
  });
}
