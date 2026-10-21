import { AirbnbError } from './errors.mjs';

export const API_ORIGIN = 'https://api.airbnb.com';
// Public application identifier from the shipped Android request interceptor.
export const APP_CLIENT_ID = '3092nxybyb0otqw18e8nh5nty';
function serializeBody(body, operationName) {
  // Native GraphQL Long values must retain all digits. Private state keeps
  // decimal strings; only these source-typed payment fields become JSON numbers.
  const payment = operationName === 'CheckoutFulfillmentMutation' ? body?.variables?.input?.placeOrder?.paymentParams : null;
  return JSON.stringify(body, function (key, value) {
    if ((this === payment && key === 'paymentQuoteId')
      || (payment?.selectedPaymentOption && this === payment.selectedPaymentOption && key === 'businessEntityGroupId' && value !== null)) {
      const decimal = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
      if (typeof decimal !== 'string' || !/^[1-9][0-9]*$/.test(decimal) || BigInt(decimal) > 9223372036854775807n) throw new AirbnbError('INVALID_REQUEST', 'Invalid signed-64-bit payment identifier.');
      return JSON.rawJSON(decimal);
    }
    return value;
  });
}
export function buildRequest(spec) {
  const graphql = typeof spec.operationName === 'string';
  const url = new URL(graphql ? '/v3' : `/v2/${spec.path?.replace(/^\/?v2\//, '').replace(/^\//, '')}`, API_ORIGIN);
  if (!graphql && (!spec.path || spec.path.includes('..') || /[?#\\]/.test(spec.path))) throw new AirbnbError('INVALID_REQUEST', 'Invalid API path.');
  const headers = { accept: 'application/json', ...spec.headers };
  let method = spec.method || 'GET', body = spec.body;
  if (graphql) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(spec.operationName) || !/^[a-f0-9]{64}$/.test(spec.hash)) throw new AirbnbError('INVALID_REQUEST', 'Invalid persisted operation.');
    const payload = { operationName: spec.operationName, variables: spec.variables ?? {}, extensions: { persistedQuery: { version: 1, sha256Hash: spec.hash } } };
    for (const [key, value] of Object.entries(payload)) url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    headers['x-apollo-operation-id'] = spec.hash;
    headers['x-apollo-operation-name'] = spec.operationName;
    headers['x-airbnb-graphql-platform'] = 'android';
    if (spec.method === 'POST' || url.href.length >= 3500) { method = 'POST'; url.search = ''; body = payload; }
  } else for (const [key, value] of Object.entries(spec.query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  if (body !== undefined) headers['content-type'] = 'application/json';
  url.searchParams.set('client_id', APP_CLIENT_ID);
  if (!url.searchParams.has('locale')) url.searchParams.set('locale', 'en-US');
  if (!url.searchParams.has('currency')) url.searchParams.set('currency', spec.currency ?? 'USD');
  return { url, method, headers, ...(body !== undefined ? { body: serializeBody(body, spec.operationName) } : {}) };
}

// No automatic replay: POSTs include verification and booking operations.
export async function request(spec, { fetchImpl = fetch, headers = {}, timeoutMs = 30_000, maxBytes = 10 * 1024 * 1024 } = {}) {
  const wire = buildRequest(spec);
  let response;
  try { response = await fetchImpl(wire.url, { method: wire.method, headers: { ...headers, ...wire.headers }, body: wire.body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new AirbnbError('NETWORK_UNCERTAIN', 'The request did not return a response. Check status before repeating a state-changing command.'); }
  const chunks = []; let size = 0;
  try {
    if (response.body) for await (const part of response.body) {
      size += part.byteLength;
      if (size > maxBytes) throw new AirbnbError('RESPONSE_TOO_LARGE', 'The API response exceeded the size limit.');
      chunks.push(Buffer.from(part));
    }
  } catch (error) { if (error instanceof AirbnbError) throw error; throw new AirbnbError('NETWORK_UNCERTAIN', 'The response was interrupted. Check status before repeating the command.'); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AirbnbError('NON_JSON_RESPONSE', 'Airbnb returned a non-JSON response.', { status: response.status }); }
  return { status: response.status, headers: Object.fromEntries(response.headers), body };
}

export function requireSuccess(response) {
  if (response.status < 200 || response.status >= 300) throw new AirbnbError(
    response.status === 401 ? 'AUTH_REQUIRED' : response.status === 429 ? 'RATE_LIMITED' : 'AIRBNB_HTTP_ERROR',
    response.status === 401 ? 'Sign in again with airbnb login.' : `Airbnb returned HTTP ${response.status}.`,
    { status: response.status, ...(response.body?.error_code ? { errorCode: response.body.error_code } : {}) },
  );
  if (response.body?.errors?.length) throw new AirbnbError('AIRBNB_GRAPHQL_ERROR', 'Airbnb could not complete this operation.', {
    errors: response.body.errors.map(error => ({ code: error.extensions?.code, message: error.message })).slice(0, 8),
  });
  if (response.body && Object.hasOwn(response.body, 'data') && response.body.data === null) throw new AirbnbError('EMPTY_DATA', 'Airbnb returned no data for this request.');
  return response.body;
}
