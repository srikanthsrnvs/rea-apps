import { LinkedInError } from './errors.mjs';
import { ORIGIN, cookieHeader } from './session.mjs';

const AUTH_PATH = '/uas/authenticate';
const NATIVE_HEADERS = { Accept: 'application/json' };

function text(value, name, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000\r\n]/.test(value)) {
    throw new LinkedInError('INVALID_ARGUMENT', `Provide a valid ${name}.`);
  }
  return value;
}

function officialChallengeUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  let url;
  try { url = new URL(value, ORIGIN); } catch { throw new LinkedInError('PROTOCOL_CHANGED', 'LinkedIn returned an invalid verification URL.'); }
  if (url.origin !== ORIGIN || url.username || url.password) {
    throw new LinkedInError('UNSAFE_AUTH_RESPONSE', 'LinkedIn returned a verification URL outside its official sign-in origin.');
  }
  return url.href;
}

/** A successful native exchange still requires an authenticated profile query. */
export function nativeAuthResult({ status, data }) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new LinkedInError('PROTOCOL_CHANGED', 'LinkedIn returned an unrecognized authentication response.');
  }
  const result = typeof data.login_result === 'string' ? data.login_result : null;
  if (status === 200 && result === 'PASS') {
    return { authenticated: false, status: 'validation_required', loginResult: result };
  }
  if (status === 401 && result === 'CHALLENGE') {
    const verificationUrl = officialChallengeUrl(data.challenge_url);
    return { authenticated: false, status: 'verification_required', loginResult: result,
      ...(verificationUrl ? { verificationUrl } : {}),
      // The native app copies its WebView cookies after verification. Opening
      // this URL in a separate browser does not transfer that browser's session.
      completion: 'session_handoff_required' };
  }
  throw new LinkedInError('LOGIN_DENIED', 'LinkedIn did not accept this sign-in. Complete the account verification on LinkedIn if requested.',
    { status, ...(result && /^[A-Z_]{1,80}$/.test(result) ? { loginResult: result } : {}) });
}

function loginCookieFields(client) {
  const form = {};
  for (const pair of cookieHeader(client.session, ORIGIN + AUTH_PATH).split('; ')) {
    const equal = pair.indexOf('=');
    if (equal > 0) form[pair.slice(0, equal)] = pair.slice(equal + 1);
  }
  return form;
}

/** A fresh Google ID token obtained with native Google consent, not a password. */
export async function loginWithGoogleToken(client, { idToken } = {}) {
  text(idToken, 'Google ID token', 32_768);
  await client.request({ path: AUTH_PATH, headers: NATIVE_HEADERS });
  const form = { ...loginCookieFields(client), googleIdToken: idToken };
  // An ID token is an alternative credential in the native authenticate call.
  // Do not combine it with password, username, or remember-me form fields.
  for (const key of ['session_key', 'session_password', 'session_midToken', 'rememberMeOptIn']) delete form[key];
  const response = await client.request({ path: AUTH_PATH, method: 'POST', form,
    headers: NATIVE_HEADERS, allowStatuses: [401], responseMeta: true });
  return nativeAuthResult(response);
}

/**
 * Native LiAuthImpl.authenticate form contract. Never persist or print password.
 * The caller owns the state lock, session persistence, and profile validation.
 */
export async function loginWithPassword(client, { identifier, password, rememberMe = true } = {}) {
  text(identifier, 'LinkedIn email address or phone number', 128);
  text(password, 'LinkedIn password', 4096);
  if (typeof rememberMe !== 'boolean') throw new LinkedInError('INVALID_ARGUMENT', 'rememberMe must be a boolean.');
  // Establish LinkedIn's login cookies before submitting credentials. This is
  // also safe for sessions initialized with a locally generated CSRF value.
  await client.request({ path: AUTH_PATH, headers: NATIVE_HEADERS });
  const form = loginCookieFields(client);
  Object.assign(form, { session_key: identifier, session_password: password,
    rememberMeOptIn: rememberMe ? 'true' : 'false' });
  const response = await client.request({ path: AUTH_PATH, method: 'POST', form,
    headers: NATIVE_HEADERS, allowStatuses: [401], responseMeta: true });
  return nativeAuthResult(response);
}

/** Native WebView cookie exchange; caller must obtain the handoff separately. */
export async function completeWebLogin(client, cookies) {
  text(cookies, 'LinkedIn sign-in cookie handoff', 131_072);
  await client.request({ path: '/uas/issueLoginCookie', method: 'POST', form: { cookies },
    headers: NATIVE_HEADERS });
  return { authenticated: false, status: 'validation_required' };
}

/** Existing email-link tokens only; this does not request an email or SMS. */
export function passwordlessEmailTokens(input) {
  let url;
  try { url = new URL(input); } catch { throw new LinkedInError('INVALID_ARGUMENT', 'Provide an official LinkedIn passwordless email login link.'); }
  if (url.origin !== ORIGIN || url.username || url.password
    || url.pathname !== '/ssr-login/passwordless-email-login') {
    throw new LinkedInError('INVALID_ARGUMENT', 'Provide an official LinkedIn passwordless email login link.');
  }
  for (const key of ['midToken', 'otpToken']) {
    if (url.searchParams.getAll(key).length !== 1) throw new LinkedInError('INVALID_ARGUMENT', `The email login link requires one ${key}.`);
  }
  return { midToken: text(url.searchParams.get('midToken'), 'email login token', 16_384),
    otpToken: text(url.searchParams.get('otpToken'), 'email login token', 16_384) };
}

export async function checkPasswordlessEmailEligibility(client, link) {
  const tokens = passwordlessEmailTokens(link);
  const pairs = cookieHeader(client.session, ORIGIN + '/checkpoint/lg/passwordless-email-check-eligibility').split('; ');
  const bscookie = pairs.find(pair => pair.startsWith('bscookie='))?.slice('bscookie='.length);
  if (!bscookie) throw new LinkedInError('AUTH_CONTEXT_REQUIRED', 'Initialize LinkedIn sign-in before checking an email login link.');
  const data = await client.request({ path: '/checkpoint/lg/passwordless-email-check-eligibility', method: 'POST',
    body: { bscookie, ...tokens }, headers: NATIVE_HEADERS });
  if (!data || typeof data.eligibilityResult !== 'string') {
    throw new LinkedInError('PROTOCOL_CHANGED', 'LinkedIn returned an unrecognized email login eligibility response.');
  }
  return { eligible: data.eligibilityResult === 'PASS', authenticated: false };
}
