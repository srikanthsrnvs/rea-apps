import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { AUTH_CONFIG, AUTH_FLOW_VERSION, createAuthAttempt, authorizationCodeGrant, refreshTokenGrant,
  parseAuthorizationCallback, parseTokenResponse } from './auth-protocol.mjs';
import { createDPoP, createProofKey } from './native-crypto.mjs';
import { requestJson } from './http.mjs';
import { readState, saveState, removeState, withStateLock } from './state.mjs';
import { parseAccount } from './chat-read-protocol.mjs';
import { ChatGptError } from './errors.mjs';
import { nativeHeaders } from './client-profile.mjs';
import { DEVICE_AUTH_CONFIG, deviceCodeRequest, parseDeviceCodeResponse,
  deviceTokenPollRequest, parseDeviceTokenPollResponse, deviceCodeGrant } from './device-auth-protocol.mjs';

export const API_BASE = 'https://android.chat.openai.com/backend-api/';
const binding = session => session?.generation ?? null;
const summary = session => ({ id: session.account.id, email: session.account.email, name: session.account.name });

export function accountHeaders(session, url, method = 'GET') {
  const target = new URL(url);
  if (target.protocol === 'wss:') target.protocol = 'https:';
  const headers = { ...nativeHeaders(session.deviceId), authorization: `Bearer ${session.accessToken}` };
  if (session.privateJwk) {
    headers.DPoP = createDPoP({ privateJwk: session.privateJwk, url: target.href, method, accessToken: session.accessToken });
    headers.authorization = `DPoP ${session.accessToken}`;
  }
  return headers;
}

async function validateIdentity(idToken, pending, fetcher) {
  if (!idToken) return;
  let header, claims, parts;
  try {
    parts = idToken.split('.');
    if (parts.length !== 3) throw new Error();
    header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  } catch { throw new ChatGptError('INVALID_ID_TOKEN', 'OpenAI returned an invalid identity token.'); }
  if (!['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string') {
    throw new ChatGptError('INVALID_ID_TOKEN', 'OpenAI returned an unsupported identity signature.');
  }
  const discovery = await requestJson(`${AUTH_CONFIG.issuer}/.well-known/openid-configuration`, { fetcher });
  const jwksUrl = new URL(discovery.jwks_uri);
  if (discovery.issuer !== AUTH_CONFIG.issuer || jwksUrl.origin !== AUTH_CONFIG.issuer) {
    throw new ChatGptError('INVALID_ID_TOKEN', 'The identity key source does not match OpenAI.');
  }
  const jwks = await requestJson(jwksUrl.href, { fetcher });
  const key = jwks.keys?.find(candidate => candidate.kid === header.kid && (!candidate.alg || candidate.alg === header.alg));
  if (!key) throw new ChatGptError('INVALID_ID_TOKEN', 'The identity signature key was not found.');
  const publicKey = createPublicKey({ key, format: 'jwk' });
  if (!verify('sha256', Buffer.from(parts.slice(0, 2).join('.')),
    header.alg === 'ES256' ? { key: publicKey, dsaEncoding: 'ieee-p1363' } : publicKey,
    Buffer.from(parts[2], 'base64url'))) throw new ChatGptError('INVALID_ID_TOKEN', 'The identity signature did not validate.');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== AUTH_CONFIG.issuer || !audience.includes(pending.clientId)
    || (pending.nonce !== undefined && claims.nonce !== pending.nonce)
    || !Number.isFinite(claims.exp) || claims.exp * 1000 < Date.now() - 60_000) {
    throw new ChatGptError('INVALID_ID_TOKEN', 'The identity token does not match this login attempt.');
  }
}

