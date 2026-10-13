import { ResyError } from './errors.mjs';

export const apiOrigin = 'https://api.resy.com';
// Public client configuration shipped by the first-party reservation widget.
const widgetApiKey = 'VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5';
const routes = new Map([
  ['/2/user', ['GET']],
  ['/3/venue', ['GET']], ['/3/venuesearch/search', ['POST']],
  ['/3/user/reservations', ['GET']], ['/4/find', ['POST']],
  ['/4/venue/calendar', ['GET']], ['/3/details', ['POST']],
  ['/3/book', ['POST']], ['/3/cancel', ['POST']],
]);

export function checkToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9._~+\/=-]{16,4096}$/.test(token)) {
    throw new ResyError('INVALID_SESSION', 'Resy did not supply a valid session token.');
  }
  return token;
}

export function parseJson(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (context?.source && /^-?\d+$/.test(context.source)) return context.source;
      throw new ResyError('INVALID_RESPONSE', 'An identifier exceeds JSON precision. Use the supplied Node runtime.');
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
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 20 * 1024 * 1024) {
        await reader.cancel();
        throw new ResyError('RESPONSE_TOO_LARGE', 'Resy returned more than 20 MiB.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export class ResyClient {
  constructor({ token, fetchImpl = fetch } = {}) {
    if (token !== undefined && token !== null) checkToken(token);
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(endpoint, { method = 'GET', query = {}, json, form, authenticated = true } = {}) {
    if (!routes.get(endpoint)?.includes(method)) throw new ResyError('INVALID_ENDPOINT', 'Unknown Resy operation.');
    if (json !== undefined && form !== undefined || method === 'GET' && (json !== undefined || form !== undefined)) {
      throw new ResyError('INVALID_ARGUMENT', 'Invalid request body.');
    }
    if (authenticated && !this.token) throw new ResyError('LOGIN_REQUIRED', 'Run resy login and sign in using its approval link.');
    const url = new URL(endpoint, apiOrigin);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    }
    const headers = { accept: 'application/json', authorization: `ResyAPI api_key="${widgetApiKey}"`,
      'x-origin': 'https://widgets.resy.com', 'cache-control': 'no-cache',
      'user-agent': 'Mozilla/5.0', origin: 'https://widgets.resy.com', referer: 'https://widgets.resy.com/' };
    if (authenticated) {
      headers['x-resy-auth-token'] = checkToken(this.token);
      headers['x-resy-universal-auth'] = this.token;
    }
    let body;
    if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const fields = new URLSearchParams();
      for (const [name, value] of Object.entries(form)) {
        if (value !== undefined) fields.set(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      body = fields.toString();
    }
    let response;
    try {
      response = await this.fetch(url, { method, headers, ...(body !== undefined ? { body } : {}),
        redirect: 'manual', signal: AbortSignal.timeout(25_000) });
    } catch { throw new ResyError('NETWORK_ERROR', 'Resy could not be reached. No automatic retry was sent.'); }
    const httpStatus = response.status;
    if (httpStatus === 429) {
      const retry = response.headers.get('retry-after');
      throw new ResyError('RATE_LIMITED', 'Resy asked this client to wait. No automatic retry was sent.', {
        httpStatus, ...(retry && /^\d{1,6}$/.test(retry) ? { retryAfterSeconds: Number(retry) } : {}),
      });
    }
    if (httpStatus === 401 || httpStatus === 419) throw new ResyError('LOGIN_REQUIRED', 'Resy requires a fresh login.', { httpStatus });
    if (httpStatus >= 300 && httpStatus < 400) throw new ResyError('REDIRECT_REJECTED', 'Resy redirected this request; credentials were not forwarded.', { httpStatus });
    if (httpStatus === 403) throw new ResyError('APPROVAL_REQUIRED', 'Resy rejected this request or requires a security check. Complete checks on its website.', { httpStatus });
    if (!response.ok) throw new ResyError('API_ERROR', 'Resy rejected this request.', { httpStatus });
    if (httpStatus === 204) return null;
    const text = await readResponse(response);
    let result;
    try { result = parseJson(text); }
    catch (error) {
      if (error instanceof ResyError) throw error;
      throw new ResyError('INVALID_RESPONSE', 'Resy returned a non-JSON response; the website protocol may have changed.', { httpStatus });
    }
    if (!result || typeof result !== 'object') throw new ResyError('INVALID_RESPONSE', 'Resy returned an unfamiliar response.', { httpStatus });
    if (result.error || result.errors?.length || result.status === 'fail') throw new ResyError('API_ERROR', 'Resy rejected this operation.', { httpStatus });
    return result;
  }

  async me() {
    const body = await this.request('/2/user');
    const id = body?.id ?? body?.user_id;
    if (!/^\d{1,30}$/.test(String(id ?? ''))) throw new ResyError('INVALID_RESPONSE', 'Resy did not return an account identity.');
    return { ...body, id: String(id) };
  }
}
