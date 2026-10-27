import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { ChartsError } from './errors.mjs';

export const AUTH_ORIGIN = 'https://auth.tradingview.com';
export const CALLBACK = 'tradingview://browser-auth/';
export const fingerprint = session => session ? createHash('sha256').update(JSON.stringify(session.credentials)).digest('hex') : null;
export function createAttempt({ session, replace = false, username, now = Date.now() } = {}) {
  const keySource = randomBytes(16).toString('hex');
  const keyHash = createHash('sha256').update(keySource).digest('hex');
  const approval = new URL('/accounts/tvd/connect/', AUTH_ORIGIN);
  approval.search = new URLSearchParams({ locale: 'en', key: keyHash, redirect_url: CALLBACK }).toString();
  return { version: 1, id: randomUUID(), phase: 'awaiting_callback', keySource, approvalUrl: approval.href,
    previousBinding: fingerprint(session), replace, username, createdAt: now, expiresAt: now + 10 * 60000 };
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
  return { status: 'authorization_required', message: 'Open approvalUrl on your own device and authorize TradingView. A receiver on that device must capture the tradingview://browser-auth/ callback and pass it to auth complete. A browser without a receiver cannot finish the handoff.',
    loginId: pending.id, approvalUrl: pending.approvalUrl, expiresAt: new Date(pending.expiresAt).toISOString(),
    callbackType: CALLBACK, callbackReceiverRequired: true, hostRuntime: 'Node HTTP only', automaticPolling: false };
}
