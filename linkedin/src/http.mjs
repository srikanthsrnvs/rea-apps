import { LinkedInError } from './errors.mjs';
import { ORIGIN, USER_AGENT, csrfToken, cookieHeader, receiveCookies, newSession } from './session.mjs';

// Rest.li 2.0 structural punctuation is literal; only scalar values are escaped.
function scalar(value) { return encodeURIComponent(String(value)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
export function restli(value) {
  if (Array.isArray(value)) return `List(${value.map(restli).join(',')})`;
  if (value && typeof value === 'object') return `(${Object.entries(value).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${scalar(k)}:${restli(v)}`).join(',')})`;
  if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new LinkedInError('INVALID_ARGUMENT', 'Invalid Rest.li variable.');
  return scalar(value);
}

export class LinkedInClient {
  constructor(session = newSession(), { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
    this.session = session;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request({ path, method = 'GET', query, body, form, multipartForm, headers = {}, allowText = false, rawQuery, allowStatuses = [], responseMeta = false } = {}) {
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || !path.startsWith('/') || path.startsWith('//')) throw new LinkedInError('UNSAFE_URL', 'Requests must use a LinkedIn path.');
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    if (rawQuery) url.search = rawQuery;
    if ([form !== undefined, body !== undefined, multipartForm !== undefined].filter(Boolean).length > 1) throw new LinkedInError('INVALID_ARGUMENT', 'Provide only one request body encoding.');
    let payload = form ? new URLSearchParams(form).toString() : body === undefined ? undefined : JSON.stringify(body);
    if (multipartForm !== undefined) {
      payload = new FormData();
      for (const [key, value] of Object.entries(multipartForm)) payload.append(key, String(value));
    }
    const csrf = csrfToken(this.session);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, { method, redirect: 'manual', signal: controller.signal,
        headers: { 'User-Agent': this.session.userAgent || USER_AGENT, Accept: 'application/json',
          'X-RestLi-Protocol-Version': '2.0.0', 'Accept-Language': 'en-US',
          ...(csrf ? { 'Csrf-Token': csrf } : {}), 'X-UDID': this.session.installationId,
          ...(payload !== undefined && multipartForm === undefined ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
          ...headers, Cookie: cookieHeader(this.session, url) }, body: payload });
      receiveCookies(this.session, response.headers, url);
      // A server rejection invalidates earlier validation even when it keeps
      // li_at in the cookie jar. Saved credentials alone are not a live session.
      if (response.status === 401) this.session.validatedAt = null;
      if (response.status >= 300 && response.status < 400 && !allowStatuses.includes(response.status)) {
        this.session.validatedAt = null;
        const location = new URL(response.headers.get('location') || '/', url);
        throw new LinkedInError('AUTH_REQUIRED', 'LinkedIn redirected this request. Sign in again and complete any account verification.', { status: response.status, verificationUrl: location.origin === ORIGIN ? location.origin + location.pathname : undefined });
      }
      let text = '';
      if (Number(response.headers.get('content-length')) > 15_000_000) throw new LinkedInError('RESPONSE_TOO_LARGE', 'LinkedIn returned an oversized response.');
      const reader = response.body?.getReader();
      if (reader) {
        const chunks = []; let size = 0;
        for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length;
          if (size > 15_000_000) { await reader.cancel(); throw new LinkedInError('RESPONSE_TOO_LARGE', 'LinkedIn returned an oversized response.'); }
          chunks.push(Buffer.from(value)); }
        text = Buffer.concat(chunks).toString('utf8');
      }
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
      if (!response.ok && !allowStatuses.includes(response.status)) {
        const status = response.status;
        const serverCode = data?.code === 'RECIPIENT_NOT_FIRST_DEGREE_CONNECTION' ? data.code : undefined;
        throw new LinkedInError(status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'ACCESS_DENIED' : status === 429 ? 'RATE_LIMITED' : 'API_ERROR',
          `LinkedIn returned HTTP ${status}.`, { status, retryAfter: response.headers.get('retry-after') ?? undefined,
            ...(serverCode ? { serverCode } : {}) });
      }
      if (data === null && !allowText) throw new LinkedInError('INVALID_RESPONSE', 'LinkedIn returned a page instead of API JSON. Complete any required sign-in verification.');
      return responseMeta ? { status: response.status, headers: response.headers, data: data ?? text } : data ?? text;
    } catch (error) {
      if (error instanceof LinkedInError) throw error;
      throw new LinkedInError('NETWORK_ERROR', 'LinkedIn request failed before a response was confirmed.', { ambiguous: method !== 'GET' && method !== 'HEAD' });
    } finally { clearTimeout(timer); }
  }

  async graphql({ queryId, variables = {}, field, queryName, allowPartialData = false }) {
    if (!/^[A-Za-z][\w.]+\.[a-f0-9]{32}$/.test(queryId)) throw new LinkedInError('INVALID_ARGUMENT', 'Invalid persisted query ID.');
    const rawQuery = `queryId=${scalar(queryId)}${queryName ? `&queryName=${scalar(queryName)}` : ''}&variables=${restli(variables)}`;
    const payload = await this.request({ path: '/voyager/api/graphql', rawQuery });
    const errors = payload.errors ?? payload.data?.errors;
    const root = payload.data?.data ?? payload.data ?? payload;
    const primary = field && root && typeof root === 'object' ? root[field] ?? root[`*${field}`] : null;
    const usablePartial = allowPartialData && primary != null && errors?.every(error =>
      error.extensions?.classification === 'DataFetchingException' && Array.isArray(error.path)
      && error.path[0] === field && error.path.length >= 3);
    if (errors?.length && !usablePartial) throw new LinkedInError('GRAPHQL_ERROR', 'LinkedIn could not complete this query.', { count: errors.length });
    // Keep the envelope and included entity table for the feature normalizers.
    if (field && (!root || typeof root !== 'object' || (!(field in root) && !(`*${field}` in root)))) {
      throw new LinkedInError('PROTOCOL_CHANGED', `LinkedIn response is missing ${field}.`);
    }
    return payload;
  }
}
