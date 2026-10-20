import { randomBytes, randomUUID } from 'node:crypto';
import { ChatGptError } from './errors.mjs';
import { createPKCE } from './native-crypto.mjs';

export const AUTH_FLOW_VERSION = 'android-browser-preauth-fallback-v1';

// Public application configuration recovered from the shipped Android client.
export const AUTH_CONFIG = Object.freeze({
  clientId: 'app_xwBKzt04752TTSfXnki17hmB',
  appVersion: '1.2026.286',
  issuer: 'https://auth.openai.com',
  authorizeUrl: 'https://auth.openai.com/api/accounts/authorize',
  nextUrl: 'https://auth.openai.com/api/first_party_authorize/next',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  redirectUri: 'com.openai.chatgpt://auth.openai.com/android/com.openai.chatgpt/callback',
  audience: 'https://api.openai.com/v1',
  scopes: Object.freeze(['openid', 'email', 'profile', 'offline_access', 'model.request', 'model.read', 'organization.read', 'organization.write']),
  capabilities: Object.freeze(['email_otp_deeplink', 'default_otp_v2', 'login_methods']),
});

function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new ChatGptError('INVALID_AUTH_INPUT', `${label} must be a nonempty single-line string.`);
  }
  return value;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChatGptError('INVALID_AUTH_RESPONSE', `${label} must be an object.`);
  }
  return value;
}

export function createAuthAttempt(options = {}) {
  const attempt = {
    flowVersion: AUTH_FLOW_VERSION,
    id: randomUUID(),
    deviceId: options.deviceId ?? randomUUID(),
    state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'),
    pkce: createPKCE(),
    clientId: options.clientId ?? AUTH_CONFIG.clientId,
    redirectUri: options.redirectUri ?? AUTH_CONFIG.redirectUri,
  };
  return { ...attempt, request: buildBrowserAuthorizeRequest({ ...options, ...attempt }) };
}

// REA: pne0.b builds this query; q67.<clinit> supplies the default scopes.
export function buildAuthorizeRequest({
  pkce, challenge = pkce?.challenge, state, nonce, deviceId, email,
  clientId = AUTH_CONFIG.clientId, redirectUri = AUTH_CONFIG.redirectUri,
  scopes = AUTH_CONFIG.scopes, capabilities = AUTH_CONFIG.capabilities,
} = {}) {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge ?? '')) {
    throw new ChatGptError('INVALID_AUTH_INPUT', 'A valid S256 PKCE challenge is required.');
  }
  if (!Array.isArray(scopes) || !scopes.length || scopes.some(s => typeof s !== 'string' || !/^[\w.:-]+$/.test(s))) {
    throw new ChatGptError('INVALID_AUTH_INPUT', 'Scopes must be nonempty scope names.');
  }
  if (!Array.isArray(capabilities) || capabilities.some(s => typeof s !== 'string' || !/^[\w.-]+$/.test(s))) {
    throw new ChatGptError('INVALID_AUTH_INPUT', 'Capabilities must be capability names.');
  }
  const url = new URL(AUTH_CONFIG.authorizeUrl);
  const params = {
    scope: scopes.join(' '), audience: AUTH_CONFIG.audience, response_type: 'code',
    client_id: text(clientId, 'Client ID'), redirect_uri: text(redirectUri, 'Redirect URI'),
    code_challenge: challenge, code_challenge_method: 'S256',
    state: text(state, 'OAuth state'), nonce: text(nonce, 'OAuth nonce'),
    requester_metadata_app_version: AUTH_CONFIG.appVersion,
    android_device_id: text(deviceId, 'Device ID'), issuer: AUTH_CONFIG.issuer,
    screen_hint: 'login_or_signup', hydra_flow: 'condense',
  };
  if (capabilities.length) params.ccaps = capabilities.join(' ');
  if (email !== undefined) params.login_hint = text(email, 'Email');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return { method: 'GET', url: url.href, headers: { Accept: 'application/json' } };
}

// REA: m2q0 invokes nne0.a with native=false, then merges s731 parameters.
// j931 supplies either a genuine preauth cookie or an honest failure category.
export function buildBrowserAuthorizeRequest(options = {}) {
  const { preauthCookie, preauthCookieFailure, ...authOptions } = options;
  if (preauthCookie !== undefined && preauthCookieFailure !== undefined) {
    throw new ChatGptError('INVALID_AUTH_INPUT', 'Provide a preauthorization cookie or its failure category, not both.');
  }
  const request = buildAuthorizeRequest({ ...authOptions, email: undefined });
  const url = new URL(request.url);
  for (const key of ['issuer', 'ccaps', 'screen_hint', 'hydra_flow', 'app_hash']) url.searchParams.delete(key);
  const scopes = new Set(url.searchParams.get('scope').split(' '));
  scopes.add('openid');
  url.searchParams.set('scope', [...scopes].join(' '));
  if (preauthCookie !== undefined) {
    url.searchParams.set('preauth_cookie', text(preauthCookie, 'Preauthorization cookie'));
  } else {
    // The CLI has no Android integrity provider; this is the app's failure path.
    url.searchParams.set('preauth_cookie_failed', text(preauthCookieFailure ?? 'other', 'Preauthorization failure category'));
  }
  return { method: 'GET', url: url.href, headers: { Accept: 'text/html' } };
}

