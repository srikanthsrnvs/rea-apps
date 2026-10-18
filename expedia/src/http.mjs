import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { clientHeaders } from './context.mjs';
import { ExpediaError } from './errors.mjs';

const FIRST_PARTY = host => host === 'expedia.com' || host.endsWith('.expedia.com');
export class CookieJar {
  constructor(cookies = []) { this.cookies = []; this.merge(cookies); }
  merge(cookies) {
    for (const input of cookies) {
      const c = { ...input, domain: input.domain?.replace(/^\./, '').toLowerCase(), path: input.path || '/' };
      if (!FIRST_PARTY(c.domain ?? '') || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(c.name ?? '') || typeof c.value !== 'string' || /[\r\n;\x00]/.test(c.value)) continue;
      if (c.maxAge !== undefined && c.expiresAt === undefined) c.expiresAt = Date.now() + Number(c.maxAge) * 1000;
      if (c.expiresAt === undefined && c.expires) c.expiresAt = Date.parse(c.expires);
      this.cookies = this.cookies.filter(old => !(old.name === c.name && old.domain === c.domain && old.path === c.path));
      if (!Number.isFinite(c.expiresAt) || c.expiresAt > Date.now()) this.cookies.push(c);
    }
  }
  receive(headers, url) {
    const u = new URL(url);
    for (const line of headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';'), i = pair.indexOf('=');
      if (i < 1) continue;
      const c = { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain: u.hostname, hostOnly: true, path: u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1) || '/' };
      for (const attribute of attributes) {
        const j = attribute.indexOf('='), key = (j < 0 ? attribute : attribute.slice(0, j)).trim().toLowerCase(), value = j < 0 ? '' : attribute.slice(j + 1).trim();
        if (key === 'domain') { c.domain = value.replace(/^\./, '').toLowerCase(); c.hostOnly = false; }
        if (key === 'path' && value.startsWith('/')) c.path = value;
        if (key === 'max-age' && /^-?\d+$/.test(value)) c.maxAge = Number(value);
        if (key === 'expires') c.expires = value;
        if (key === 'secure') c.secure = true;
        if (key === 'httponly') c.httpOnly = true;
      }
      if (u.hostname === c.domain || u.hostname.endsWith(`.${c.domain}`)) this.merge([c]);
    }
  }
  header(url) {
    const u = new URL(url);
    return this.cookies.filter(c => (!Number.isFinite(c.expiresAt) || c.expiresAt > Date.now()) && (!c.secure || u.protocol === 'https:') && (u.hostname === c.domain || (!c.hostOnly && u.hostname.endsWith(`.${c.domain}`))) && (u.pathname === c.path || u.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`))).sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; ');
  }
}

export class ExpediaHttpClient {
  constructor({ cookies = [], fetchImpl = fetch, userAgent, context, sessionOrigin } = {}) {
    if (userAgent !== undefined && (typeof userAgent !== 'string' || userAgent.length > 1000 || /[\r\n\x00]/.test(userAgent))) throw new ExpediaError('INVALID_USER_AGENT', 'The saved client user agent is invalid.');
    const duaid = context?.identity?.duaid;
    if (duaid !== undefined && (typeof duaid !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(duaid))) throw new ExpediaError('INVALID_DEVICE_ID', 'The saved client device ID is invalid.');
    if (sessionOrigin !== undefined && (sessionOrigin?.kind !== 'android_runtime' || !['model', 'manufacturer', 'osVersion'].every(key => typeof sessionOrigin[key] === 'string' && /^[A-Za-z0-9 ._()+-]{1,100}$/.test(sessionOrigin[key])))) throw new ExpediaError('INVALID_CLIENT_METADATA', 'The saved session origin is invalid.');
    this.jar = new CookieJar(cookies); this.fetch = fetchImpl; this.userAgent = userAgent; this.duaid = duaid; this.baseHeaders = clientHeaders({ sessionOrigin });
  }
  async request(url, { method = 'GET', body, headers = {}, responseType = 'json', allowRedirectResponse = false, includeCookies = true } = {}) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !FIRST_PARTY(u.hostname) || u.username || u.password) throw new ExpediaError('INVALID_ENDPOINT', 'Only HTTPS Expedia endpoints are accepted.');
    const cookie = includeCookies ? this.jar.header(u) : '';
    let response;
    try { response = await this.fetch(u, { method, headers: { ...this.baseHeaders, ...(this.userAgent ? { 'user-agent': this.userAgent } : {}), ...(includeCookies && this.duaid ? { 'Device-User-Agent-ID': this.duaid } : {}), ...(cookie ? { cookie } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: AbortSignal.timeout(45000) }); }
    catch { throw new ExpediaError('NETWORK_ERROR', 'Expedia could not be reached. This request was not automatically retried.'); }
    if (includeCookies) this.jar.receive(response.headers, u);
    const text = await response.text();
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const delay = /^\d+$/.test(retryAfter ?? '') ? Number(retryAfter) : retryAfter ? Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000) : null;
      throw new ExpediaError('RATE_LIMITED', 'Expedia rate limited this request. It was not automatically retried.', {
        status: 429, retryAfterSeconds: Number.isSafeInteger(delay) && delay >= 0 ? delay : null,
      });
    }
    if (!response.ok && !(allowRedirectResponse && method === 'GET' && response.status >= 300 && response.status < 400)) throw new ExpediaError('HTTP_ERROR', `Expedia returned HTTP ${response.status}.`, { status: response.status, contentType: response.headers.get('content-type'), requestId: response.headers.get('x-request-id') });
    if (responseType === 'response') return { status: response.status, headers: response.headers, text };
    if (responseType === 'text') return text;
    try { return JSON.parse(text); }
    catch { throw new ExpediaError('UNEXPECTED_RESPONSE', 'Expedia returned a web page instead of API data.', { contentType: response.headers.get('content-type') }); }
  }
  async graphql({ operationName, variables, group, fullDocument = false }) {
    if (!/^[A-Za-z0-9_]+$/.test(operationName) || !['auth', 'flights', 'checkout'].includes(group)) throw new ExpediaError('INVALID_OPERATION', 'Unknown Expedia operation.');
    const document = (await readFile(new URL(`./graphql/${group}/${operationName}.graphql`, import.meta.url), 'utf8')).trimEnd();
    const hash = createHash('sha256').update(document).digest('hex');
    const request = { operationName, variables, extensions: { persistedQuery: { version: 1, sha256Hash: hash } }, ...(fullDocument ? { query: document } : {}) };
    const headers = { 'x-apollo-operation-name': operationName, 'x-apollo-operation-id': hash,
      'x-page-id': group === 'auth' ? 'APP.UL,U,90' : group === 'checkout' ? 'page.Checkout.Payment,F,40' : /detail|summary|productcard/i.test(operationName) ? 'App.Flight.RateDetails,F,30' : variables?.flightsSearchContext?.tripType === 'ROUND_TRIP' ? 'App.Flight.Search.Roundtrip.Out,F,20' : 'App.Flight.Search.OneWay,F,20' };
    let result = await this.request('https://www.expedia.com/graphql', { method: 'POST', body: request, headers });
    // APQ cache misses execute nothing, so a document fallback cannot duplicate a mutation.
    if (!fullDocument && !result.data && result.errors?.length && result.errors.every(error => error.extensions?.code === 'PERSISTED_QUERY_NOT_FOUND' || error.message === 'PersistedQueryNotFound')) result = await this.request('https://www.expedia.com/graphql', { method: 'POST', body: { ...request, query: document }, headers });
    return result;
  }
}
