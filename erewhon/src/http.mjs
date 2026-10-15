import * as disk from './state.mjs';

export const apiBase = 'https://ordersapi.enfmkt.com';
export class ApiError extends Error {
  constructor(code, message, status) { super(message); this.name = 'ApiError'; this.code = code; if (status !== undefined) this.status = status; }
}
// Match the website's qs.stringify RFC3986 encoding, including %20 for spaces
// inside JSON-valued form fields rather than URLSearchParams' plus signs.
function encodeField(value){return encodeURIComponent(String(value)).replace(/[!'()*]/g,character=>`%${character.charCodeAt(0).toString(16).toUpperCase()}`);}

function apiURL(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/') || endpoint.startsWith('//')) throw new ApiError('INVALID_ENDPOINT', 'Supply a first-party API endpoint.');
  const url = new URL(endpoint, apiBase);
  if (url.origin !== apiBase || url.hash || url.username || url.password || !/^\/v[12]\//.test(url.pathname)) throw new ApiError('INVALID_ENDPOINT', 'Supply a first-party API endpoint.');
  return url;
}

export async function request(endpoint, { method = 'POST', form, token, readOnly = false, allowErrors = false, retries = 0 } = {}, dependencies = {}) {
  const url = apiURL(endpoint), fetchImpl = dependencies.fetchImpl ?? fetch, store = dependencies.store ?? disk;
  method = String(method).toUpperCase();
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw new ApiError('INVALID_METHOD', 'Unsupported API method.');
  if (!Number.isInteger(retries) || retries < 0 || retries > 2 || (retries && !readOnly)) throw new ApiError('INVALID_RETRY', 'Retries require an explicit read-only request and are limited to two.');
  const headers = { Accept: 'application/json', 'ngrok-skip-browser-warning': 'true' };
  if (token !== undefined) {
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new ApiError('INVALID_TOKEN', 'The stored credential is invalid.');
    headers.Authorization = `Bearer ${token}`;
  }
  let body;
  if (form !== undefined) {
    if (method === 'GET' || !form || typeof form !== 'object' || Array.isArray(form)) throw new ApiError('INVALID_FORM', 'Supply scalar form fields for this request.');
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new ApiError('INVALID_FORM', 'Form fields must be finite scalar values.');
      params.set(key, String(value));
    }
    if (method === 'DELETE') {
      for (const [key, value] of params) url.searchParams.set(key, value);
    } else {
      body = [...params].map(([key,value])=>`${encodeField(key)}=${encodeField(value)}`).join('&'); headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }
  for (let attempt = 0; ; attempt++) {
    let response;
    try { response = await fetchImpl(url.href, { method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout(20_000) }); }
    catch {
      if (attempt < retries) continue;
      throw new ApiError('NETWORK_ERROR', 'The request outcome is unknown. Do not automatically repeat a login or mutation.');
    }
    let payload;
    try { payload = await response.json(); }
    catch {
      await store.saveState('last-response', { endpoint: url.pathname, status: response.status, receivedAt: new Date().toISOString(), invalidJSON: true });
      if (attempt < retries && response.status >= 500) continue;
      throw new ApiError('INVALID_RESPONSE', 'The API did not return a recognized JSON response.', response.status);
    }
    await store.saveState('last-response', { endpoint: url.pathname, status: response.status, receivedAt: new Date().toISOString(), data: payload });
    if (response.status === 401 || response.status === 403 || payload?.error === 3) throw new ApiError('AUTH_REQUIRED', 'The API requires a valid Erewhon login.', response.status);
    if (!response.ok) {
      if (attempt < retries && (response.status >= 500 || response.status === 429)) continue;
      throw new ApiError('HTTP_ERROR', `The API rejected the request (HTTP ${response.status}).`, response.status);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Number.isInteger(payload.error)) throw new ApiError('INVALID_RESPONSE', 'The API response shape is not recognized.', response.status);
    if (payload.error !== 0 && !allowErrors) throw new ApiError('API_REJECTED', 'Erewhon rejected the request. Inspect the private response for details.', response.status);
    return payload;
  }
}

export async function authenticatedOperation(callback, dependencies = {}) {
  const store = dependencies.store ?? disk;
  return store.withStateLock(async () => {
    const session = await store.readState('session');
    if (!session?.token || !session.deviceId) throw new ApiError('AUTH_REQUIRED', 'Log in to Erewhon before running this command.');
    return callback({ session, send: (endpoint, options = {}) => request(endpoint, { ...options, token: session.token }, dependencies) });
  });
}

export async function authenticatedRequest(endpoint, options = {}, dependencies = {}) {
  return authenticatedOperation(({ send }) => send(endpoint, options), dependencies);
}
