import { randomUUID } from 'node:crypto';
import { OpenTableError } from './errors.mjs';

export const apiOrigin = 'https://mobile-api.opentable.com';
// Recovered client compatibility profile, not the host's OS or display.
// Native deviceHash is a random UUID; the CLI uses its saved client session UUID.
export function nativeUserAgent(sessionId) {
  return `com.opentable/26.25.0; android; android/16; 2.4/2364x1080; ${sessionId}/Anonymous`;
}
const routes = [
  [/^\/api\/configuration\/android_feature_config_v11\.json$/, ['GET']],
  [/^\/api\/v1\/2fa\/(?:start|confirm)$/, ['POST']],
  [/^\/api\/v3\/user$/, ['GET']],
  [/^\/api\/v3\/user\/history\/\d{1,5}$/, ['GET']],
  [/^\/api\/v3\/user\/reservation$/, ['GET']],
  [/^\/api\/v3\/restaurant\/\d{1,30}$/, ['GET']],
  [/^\/api\/v3\/restaurant\/availability$/, ['PUT']],
  [/^\/api\/v5\/personalize\/search\/\d{1,5}$/, ['POST']],
  [/^\/api\/v3\/reservation\/\d{1,30}\/lock$/, ['POST', 'DELETE']],
  [/^\/api\/v3\/reservation\/\d{1,30}$/, ['POST']],
  [/^\/api\/v3\/reservation\/\d{1,30}\/[A-Za-z0-9_-]{1,100}$/, ['DELETE']],
];

export function checkToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9._~+\/=-]{16,8192}$/.test(token)) throw new OpenTableError('INVALID_SESSION', 'OpenTable did not return a valid access token.');
  return token;
}
export function parseJson(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (context?.source && /^-?\d+$/.test(context.source)) return context.source;
      throw new OpenTableError('INVALID_RESPONSE', 'An identifier exceeds JSON precision. Use the supplied Node runtime.');
    }
    return value;
  });
}
async function readResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 20 * 1024 * 1024) { await reader.cancel(); throw new OpenTableError('RESPONSE_TOO_LARGE', 'OpenTable returned more than 20 MiB.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export class OpenTableClient {
  constructor({ token, sessionId = randomUUID(), fetchImpl = fetch } = {}) {
    if (token != null) checkToken(token);
    if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw new OpenTableError('INVALID_ARGUMENT', 'Invalid request session ID.');
    this.token = token; this.sessionId = sessionId; this.fetch = fetchImpl;
  }
  async request(endpoint, { method = 'GET', query = {}, json, form } = {}) {
    if (!routes.some(([path, methods]) => path.test(endpoint) && methods.includes(method))) throw new OpenTableError('INVALID_ENDPOINT', 'Unknown OpenTable operation.');
    if (!this.token) throw new OpenTableError('LOGIN_REQUIRED', 'A native OpenTable access token is required.');
    return this.send(endpoint, { method, query, json, form, authenticated: true });
  }
  async tokenRequest(form) {
    if (!['implicit', 'authorization_code', 'refresh_token'].includes(form?.grant_type)) throw new OpenTableError('INVALID_ARGUMENT', 'Unknown OpenTable token grant.');
    return this.send('/oauth/consumer/token', { method: 'POST', form, authenticated: false });
  }
  async send(endpoint, { method, query = {}, json, form, authenticated }) {
    if (json !== undefined && form !== undefined || method === 'GET' && (json !== undefined || form !== undefined)) throw new OpenTableError('INVALID_ARGUMENT', 'Invalid request body.');
    const url = new URL(endpoint, apiOrigin);
    if (url.origin !== apiOrigin || !endpoint.startsWith('/') || endpoint.includes('..') || endpoint.includes('//')) throw new OpenTableError('INVALID_ENDPOINT', 'Invalid OpenTable endpoint.');
    for (const [name, value] of Object.entries(query)) if (value != null) url.searchParams.set(name, String(value));
    const headers = { accept: 'application/json', 'accept-language': 'en-US', 'user-agent': nativeUserAgent(this.sessionId), 'x-ot-sessionid': this.sessionId };
    if (authenticated) headers.authorization = `bearer ${checkToken(this.token)}`;
    let body;
    if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form !== undefined) { headers['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8'; body = new URLSearchParams(form).toString(); }
    let response;
    try { response = await this.fetch(url, { method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout(25_000) }); }
    catch { throw new OpenTableError('NETWORK_ERROR', 'OpenTable could not be reached. No automatic retry was sent.'); }
    const httpStatus = response.status;
    if (httpStatus === 429) {
      const retry = response.headers.get('retry-after');
      throw new OpenTableError('RATE_LIMITED', 'OpenTable asked this client to wait. No automatic retry was sent.', { httpStatus, ...(retry && /^\d{1,6}$/.test(retry) ? { retryAfterSeconds: Number(retry) } : {}) });
    }
    if (httpStatus >= 300 && httpStatus < 400) throw new OpenTableError('REDIRECT_REJECTED', 'OpenTable redirected the request; credentials were not forwarded.', { httpStatus });
    if (httpStatus === 401) throw new OpenTableError('LOGIN_REQUIRED', 'OpenTable rejected or expired this session.', { httpStatus });
    if (httpStatus === 403) throw new OpenTableError('ACCESS_REJECTED', 'OpenTable rejected this operation or requires a security check.', { httpStatus });
    if (!response.ok) throw new OpenTableError('API_ERROR', 'OpenTable rejected this request.', { httpStatus });
    if (httpStatus === 204) return null;
    const text = await readResponse(response);
    if (!text.trim() && method === 'DELETE') return null;
    let result;
    try { result = parseJson(text); }
    catch (error) { if (error instanceof OpenTableError) throw error; throw new OpenTableError('INVALID_RESPONSE', 'OpenTable returned a non-JSON response.', { httpStatus }); }
    if (!result || typeof result !== 'object') throw new OpenTableError('INVALID_RESPONSE', 'OpenTable returned an unfamiliar response.', { httpStatus });
    if (result.error || result.errors?.length) throw new OpenTableError('API_ERROR', 'OpenTable rejected this operation.', { httpStatus });
    return result;
  }
  async me() { return this.request('/api/v3/user'); }
}

// These client values are shipped by the native application, not user credentials.
export const nativeClient = Object.freeze({ anonymous: 'ot-anonymous-apps', passwordless: 'ot-apps-passwordless', sharedValue: '0pentab1e' });
export async function acquireAnonymous({ fetchImpl = fetch, sessionId } = {}) {
  const response = await new OpenTableClient({ fetchImpl, sessionId }).tokenRequest({ grant_type: 'implicit', client_id: nativeClient.anonymous, client_secret: nativeClient.sharedValue });
  const accessToken = checkToken(response.access_token);
  if (!Number.isFinite(response.expires_in) || response.expires_in <= 0) throw new OpenTableError('INVALID_RESPONSE', 'OpenTable omitted token expiry.');
  return { accessToken, expiresAt: Date.now() + response.expires_in * 1000, scope: typeof response.scope === 'string' ? response.scope : null, tokenType: response.token_type };
}
