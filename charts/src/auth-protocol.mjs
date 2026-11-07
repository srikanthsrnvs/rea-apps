import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { ChartsError } from './errors.mjs';

export const AUTH_ORIGIN = 'https://auth.tradingview.com';
export const CALLBACK = 'tradingview://browser-auth/';
export const fingerprint = session => session ? createHash('sha256').update(JSON.stringify(session.credentials)).digest('hex') : null;
export function createAttempt({ session, replace = false, username, clientProfile = 'orin', now = Date.now() } = {}) {
  const keySource = randomBytes(16).toString('hex');
  const keyHash = createHash('sha256').update(keySource).digest('hex');
  const approval = new URL('/accounts/tvd/connect/', AUTH_ORIGIN);
  approval.search = new URLSearchParams({ locale: 'en', key: keyHash, redirect_url: CALLBACK }).toString();
  return { version: 1, id: randomUUID(), phase: 'awaiting_callback', keySource, approvalUrl: approval.href,
    previousBinding: fingerprint(session), replace, username, clientProfile, createdAt: now, expiresAt: now + 10 * 60000 };
}
export function parseCallback(value) {
  let url;
  try { url = new URL(value); } catch { throw new ChartsError('INVALID_CALLBACK', 'Supply the official TradingView app authorization link.'); }
  const token = url.searchParams.get('token');
  if (url.protocol !== 'tradingview:' || url.hostname !== 'browser-auth' || url.pathname !== '/'
    || url.username || url.password || url.port || url.hash || [...url.searchParams.keys()].some(key => key !== 'token')
    || url.searchParams.getAll('token').length !== 1 || !token || token.length > 8192 || /[\x00-\x20\x7f]/u.test(token)) {
    throw new ChartsError('INVALID_CALLBACK', 'The callback must be an unmodified tradingview://browser-auth/ authorization link with one token.');
  }
  return token;
}
export function completionUrl(pending, token) {
  const url = new URL('/accounts/tvd/complete/', AUTH_ORIGIN);
  url.search = new URLSearchParams({ token, key_source: pending.keySource }).toString();
  return url;
}
export function approvalResult(pending) {
  const client = new URL('rea-charts://authorize/');
  client.search = new URLSearchParams({ profile: pending.clientProfile ?? 'orin', login_id: pending.id }).toString();
  return { status: 'authorization_required', message: 'On a Mac with the Charts login receiver configured, open clientUrl. It opens the official TradingView sign-in and returns approval to this host automatically. approvalUrl is the manual/native-client alternative; a browser alone cannot receive its callback.',
    loginId: pending.id, approvalUrl: pending.approvalUrl, expiresAt: new Date(pending.expiresAt).toISOString(),
    clientUrl: client.href, clientProfile: pending.clientProfile ?? 'orin',
    callbackType: CALLBACK, callbackReceiverRequired: true, hostRuntime: 'Node HTTP only', automaticPolling: false };
}