function deviceLoginResult(pending) {
  return { status: 'sign_in_required', method: 'device', loginId: pending.id,
    approvalUrl: pending.verificationUrl, userCode: pending.userCode.replace(/-/g, ''),
    expiresAt: new Date(pending.expiresAt).toISOString(),
    retryAfterMs: Math.max(0, (pending.nextPollAt ?? 0) - Date.now()),
    instructions: 'Open approvalUrl in your own browser, sign in, and enter userCode. Enable device code sign-in in ChatGPT Security settings if asked. Then run auth poll with this loginId.' };
}

export async function login({ email, replace = false, fetcher = globalThis.fetch } = {}) {
  return withStateLock(async () => {
    const session = await readState('session');
    if (session && !replace && !session.refreshPending && session.expiresAt > Date.now()) {
      return { status: 'authenticated', account: summary(session) };
    }
    let pending = await readState('pending-login');
    if (pending?.method === 'device' && pending.expiresAt > Date.now()) {
      if (pending.phase === 'awaiting_device') return deviceLoginResult(pending);
      throw new ChatGptError('LOGIN_IN_PROGRESS', 'Use auth poll to finish this login, or auth cancel to discard it.');
    }
    if (pending && !['awaiting_device', 'awaiting_callback'].includes(pending.phase)) {
      throw new ChatGptError('LOGIN_IN_PROGRESS', 'Inspect auth status before replacing an unfinished login.');
    }
    pending = { id: randomUUID(), method: 'device', flowVersion: DEVICE_AUTH_CONFIG.flowVersion,
      clientId: DEVICE_AUTH_CONFIG.clientId, redirectUri: DEVICE_AUTH_CONFIG.redirectUri,
      deviceId: randomUUID(), email, previousBinding: binding(session), phase: 'requesting_code',
      expiresAt: Date.now() + DEVICE_AUTH_CONFIG.maxLifetimeMs };
    await saveState('pending-login', pending);
    const request = deviceCodeRequest();
    const code = parseDeviceCodeResponse(await requestJson(request.url, {
      method: request.method, json: request.body, fetcher,
    }));
    Object.assign(pending, code, { phase: 'awaiting_device', nextPollAt: Date.now() });
    await saveState('pending-login', pending);
    return deviceLoginResult(pending);
  });
}

// Retained for protocol research and recovery of already-issued native callbacks.
// The CLI does not offer this Android-only flow as a new login.
export async function loginAndroid({ email, replace = false } = {}) {
  return withStateLock(async () => {
    const session = await readState('session');
    if (session && !replace && !session.refreshPending && session.expiresAt > Date.now()) {
      return { status: 'authenticated', account: summary(session) };
    }
    let pending = await readState('pending-login');
    if (pending && pending.phase !== 'awaiting_callback') {
      throw new ChatGptError('LOGIN_IN_PROGRESS', 'Inspect auth status before replacing an unfinished token exchange.');
    }
    if (!pending || pending.expiresAt <= Date.now() || pending.flowVersion !== AUTH_FLOW_VERSION) {
      pending = { ...createAuthAttempt({ email }), email, phase: 'awaiting_callback', privateJwk: createProofKey(),
        previousBinding: binding(session), expiresAt: Date.now() + 20 * 60_000 };
      await saveState('pending-login', pending);
    }
    return { status: 'sign_in_required', loginId: pending.id, approvalUrl: pending.request.url,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      instructions: 'Open approvalUrl in your own browser. Sign in to ChatGPT, then copy the final Open ChatGPT button link and supply it to auth complete --callback-url.' };
  });
}

