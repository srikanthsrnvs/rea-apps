import { randomUUID } from 'node:crypto';
import { InstagramError } from './errors.mjs';

const domains = new Set(['instagram.com', '.instagram.com', 'www.instagram.com']);
export const instagramOrigin = 'https://www.instagram.com';
export const defaultAppId = '936619743392459';

export function normalizeCookies(input, now = Date.now()) {
  if (!Array.isArray(input) || input.length > 1000) {
    throw new InstagramError('INVALID_SESSION', 'Expected a browser cookie array.');
  }
  const cookies = input.filter(cookie => domains.has(cookie?.domain)).map(cookie => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(cookie.name)
      || typeof cookie.value !== 'string' || cookie.value.length > 8192
      || /[\x00-\x20\x7f;,]/.test(cookie.value)
      || typeof cookie.path !== 'string' || !cookie.path.startsWith('/')
      || !Number.isFinite(cookie.expires) || cookie.expires < -1) {
      throw new InstagramError('INVALID_SESSION', 'The Instagram cookies have invalid fields.');
    }
    return {
      name: cookie.name, value: cookie.value, domain: cookie.domain,
      path: cookie.path, expires: cookie.expires,
      secure: cookie.secure !== false, httpOnly: cookie.httpOnly === true,
    };
  }).filter(cookie => cookie.expires === -1 || cookie.expires * 1000 > now);
  const session = cookies.find(cookie => cookie.name === 'sessionid'
    && '/api/v1/accounts/current_user/'.startsWith(cookie.path));
  if (!session?.value) throw new InstagramError('LOGIN_REQUIRED', 'No valid Instagram session cookie was found.');
  return cookies;
}

export function sessionFromExport(input) {
  const cookies = normalizeCookies(input?.cookies);
  const userAgent = input?.userAgent ?? 'Mozilla/5.0';
  if (typeof userAgent !== 'string' || userAgent.length > 1000 || /[\r\n]/.test(userAgent)) {
    throw new InstagramError('INVALID_SESSION', 'Invalid browser user agent.');
  }
  return {
    version: 1, cookies, userAgent, deviceId: randomUUID(), appId: defaultAppId,
    wwwClaim: '0', importedAt: new Date().toISOString(), account: null,
  };
}

export function requestHeaders(session, pathname, now = Date.now()) {
  const cookies = normalizeCookies(session?.cookies, now)
    .filter(cookie => pathname.startsWith(cookie.path));
  const csrf = cookies.find(cookie => cookie.name === 'csrftoken')?.value;
  const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  if (cookieHeader.length > 32_768) throw new InstagramError('INVALID_SESSION', 'Cookie header is too large.');
  return {
    accept: 'application/json', 'user-agent': session.userAgent,
    cookie: cookieHeader, referer: `${instagramOrigin}/`,
    'x-ig-app-id': defaultAppId, 'x-requested-with': 'XMLHttpRequest',
    'x-ig-www-claim': session.wwwClaim ?? '0',
    ...(csrf ? { 'x-csrftoken': csrf } : {}),
  };
}

export function updateResponseCookies(session, headers, now = Date.now()) {
  const cookies = [...session.cookies];
  for (const value of headers.getSetCookie()) {
    const [pair, ...attributes] = value.split(';');
    const equal = pair.indexOf('=');
    if (equal < 1) continue;
    const cookie = {
      name: pair.slice(0, equal).trim(), value: pair.slice(equal + 1).trim(),
      domain: 'www.instagram.com', path: '/', expires: -1,
      secure: false, httpOnly: false,
    };
    for (const attribute of attributes) {
      const at = attribute.indexOf('=');
      const name = (at === -1 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
      const data = at === -1 ? '' : attribute.slice(at + 1).trim();
      if (name === 'domain') cookie.domain = data.toLowerCase();
      if (name === 'path') cookie.path = data;
      if (name === 'secure') cookie.secure = true;
      if (name === 'httponly') cookie.httpOnly = true;
      if (name === 'expires') cookie.expires = Math.floor(Date.parse(data) / 1000);
      if (name === 'max-age' && /^-?\d+$/.test(data)) cookie.maxAge = Number(data);
    }
    if (cookie.maxAge !== undefined) cookie.expires = Math.floor(now / 1000) + cookie.maxAge;
    delete cookie.maxAge;
    if (!domains.has(cookie.domain)) continue;
    const existing = cookies.findIndex(c => c.name === cookie.name
      && c.domain === cookie.domain && c.path === cookie.path);
    if (existing !== -1) cookies.splice(existing, 1);
    if (cookie.expires === -1 || cookie.expires * 1000 > now) cookies.push(cookie);
  }
  const claim = headers.get('x-ig-set-www-claim');
  const updated = { ...session, cookies };
  if (claim && claim.length < 2048 && !/[\r\n]/.test(claim)) updated.wwwClaim = claim;
  return updated;
}

export function sessionStatus(session, now = Date.now()) {
  if (!session) return { loggedIn: false };
  const cookie = session.cookies?.find(cookie => cookie.name === 'sessionid');
  return {
    loggedIn: Boolean(cookie?.value) && (cookie.expires === -1 || cookie.expires * 1000 > now),
    account: session.account ?? null, importedAt: session.importedAt,
    expiresAt: cookie?.expires > 0 ? new Date(cookie.expires * 1000).toISOString() : null,
    serverValidatedAt: session.validatedAt ?? null,
    note: 'Local status; run instagram me to validate the session with Instagram.',
  };
}
