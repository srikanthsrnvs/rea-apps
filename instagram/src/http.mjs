import { queries } from './queries.mjs';
import { InstagramError } from './errors.mjs';
import { instagramOrigin, requestHeaders, updateResponseCookies } from './session.mjs';
import { tvUserAgent } from './profiles.mjs';

export function parseInstagramJson(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (context?.source && /^-?\d+$/.test(context.source)) return context.source;
      throw new InstagramError('INVALID_RESPONSE', 'An integer identifier exceeds JSON precision on this Node runtime. Use the supplied Node 24 runtime.');
    }
    return value;
  });
}

export class InstagramClient {
  constructor(session, { fetchImpl = fetch, saveSession = async () => {} } = {}) {
    this.session = session;
    this.fetch = fetchImpl;
    this.saveSession = saveSession;
  }

  async get(endpoint, parameters = {}, { profile = 'web' } = {}) {
    if (!['web', 'tv'].includes(profile)) throw new InstagramError('INVALID_ARGUMENT', 'Unknown HTTP client profile.');
    if (!/^\/[A-Za-z0-9_/%.-]+\/$/.test(endpoint)
      || endpoint.includes('..') || endpoint.includes('//')) {
      throw new InstagramError('INVALID_ENDPOINT', 'Invalid Instagram API endpoint.');
    }
    const url = new URL(`/api/v1${endpoint}`, instagramOrigin);
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    let response;
    const headers = requestHeaders(this.session, url.pathname);
    if (profile === 'tv') headers['user-agent'] = tvUserAgent;
    try {
      response = await this.fetch(url, {
        method: 'GET', headers,
        redirect: 'manual', signal: AbortSignal.timeout(25_000),
      });
    } catch {
      throw new InstagramError('NETWORK_ERROR', 'Instagram could not be reached.');
    }
    this.session = updateResponseCookies(this.session, response.headers);
    await this.saveSession(this.session);
    if (response.status >= 300 && response.status < 400) {
      throw new InstagramError('LOGIN_REQUIRED', 'Instagram redirected this request. Sign in again.', { httpStatus: response.status });
    }
    const text = await readResponse(response);
    let body;
    try { body = parseInstagramJson(text); }
    catch (error) {
      if (error instanceof InstagramError) throw error;
      throw new InstagramError('INVALID_RESPONSE', 'Instagram returned a non-JSON response.', { httpStatus: response.status });
    }
    if (body?.challenge || body?.challenge_required || body?.message === 'challenge_required') {
      throw new InstagramError('APPROVAL_REQUIRED', 'Complete Instagram’s security check in its app or website, then sign in again.', { httpStatus: response.status });
    }
    if (response.status === 401 || body?.require_login || body?.message === 'login_required') {
      throw new InstagramError('LOGIN_REQUIRED', 'Instagram requires a fresh login.', { httpStatus: response.status });
    }
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      throw new InstagramError('RATE_LIMITED', 'Instagram asked this client to wait. No automatic retry was sent.', {
        ...(retry && /^\d+$/.test(retry) ? { retryAfterSeconds: Number(retry) } : {}),
      });
    }
    if (!response.ok || body?.status === 'fail') {
      throw new InstagramError('API_ERROR', 'Instagram rejected this request.', { httpStatus: response.status });
    }
    return body;
  }

  async graphql(operation, variables) {
    const query = queries[operation];
    if (!query) throw new InstagramError('INVALID_ENDPOINT', 'Unknown read-only operation.');
    if (!this.bootstrap) await this.me();
    const { tokens, user } = this.bootstrap;
    if (!tokens.fbDtsg || !tokens.lsd || !user.fbid) throw new InstagramError('PROTOCOL_CHANGED', 'Instagram omitted its web request tokens. Update the CLI.');
    const form = new URLSearchParams({
      av: user.fbid, __d: 'www', __user: '0', __a: '1', __comet_req: '7',
      fb_dtsg: tokens.fbDtsg, lsd: tokens.lsd,
      jazoest: '2' + [...tokens.fbDtsg].reduce((n, c) => n + c.charCodeAt(0), 0),
      fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: query.name,
      server_timestamps: 'true', variables: JSON.stringify(variables), doc_id: query.id,
    });
    const headers = requestHeaders(this.session, '/api/graphql');
    delete headers['x-requested-with']; delete headers['x-ig-www-claim'];
    Object.assign(headers, { accept: '*/*', origin: instagramOrigin,
      referer: `${instagramOrigin}/direct/inbox/`, 'content-type': 'application/x-www-form-urlencoded',
      'x-fb-lsd': tokens.lsd, 'x-fb-friendly-name': query.name, 'x-asbd-id': '359341',
      'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
      'x-ig-max-touch-points': '0', 'accept-language': 'en-US,en;q=0.9',
    });
    let response;
    try { response = await this.fetch(`${instagramOrigin}/api/graphql`, {
      method: 'POST', headers, body: form, redirect: 'manual', signal: AbortSignal.timeout(25_000),
    }); } catch { throw new InstagramError('NETWORK_ERROR', 'Instagram could not be reached.'); }
    this.session = updateResponseCookies(this.session, response.headers);
    await this.saveSession(this.session);
    if (response.status === 429) throw new InstagramError('RATE_LIMITED', 'Instagram asked this client to wait. No automatic retry was sent.');
    if (response.status >= 300 && response.status < 400 || response.status === 401) throw new InstagramError('LOGIN_REQUIRED', 'Instagram requires a fresh login.');
    let body;
    try { body = parseInstagramJson((await readResponse(response)).replace(/^for\s*\(;;\);/, '')); }
    catch (error) { if (error instanceof InstagramError) throw error; throw new InstagramError('INVALID_RESPONSE', 'Instagram returned a non-JSON response.'); }
    if (!response.ok || body.error || body.errors?.length || !body.data) throw new InstagramError('API_ERROR', 'Instagram rejected the read operation. Revalidate the session with instagram me; the web protocol may have changed.', { httpStatus: response.status });
    return body.data;
  }

  async me() {
    const { parseWebsiteBootstrap } = await import('./bootstrap.mjs');
    const userId = this.session.cookies.find(cookie => cookie.name === 'ds_user_id')?.value;
    if (!/^\d+$/.test(userId ?? '')) throw new InstagramError('INVALID_SESSION', 'The browser session has no account identifier.');
    const headers = requestHeaders(this.session, '/');
    headers.accept = 'text/html';
    delete headers['x-requested-with'];
    let response;
    try {
      response = await this.fetch(instagramOrigin, {
        method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(25_000),
      });
    } catch { throw new InstagramError('NETWORK_ERROR', 'Instagram could not be reached.'); }
    if (response.status === 429) throw new InstagramError('RATE_LIMITED', 'Instagram asked this client to wait. No automatic retry was sent.');
    if (!response.ok) throw new InstagramError('LOGIN_REQUIRED', 'Instagram requires a fresh browser approval.', { httpStatus: response.status });
    const body = parseWebsiteBootstrap(await readResponse(response), userId);
    this.session = updateResponseCookies(this.session, response.headers);
    const user = body.user;
    if (!user || !/^\d+$/.test(String(user.pk ?? user.id)) || typeof user.username !== 'string') {
      throw new InstagramError('INVALID_RESPONSE', 'Instagram did not return an account identity.');
    }
    this.session = {
      ...this.session, validatedAt: new Date().toISOString(),
      account: { id: String(user.pk ?? user.id), username: user.username },
    };
    this.bootstrap = body;
    await this.saveSession(this.session);
    return { user };
  }
}

export async function readResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new InstagramError('INVALID_RESPONSE', 'Instagram returned an empty response.');
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 20 * 1024 * 1024) {
      await reader.cancel();
      throw new InstagramError('RESPONSE_TOO_LARGE', 'Instagram returned more than 20 MiB.');
    }
    chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
