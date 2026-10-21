import { AmexError } from './errors.mjs';
import { createLoginSseDecoder } from './auth-stream-protocol.mjs';

// Shipped US release ENV=ecp_e3_prod; generic MSL client (not the legacy US path).
export const API_BASE = 'https://mobileone.americanexpress.com/mobileone/msl/';
export function buildRequest(spec) {
  if (typeof spec?.path !== 'string' || !spec.path.startsWith('/services/') || /[\x00-\x20\x7f?#\\]/u.test(spec.path)
    || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(spec.path)) throw new AmexError('INVALID_REQUEST', 'Invalid native API path.');
  const url = new URL(spec.path.slice(1), API_BASE);
  if (!url.href.startsWith(`${API_BASE}services/`)) throw new AmexError('INVALID_REQUEST', 'Invalid native API origin or path.');
  for (const [name, value] of Object.entries(spec.query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }
  const method = spec.method ?? 'GET';
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method) || method === 'GET' && spec.body !== undefined) throw new AmexError('INVALID_REQUEST', 'Invalid native request method.');
  const headers = { accept: 'application/json', ...(spec.body === undefined ? {} : { 'content-type': 'application/json' }), ...spec.headers };
  return { url, method, headers, ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }) };
}
export async function request(spec, { headers = {}, fetchImpl = fetch, timeoutMs = 30_000, maxBytes = 10 * 1024 * 1024 } = {}) {
  const wire = buildRequest(spec); let response;
  try { response = await fetchImpl(wire.url, { method: wire.method, headers: { ...headers, ...wire.headers },
    body: wire.body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new AmexError('NETWORK_UNCERTAIN', 'No response was received. Inspect the recorded outcome before repeating a payment or login.'); }
  // The app's contributed session interceptor turns either exact expiration
  // flag into HTTP 401 and discards the body, even on an otherwise-200 response.
  if (['x-axp-session-expired', 'x-axp-jwt-expired'].some(name => response.headers.get(name) === 'true')) {
    await response.body?.cancel().catch(() => {});
    return { status: 401, headers: Object.fromEntries(response.headers), body: null };
  }
  if (spec.responseType === 'login-sse' && response.status >= 200 && response.status < 300
    && response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    const decoder = createLoginSseDecoder({ maxBytes }), utf8 = new TextDecoder();
    const reader = response.body?.getReader(); let bytes = 0, result;
    try {
      if (reader) for (;;) {
        const part = await reader.read();
        if (part.done) { result = decoder.push(utf8.decode()) ?? decoder.finish(); break; }
        bytes += part.value.byteLength;
        if (bytes > maxBytes) throw new AmexError('RESPONSE_TOO_LARGE', 'Amex login exceeded the response size limit.');
        result = decoder.push(utf8.decode(part.value, { stream: true }));
        if (result) break;
      }
      result ??= decoder.finish();
    } catch (error) {
      if (error instanceof AmexError) throw error;
      throw new AmexError('NETWORK_UNCERTAIN', 'The login stream ended without a recognized result. It will not be retried.');
    } finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
    return { status: response.status, headers: Object.fromEntries(response.headers),
      body: result.type === 'login' ? result.response : { loginStreamError: result.reason, ...(result.status ? { status: result.status } : {}) } };
  }
  let size = 0; const chunks = [];
  try {
    if (response.body) for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new AmexError('RESPONSE_TOO_LARGE', 'Amex returned a response exceeding the size limit.', { status: response.status });
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof AmexError) throw error;
    throw new AmexError('NETWORK_UNCERTAIN', 'The response was interrupted. Inspect the recorded outcome before repeating a payment or login.');
  }
  const text = Buffer.concat(chunks).toString('utf8'); let body;
  try { body = text ? JSON.parse(text) : null; }
  catch { throw new AmexError('NON_JSON_RESPONSE', 'Amex returned a non-JSON response.', { status: response.status }); }
  // Never persist the request here: authentication requests can contain passwords.
  return { status: response.status, headers: Object.fromEntries(response.headers), body };
}
export function requireSuccess(response) {
  if (response.status < 200 || response.status >= 300) throw new AmexError(
    response.status === 401 ? 'AUTH_REQUIRED' : response.status === 429 ? 'RATE_LIMITED' : 'AMEX_HTTP_ERROR',
    response.status === 401 ? 'The Amex session needs sign-in or verification.' : `Amex returned HTTP ${response.status}.`, { status: response.status });
  if (String(response.headers?.['x-axp-business-layer-status']).toUpperCase() === 'FAIL') throw new AmexError('AMEX_BUSINESS_ERROR', 'Amex marked this request as unsuccessful.');
  if (!response.body || typeof response.body !== 'object' || Array.isArray(response.body)) throw new AmexError('EMPTY_RESPONSE', 'Amex did not return a native response object.');
  return response.body;
}
