import { AmazonError } from './errors.mjs';

export const AMAZON_AUTH = Object.freeze({
  origin: 'https://api.amazon.com',
  approvalUrl: 'https://www.amazon.com/code',
  appName: 'com.amazon.mShop.android.shopping',
  appVersion: '1243240206',
  deviceType: 'A1MPSLFC7L5AFK',
  softwareVersion: '130050002',
  cookieDomain: '.amazon.com',
});

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(message = 'Amazon returned an incomplete authentication response.') {
  throw new AmazonError('AUTH_PROTOCOL_ERROR', message);
}
function string(value, label = 'authentication value', limit = 32768) {
  if (typeof value !== 'string' || !value || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) invalid(`Invalid ${label}.`);
  return value;
}
function positive(value, label, maximum = 86400) {
  if (!/^[0-9]+$/.test(String(value))) invalid(`Invalid ${label}.`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) invalid(`Invalid ${label}.`);
  return n;
}
function profileValues(profile) {
  if (!object(profile)) invalid('A device profile is required.');
  const p = Object.fromEntries(['appName', 'appVersion', 'deviceModel', 'osVersion', 'deviceType', 'deviceSerial'].map(key => [key, string(profile[key], 'device profile', 512)]));
  if (!/^[A-Za-z0-9]{1,51}$/.test(p.deviceSerial)) invalid('The device serial must contain 1 to 51 alphanumeric characters.');
  if (!/^[A-Za-z0-9]+$/.test(p.deviceType)) invalid('The device type must be alphanumeric.');
  return p;
}
function headers(secureSessionToken) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'accept-language': 'en-US',
    'x-amzn-identity-auth-domain': 'api.amazon.com',
    ...(secureSessionToken ? { 'x-amzn-identity-secure-session-token': string(secureSessionToken) } : {}),
  };
}
function request(path, body, sst) {
  return { url: `${AMAZON_AUTH.origin}${path}`, method: 'POST', headers: headers(sst), body };
}
export function createCodePairRequest(profile) {
  const p = profileValues(profile);
  return request('/auth/create/codepair', {
    code_data: { domain: 'Device', app_name: p.appName, app_version: p.appVersion, device_model: p.deviceModel, os_version: p.osVersion, device_type: p.deviceType, device_serial: p.deviceSerial },
  });
}
export function parseCodePairResponse(input) {
  if (!object(input)) invalid();
  return {
    publicCode: string(input.public_code, 'public pairing code', 128),
    privateCode: string(input.private_code),
    expiresIn: positive(input.expires_in, 'pairing expiration'),
    pollInterval: positive(input.polling_interval_in_seconds, 'polling interval', 300),
    ...(input.secureSessionToken ? { secureSessionToken: string(input.secureSessionToken) } : {}),
  };
}
export function registerCodePairRequest(profile, pair) {
  const p = profileValues(profile);
  if (!object(pair)) invalid('A pairing response is required.');
  return request('/auth/register', {
    auth_data: { use_global_authentication: 'true', code_pair: { public_code: string(pair.publicCode, 'public pairing code', 128), private_code: string(pair.privateCode) } },
    registration_data: { domain: 'DeviceLegacy', device_type: p.deviceType, device_serial: p.deviceSerial, app_name: p.appName, app_version: p.appVersion, device_model: p.deviceModel, os_version: p.osVersion, software_version: AMAZON_AUTH.softwareVersion },
    requested_token_type: ['bearer', 'mac_dms', 'store_authentication_cookie', 'website_cookies'],
    cookies: { domain: AMAZON_AUTH.cookieDomain, website_cookies: [] },
    requested_extensions: ['device_info', 'customer_info'],
  }, pair.secureSessionToken);
}
function serverError(error) {
  const serverCode = typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(error.code) ? error.code : 'Unknown';
  throw new AmazonError('AUTH_REJECTED', 'Amazon did not authorize this authentication request.', { serverCode });
}
function flag(value) { return value === true || value === 'true'; }
function privateKey(value) {
  if (typeof value !== 'string' || !value || value.length > 131072 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid('Amazon returned an invalid device key.');
  return value;
}
function parseCookies(input) {
  if (!Array.isArray(input)) invalid('Amazon did not return a valid cookie list.');
  return input.map(c => {
    if (!object(c)) invalid();
    const name = string(c.Name, 'cookie name', 256), value = c.Value;
    if (typeof value !== 'string' || value.length > 32768 || /[\x00-\x1f\x7f]/.test(value)) invalid('Amazon returned an invalid cookie value.');
    const domain = string(c.Domain ?? AMAZON_AUTH.cookieDomain, 'cookie domain', 256).replace(/^\./, '').toLowerCase();
    if (!(domain === 'amazon.com' || domain.endsWith('.amazon.com')) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[;\r\n]/.test(value)) invalid('Amazon returned an invalid authentication cookie.');
    const path = c.Path ?? '/';
    if (typeof path !== 'string' || !path.startsWith('/') || /[\r\n\x00]/.test(path)) invalid('Amazon returned an invalid cookie path.');
    let expiresAt;
    if (c.Expires && String(c.Expires).toLowerCase() !== 'session') {
      expiresAt = Date.parse(c.Expires);
      if (!Number.isFinite(expiresAt)) invalid('Amazon returned an invalid cookie expiration.');
    }
    return { name, value, domain, path, secure: flag(c.Secure), httpOnly: flag(c.HttpOnly), hostOnly: false, ...(expiresAt === undefined ? {} : { expiresAt }) };
  });
}
export function parseRegistrationResponse(input, { now = Date.now() } = {}) {
  if (!object(input?.response)) invalid();
  const response = input.response;
  if (response.error) serverError(response.error);
  if (response.challenge) throw new AmazonError('AUTH_CHALLENGE_REQUIRED', 'Amazon requires additional verification.');
  const s = response.success;
  if (!object(s) || !object(s.tokens?.bearer)) invalid();
  const bearer = s.tokens.bearer, expiresIn = positive(bearer.expires_in, 'access token expiration', 31536000);
  const customer = s.extensions?.customer_info ?? {};
  const cookies = parseCookies(s.tokens.website_cookies ?? []);
  return {
    customerId: string(s.customer_id, 'customer identifier', 512),
    accessToken: string(bearer.access_token), refreshToken: string(bearer.refresh_token),
    expiresIn, expiresAt: now + expiresIn * 1000, cookies,
    customer: { ...(typeof customer.name === 'string' ? { name: customer.name } : {}), ...(typeof customer.given_name === 'string' ? { givenName: customer.given_name } : {}), ...(typeof customer.preferred_marketplace === 'string' ? { marketplace: customer.preferred_marketplace } : {}) },
    ...(s.secureSessionToken ? { secureSessionToken: string(s.secureSessionToken) } : {}),
    ...(s.tokens.mac_dms ? { macDms: { adpToken: string(s.tokens.mac_dms.adp_token), devicePrivateKey: privateKey(s.tokens.mac_dms.device_private_key) } } : {}),
  };
}
export function refreshTokenRequest(profile, session) {
  const p = profileValues(profile);
  return request('/auth/token', {
    app_name: p.appName, app_version: AMAZON_AUTH.softwareVersion,
    device_metadata: { device_os_family: 'linux', device_type: p.deviceType, device_serial: p.deviceSerial, model: p.deviceModel, os_version: p.osVersion },
    source_token_type: 'refresh_token', source_token: string(session?.refreshToken), requested_token_type: 'access_token',
  }, session?.secureSessionToken);
}
export function parseRefreshResponse(input, { now = Date.now() } = {}) {
  if (!object(input)) invalid();
  if (input.error) serverError(typeof input.error === 'object' ? input.error : { code: input.error });
  if (input.token_type !== 'bearer') invalid('Amazon returned an unexpected token type.');
  const expiresIn = positive(input.expires_in, 'access token expiration', 31536000);
  return { accessToken: string(input.access_token), expiresIn, expiresAt: now + expiresIn * 1000, ...(input.refresh_token ? { refreshToken: string(input.refresh_token) } : {}), ...(input.secureSessionToken ? { secureSessionToken: string(input.secureSessionToken) } : {}) };
}

// Cookie renewal is a separate native form exchange; bearer refresh alone does
// not renew the website session. The caller must encode `body` as form fields.
export function refreshCookiesRequest(profile, session) {
  const p = profileValues(profile);
  return {
    url: `${AMAZON_AUTH.origin}/auth/token`, method: 'POST', encoding: 'form', includeCookies: true,
    headers: { ...headers(session?.secureSessionToken), 'content-type': 'application/x-www-form-urlencoded' },
    body: { requested_token_type: 'auth_cookies', app_name: p.appName, app_version: AMAZON_AUTH.softwareVersion,
      'di.sdk.version': '20260904N', domain: AMAZON_AUTH.cookieDomain, source_token_type: 'refresh_token', source_token: string(session?.refreshToken) },
  };
}
export function parseCookiesRefreshResponse(input) {
  if (!object(input?.response)) invalid();
  const response = input.response;
  if (response.error) serverError(response.error);
  if (response.challenge) throw new AmazonError('AUTH_CHALLENGE_REQUIRED', 'Amazon requires additional verification.');
  if (!object(response.tokens?.cookies)) invalid('Amazon did not return refreshed website cookies.');
  const cookies = Object.entries(response.tokens.cookies).flatMap(([domain, values]) => {
    if (!Array.isArray(values)) invalid('Amazon returned an invalid cookie list.');
    return parseCookies(values.map(c => {
      if (!object(c)) invalid();
      return { ...c, Domain: domain };
    }));
  });
  if (!cookies.length) invalid('Amazon did not return refreshed website cookies.');
  return { cookies, ...(response.tokens.ttl === undefined ? {} : { cookiesTtl: positive(response.tokens.ttl, 'cookie refresh lifetime', 315360000) }), ...(input.secureSessionToken ? { secureSessionToken: string(input.secureSessionToken) } : {}) };
}
