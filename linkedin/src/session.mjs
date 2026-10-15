import { randomUUID, randomBytes } from 'node:crypto';
import { LinkedInError } from './errors.mjs';

export const ORIGIN = 'https://www.linkedin.com';
export const USER_AGENT = 'LinkedIn/4.1.1261 Android/16 (Google Pixel 10 Pro Fold)';

export function newSession() {
  return { version: 1, createdAt: new Date().toISOString(), installationId: randomUUID(),
    userAgent: USER_AGENT, cookies: [{ name: 'JSESSIONID', value: `"ajax:${(BigInt('0x' + randomBytes(8).toString('hex')) % 9223372036854775807n).toString().padStart(19, '0')}"`,
      domain: '.linkedin.com', path: '/', secure: true, expires: null }] };
}

export function sessionFromExport(input) {
  const source = Array.isArray(input) ? { cookies: input } : input;
  if (!source || !Array.isArray(source.cookies)) throw new LinkedInError('INVALID_SESSION', 'Provide a JSON object containing a cookies array.');
  const session = newSession();
  session.cookies = source.cookies.filter(c => c && typeof c.name === 'string' && typeof c.value === 'string'
    && /^\.?([a-z0-9-]+\.)*linkedin\.com$/i.test(c.domain || '') && !/[\r\n;]/.test(c.name + c.value))
    .map(c => ({ name: c.name, value: c.value, domain: c.domain.toLowerCase(), path: c.path || '/',
      hostOnly: c.hostOnly ?? !c.domain.startsWith('.'), secure: c.secure !== false,
      expires: Number.isFinite(c.expires) && c.expires > 0 ? c.expires * (source.version === 1 && source.createdAt ? 1 : 1000) : null }));
  if (!session.cookies.some(c => c.name === 'li_at' && c.value)) throw new LinkedInError('INVALID_SESSION', 'The export has no LinkedIn login cookie.');
  if (!session.cookies.some(c => c.name === 'JSESSIONID')) session.cookies.push(newSession().cookies[0]);
  if (typeof source.userAgent === 'string' && source.userAgent.length < 1024 && !/[\r\n]/.test(source.userAgent)) session.userAgent = source.userAgent;
  return session;
}

export function cookieHeader(session, url, now = Date.now()) {
  const target = new URL(url);
  if (target.origin !== ORIGIN) throw new LinkedInError('UNSAFE_URL', 'Session requests must use www.linkedin.com over HTTPS.');
  return session.cookies.filter(c => (!c.expires || c.expires > now)
    && (!c.secure || target.protocol === 'https:')
    && (c.hostOnly ? target.hostname === c.domain.replace(/^\./, '') : target.hostname === c.domain.replace(/^\./, '') || target.hostname.endsWith('.' + c.domain.replace(/^\./, '')))
    && (target.pathname === c.path || target.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/')))
    .sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; ');
}

export function receiveCookies(session, headers, url, now = Date.now()) {
  const target = new URL(url);
  for (const raw of headers.getSetCookie?.() ?? []) {
    const [pair, ...attrs] = raw.split(';');
    const equal = pair.indexOf('=');
    if (equal < 1) continue;
    const cookie = { name: pair.slice(0, equal).trim(), value: pair.slice(equal + 1).trim(),
      domain: target.hostname, hostOnly: true, path: target.pathname.slice(0, target.pathname.lastIndexOf('/') + 1) || '/', secure: false, expires: null };
    let maxAge;
    for (const attribute of attrs) {
      const [key, ...values] = attribute.trim().split('=');
      const value = values.join('=');
      switch (key.toLowerCase()) {
        case 'domain': cookie.domain = value.toLowerCase(); cookie.hostOnly = false; break;
        case 'path': if (value.startsWith('/')) cookie.path = value; break;
        case 'secure': cookie.secure = true; break;
        case 'expires': if (Number.isFinite(Date.parse(value))) cookie.expires = Date.parse(value); break;
        case 'max-age': if (/^-?\d+$/.test(value)) maxAge = Number(value); break;
      }
    }
    const domain = cookie.domain.replace(/^\./, '');
    if (!(domain === 'linkedin.com' || domain.endsWith('.linkedin.com'))
      || !(target.hostname === domain || target.hostname.endsWith('.' + domain))
      || /[\r\n;]/.test(cookie.name + cookie.value)) continue;
    if (maxAge !== undefined) cookie.expires = now + maxAge * 1000;
    session.cookies = session.cookies.filter(c => !(c.name === cookie.name && c.domain.replace(/^\./, '') === domain && c.path === cookie.path));
    if (!cookie.expires || cookie.expires > now) session.cookies.push(cookie);
  }
}

export function csrfToken(session) {
  const cookie = cookieHeader(session, ORIGIN + '/voyager/api/').split('; ').find(c => c.startsWith('JSESSIONID='));
  return cookie?.slice('JSESSIONID='.length).replace(/^"|"$/g, '') ?? null;
}

export function sessionStatus(session) {
  return { authenticated: Boolean(session?.validatedAt && session?.cookies?.some(c => c.name === 'li_at' && (!c.expires || c.expires > Date.now()))),
    account: session?.account ?? null, validatedAt: session?.validatedAt ?? null };
}
