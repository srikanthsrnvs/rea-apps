import { ClaudeError } from './errors.mjs';
import { randomUUID } from 'node:crypto';

const FIRST_PARTY = host => host === 'claude.ai' || host.endsWith('.claude.ai');
const API_HOST = FIRST_PARTY;
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

async function boundedText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let bytes = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new ClaudeError('RESPONSE_TOO_LARGE', 'Claude returned more data than this command supports.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export class ClaudeClient {
  constructor({ cookies = [], headers = {}, fetchImpl = fetch } = {}) {
    this.jar = new CookieJar(cookies);
    this.fetch = fetchImpl;
    this.headers = headers;
  }
  async request(endpoint, { method = 'GET', json, form, headers = {}, responseType = 'json', includeCookies = true, maxBytes = 32 * 1024 * 1024, timeoutMs = 30000, signal } = {}) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || !API_HOST(url.hostname) || url.username || url.password || url.port) throw new ClaudeError('INVALID_ENDPOINT', 'Only supported HTTPS Claude endpoints are accepted.');
    if (json !== undefined && form !== undefined || ['GET', 'HEAD'].includes(method) && (json !== undefined || form !== undefined)) throw new ClaudeError('INVALID_REQUEST', 'Invalid request body.');
    const cookie = includeCookies ? this.jar.header(url) : '';
    const requestHeaders = { accept: responseType === 'json' ? 'application/json' : 'text/html,application/xhtml+xml', 'user-agent': `rea-claude-chat-cli/0.1 Node/${process.versions.node} (${process.platform}; ${process.arch})`, ...this.headers, 'X-Client-Request-Id':randomUUID(), ...(cookie ? { cookie } : {}), ...headers };
    let body;
    if (json !== undefined) { body = JSON.stringify(json); requestHeaders['content-type'] ??= 'application/json'; }
    if (form !== undefined) { body = new URLSearchParams(form).toString(); requestHeaders['content-type'] ??= 'application/x-www-form-urlencoded'; }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new ClaudeError('INVALID_TIMEOUT', 'Request timeout must be between 1 and 600000 milliseconds.');
    let response;
    try { response = await this.fetch(url, { method, headers: requestHeaders, ...(body === undefined ? {} : { body }), redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) }); }
    catch { throw new ClaudeError('NETWORK_ERROR', 'Claude could not be reached. The request was not automatically retried.'); }
    if (includeCookies) this.jar.receive(response.headers, url);
    if (response.status === 429) { await response.body?.cancel(); throw new ClaudeError('RATE_LIMITED', 'Claude asked this client to wait. The request was not retried.', { httpStatus: 429 }); }
    if (responseType === 'stream' && response.ok) {
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) { await response.body?.cancel(); throw new ClaudeError('UNEXPECTED_RESPONSE', 'Claude returned no completion event stream.'); }
      return { status: response.status, headers: response.headers, body: response.body };
    }
    const text = await boundedText(response, maxBytes);
    const result = { status: response.status, headers: response.headers, text };
    if (responseType === 'response') return result;
    if (response.status >= 300 && response.status < 400) throw new ClaudeError('REDIRECT_REQUIRED', 'Claude returned a redirect; account credentials were not forwarded.', { httpStatus: response.status });
    if (!response.ok) throw new ClaudeError('HTTP_ERROR', 'Claude rejected this request.', { httpStatus: response.status });
    if (responseType === 'text') return text;
    try { return JSON.parse(text); }
    catch { throw new ClaudeError('UNEXPECTED_RESPONSE', 'Claude returned a page instead of the expected API response.', { contentType: response.headers.get('content-type') }); }
  }
}
