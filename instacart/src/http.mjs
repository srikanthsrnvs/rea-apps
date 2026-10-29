import { createHash, randomUUID } from 'node:crypto';

const endpoint = 'https://www.instacart.com/graphql';
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;

export class ApiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

export function nativeHeaders(state) {
  state.deviceId ??= randomUUID();
  const headers = {
    accept: 'application/json', 'content-type': 'application/json',
    'x-client-identifier': 'Android', 'x-client-os': 'android',
    'x-client-version': '9.39.2', 'x-android-api-version': '36',
    'x-device-class': 'phone', 'x-device-uuid': state.deviceId,
    'user-agent': 'Android-16 9.39.2-v2 Pixel 10 Pro Fold',
  };
  if (state.accessToken) headers.authorization = `Bearer ${state.accessToken}`;
  if (state.userId) headers['x-client-user-id'] = String(state.userId);
  if (state.userlessId) headers['x-userless-identifier'] = state.userlessId;
  for (const value of Object.values(headers)) {
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new ApiError('INVALID_SESSION', 'Invalid stored request context.');
  }
  return headers;
}

export function createClient(state = {}, { fetchImpl = fetch, timeoutMs = 30_000, record = async () => {} } = {}) {
  return {
    state,
    async graphql(operationName, document, variables = {}) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(operationName)
        || typeof document !== 'string' || !document.startsWith(`${document.startsWith('mutation ') ? 'mutation' : 'query'} ${operationName}`)
        || !variables || typeof variables !== 'object' || Array.isArray(variables)) {
        throw new ApiError('INVALID_OPERATION', 'Supply a known native GraphQL operation.');
      }
      // The native backend accepts only pre-registered documents. Sending query
      // text, or changing its whitespace before hashing, fails on this endpoint.
      const sha256Hash = createHash('sha256').update(document).digest('hex');
      const body = JSON.stringify({ operationName, variables, extensions: { persistedQuery: { version: 1, sha256Hash } } });
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST', headers: nativeHeaders(state), body,
          redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new ApiError('NETWORK_ERROR', 'The request outcome is unknown. Do not automatically repeat a login, cart change or order.', { operation: operationName });
      }
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new ApiError('RESPONSE_TOO_LARGE', 'Instacart returned an oversized response.');
      let payload;
      try {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('size'); }
          chunks.push(Buffer.from(value));
        }
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new ApiError('INVALID_RESPONSE', 'Instacart did not return a recognized JSON response.', { status: response.status, operation: operationName });
      }
      // Optional private diagnostics receive responses, never request credentials.
      await record({ operation: operationName, status: response.status, receivedAt: new Date().toISOString(), payload });
      if (response.status === 401) throw new ApiError('AUTH_REQUIRED', 'Sign in to Instacart before using this command.');
      if (response.status === 403) throw new ApiError('ACCESS_DENIED', 'Instacart denied this request. A native verification challenge may be required.', { operation: operationName });
      if (!response.ok) throw new ApiError('HTTP_ERROR', `Instacart rejected the request (HTTP ${response.status}).`, { operation: operationName, status: response.status });
      if (payload?.errors?.length) {
        const codes = payload.errors.map(error => error.extensions?.code).filter(code => typeof code === 'string' && /^[A-Z0-9_]{1,100}$/.test(code));
        throw new ApiError('GRAPHQL_ERROR', 'Instacart could not complete the operation.', { operation: operationName, codes });
      }
      if (!payload?.data || typeof payload.data !== 'object') throw new ApiError('INVALID_RESPONSE', 'Instacart returned no operation data.', { operation: operationName });
      return payload.data;
    },
  };
}