export function buildNativeStep(originPageType, data) {
  text(originPageType, 'Origin page type');
  if (!/^[a-z][a-z0-9_]*$/.test(originPageType)) {
    throw new ChatGptError('INVALID_AUTH_INPUT', 'Invalid origin page type.');
  }
  const body = { origin_page_type: originPageType };
  if (data !== undefined) body.data = object(data, 'Step data');
  return { method: 'POST', url: AUTH_CONFIG.nextUrl, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body };
}

export function buildUsernameStep(email, originPageType = 'login_or_signup_start') {
  return buildNativeStep(originPageType, { username: { value: text(email, 'Email'), kind: 'email' } });
}

export function buildEmailCodeStep(code, { intent = 'validate', originPageType = 'email_otp_verification' } = {}) {
  if (!['validate', 'resend'].includes(intent)) {
    throw new ChatGptError('INVALID_AUTH_INPUT', 'Email verification intent must be validate or resend.');
  }
  if (intent === 'validate' && (typeof code !== 'string' || !/^\d{6}$/.test(code))) {
    throw new ChatGptError('INVALID_AUTH_INPUT', 'Enter the six-digit email verification code.');
  }
  return buildNativeStep(originPageType, { code: intent === 'resend' ? '' : code, intent });
}

export function authorizationCodeGrant({ code, verifier, clientId = AUTH_CONFIG.clientId, redirectUri = AUTH_CONFIG.redirectUri }) {
  return { client_id: text(clientId, 'Client ID'), code: text(code, 'Authorization code'), code_verifier: text(verifier, 'PKCE verifier'), redirect_uri: text(redirectUri, 'Redirect URI'), grant_type: 'authorization_code' };
}

export function refreshTokenGrant({ refreshToken, clientId = AUTH_CONFIG.clientId }) {
  return { client_id: text(clientId, 'Client ID'), refresh_token: text(refreshToken, 'Refresh token'), grant_type: 'refresh_token' };
}

export function nativeTokenGrant({ subjectToken, clientId = AUTH_CONFIG.clientId, scopes = AUTH_CONFIG.scopes }) {
  return { client_id: text(clientId, 'Client ID'), scope: scopes.join(' '), subject_token: text(subjectToken, 'Native identity token'), grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token_type: 'urn:authapi:id-token' };
}

export function parseAuthorizationCallback(value, { state, redirectUri = AUTH_CONFIG.redirectUri }) {
  let url;
  try { url = new URL(text(value, 'Callback URL')); } catch {
    throw new ChatGptError('INVALID_AUTH_CALLBACK', 'Provide the complete authorization callback URL.');
  }
  const expected = new URL(redirectUri);
  if (url.protocol !== expected.protocol || url.host !== expected.host || url.pathname !== expected.pathname || url.username || url.password || url.hash) {
    throw new ChatGptError('INVALID_AUTH_CALLBACK', 'The callback does not match this login attempt.');
  }
  if (url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== text(state, 'OAuth state')) {
    throw new ChatGptError('AUTH_STATE_MISMATCH', 'The callback belongs to a different login attempt.');
  }
  if (url.searchParams.has('error')) {
    throw new ChatGptError('AUTHORIZATION_DENIED', 'Authorization was not completed.');
  }
  if (url.searchParams.getAll('code').length !== 1) {
    throw new ChatGptError('INVALID_AUTH_CALLBACK', 'The callback must contain one authorization code.');
  }
  return { code: text(url.searchParams.get('code'), 'Authorization code'), state };
}

// This is protocol parsing only; a page transition is never proof of login.
export function parseAuthPage(value) {
  const response = object(value, 'Authorization response');
  const page = object(response.page, 'Authorization page');
  const type = text(page.type, 'Authorization page type');
  const payload = page.payload == null ? {} : object(page.payload, 'Authorization page payload');
  return { type, payload, errors: page.errors ?? null, page };
}

export function parseTokenResponse(value) {
  const response = object(value, 'Token response');
  if (response.error) throw new ChatGptError('TOKEN_EXCHANGE_FAILED', 'The account service rejected the token exchange.');
  const accessToken = text(response.access_token, 'Access token');
  const expiresIn = response.expires_in;
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new ChatGptError('INVALID_AUTH_RESPONSE', 'The token response must include a positive lifetime.');
  }
  const tokenType = response.token_type ?? 'Bearer';
  if (!['bearer', 'dpop'].includes(String(tokenType).toLowerCase())) {
    throw new ChatGptError('INVALID_AUTH_RESPONSE', 'The token response uses an unsupported token type.');
  }
  return {
    accessToken, tokenType, expiresIn,
    ...(response.refresh_token ? { refreshToken: text(response.refresh_token, 'Refresh token') } : {}),
    ...(response.id_token ? { idToken: text(response.id_token, 'Identity token') } : {}),
    ...(response.scope ? { scope: text(response.scope, 'Scope') } : {}),
  };
}