async function finishLogin(pending, fetcher) {
  await validateIdentity(pending.tokens.idToken, pending, fetcher);
  const candidate = { ...pending.tokens, deviceId: pending.deviceId,
    ...(pending.privateJwk ? { privateJwk: pending.privateJwk } : {}),
    clientId: pending.clientId, generation: pending.id,
    authMethod: pending.method ?? 'android', grantEncoding: pending.method === 'device' ? 'form' : 'json',
    expiresAt: pending.tokenReceivedAt + pending.tokens.expiresIn * 1000 };
  const url = new URL('me', API_BASE).href;
  const account = parseAccount(await requestJson(url, { headers: accountHeaders(candidate, url), fetcher }));
  if (pending.email && account.email?.toLowerCase() !== pending.email.toLowerCase()) {
    throw new ChatGptError('ACCOUNT_MISMATCH', 'ChatGPT returned a different account from the requested email.');
  }
  candidate.account = { id: account.id, email: account.email, name: account.name };
  candidate.validatedAt = new Date().toISOString();
  await saveState('session', candidate);
  await removeState('pending-login');
  return { status: 'authenticated', method: candidate.authMethod, account: summary(candidate), validation: 'independent_account_read' };
}

export async function pollLogin({ loginId, fetcher = globalThis.fetch } = {}) {
  return withStateLock(async () => {
    const pending = await readState('pending-login');
    const session = await readState('session');
    if (!pending && session && session.generation === loginId) {
      return { status: 'authenticated', method: session.authMethod, account: summary(session), validation: 'independent_account_read' };
    }
    if (!pending || pending.id !== loginId || pending.method !== 'device') {
      throw new ChatGptError('LOGIN_NOT_FOUND', 'Use the device loginId returned by login.');
    }
    if (binding(session) !== pending.previousBinding) throw new ChatGptError('SESSION_CHANGED', 'The saved account changed during login.');
    if (pending.expiresAt <= Date.now() && pending.phase !== 'validating') throw new ChatGptError('LOGIN_EXPIRED', 'Start a fresh login.');
    if (pending.phase === 'awaiting_device') {
      if (Date.now() < pending.nextPollAt) return deviceLoginResult(pending);
      pending.nextPollAt = Date.now() + pending.intervalMs;
      await saveState('pending-login', pending);
      const request = deviceTokenPollRequest(pending);
      let response;
      try { response = await requestJson(request.url, { method: request.method, json: request.body, fetcher }); }
      catch (error) {
        if (error.code === 'HTTP_ERROR' && [403, 404].includes(error.details?.status)) return deviceLoginResult(pending);
        throw error;
      }
      pending.grant = parseDeviceTokenPollResponse(response);
      pending.phase = 'code_received';
      await saveState('pending-login', pending);
    }
    if (pending.phase === 'code_received') {
      const grant = deviceCodeGrant(pending.grant);
      pending.phase = 'exchanging';
      await saveState('pending-login', pending);
      const response = await requestJson(DEVICE_AUTH_CONFIG.tokenUrl, { method: 'POST',
        body: new URLSearchParams(grant), headers: { 'content-type': 'application/x-www-form-urlencoded' }, fetcher });
      pending.tokens = parseTokenResponse(response);
      pending.tokenReceivedAt = Date.now();
      pending.phase = 'validating';
      delete pending.grant;
      await saveState('pending-login', pending);
    }
    if (pending.phase !== 'validating') {
      throw new ChatGptError('LOGIN_OUTCOME_UNKNOWN', 'The previous login request has an unknown outcome and was not retried.');
    }
    return finishLogin(pending, fetcher);
  });
}

export async function completeLogin({ loginId, callbackUrl, fetcher = globalThis.fetch } = {}) {
  return withStateLock(async () => {
    const pending = await readState('pending-login');
    if (!pending || pending.id !== loginId) throw new ChatGptError('LOGIN_NOT_FOUND', 'Use the loginId returned by login.');
    if (binding(await readState('session')) !== pending.previousBinding) throw new ChatGptError('SESSION_CHANGED', 'The saved account changed during this login.');
    if (pending.expiresAt <= Date.now()) throw new ChatGptError('LOGIN_EXPIRED', 'Start a fresh login.');
    if (pending.phase === 'awaiting_callback') {
      const { code } = parseAuthorizationCallback(callbackUrl, pending);
      const grant = authorizationCodeGrant({ code, verifier: pending.pkce.verifier, clientId: pending.clientId, redirectUri: pending.redirectUri });
      pending.phase = 'exchanging';
      await saveState('pending-login', pending);
      const result = await requestJson(AUTH_CONFIG.tokenUrl, { method: 'POST', json: grant, fetcher,
        headers: { ...nativeHeaders(pending.deviceId), DPoP: createDPoP({ privateJwk: pending.privateJwk, url: AUTH_CONFIG.tokenUrl }), 'oai-uit': 'True' } });
      pending.tokens = parseTokenResponse(result);
      pending.tokenReceivedAt = Date.now();
      pending.phase = 'validating';
      await saveState('pending-login', pending);
    }
    if (pending.phase !== 'validating') throw new ChatGptError('LOGIN_OUTCOME_UNKNOWN', 'The previous token exchange has an unknown outcome and was not retried.');
    return finishLogin(pending, fetcher);
  });
}

async function getSessionUnlocked(fetcher) {
  let session = await readState('session');
  if (!session) throw new ChatGptError('LOGIN_REQUIRED', 'Run chatgpt login first.');
  if (session.refreshPending) throw new ChatGptError('REFRESH_OUTCOME_UNKNOWN', 'A previous token refresh did not finish locally. Sign in again to recover without reusing an uncertain refresh token.');
  if (session.expiresAt > Date.now() + 60_000) return session;
  if (!session.refreshToken) throw new ChatGptError('LOGIN_EXPIRED', 'Sign in again to refresh this session.');
  const grant = refreshTokenGrant({ refreshToken: session.refreshToken, clientId: session.clientId });
  session.refreshPending = { id: randomUUID(), startedAt: new Date().toISOString() };
  await saveState('session', session);
  const transport = session.grantEncoding === 'form'
    ? { body: new URLSearchParams(grant), headers: { 'content-type': 'application/x-www-form-urlencoded' } }
    : { json: grant, headers: { ...nativeHeaders(session.deviceId),
      ...(session.privateJwk ? { DPoP: createDPoP({ privateJwk: session.privateJwk, url: AUTH_CONFIG.tokenUrl }) } : {}), 'oai-uit': 'True' } };
  const result = await requestJson(AUTH_CONFIG.tokenUrl, { method: 'POST', ...transport, fetcher });
  const tokens = parseTokenResponse(result);
  session = { ...session, ...tokens, expiresAt: Date.now() + tokens.expiresIn * 1000 };
  delete session.refreshPending;
  await saveState('session', session);
  return session;
}

export async function authorizedSession({ fetcher = globalThis.fetch } = {}) {
  return withStateLock(() => getSessionUnlocked(fetcher));
}

export async function authStatus() {
  return withStateLock(async () => {
    const session = await readState('session'), pending = await readState('pending-login');
    return { authenticated: !!session, account: session ? summary(session) : null, validatedAt: session?.validatedAt ?? null,
      expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
      pending: pending ? { loginId: pending.id, status: pending.phase, method: pending.method ?? 'android',
        expiresAt: new Date(pending.expiresAt).toISOString(),
        ...(pending.method === 'device' && pending.phase === 'awaiting_device'
          ? { approvalUrl: pending.verificationUrl, userCode: pending.userCode.replace(/-/g, ''),
            retryAfterMs: Math.max(0, pending.nextPollAt - Date.now()) } : {}) } : null };
  });
}

export async function cancelLogin({ loginId } = {}) {
  return withStateLock(async () => {
    const pending = await readState('pending-login');
    if (!pending || pending.id !== loginId) throw new ChatGptError('LOGIN_NOT_FOUND', 'Use the current loginId.');
    await removeState('pending-login');
    return { status: 'cancelled' };
  });
}

export async function logout() {
  return withStateLock(async () => {
    await removeState('session');
    await removeState('pending-login');
    return { status: 'logged_out' };
  });
}
