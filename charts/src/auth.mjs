import { ChartsError } from './errors.mjs';
import { createAttempt, parseCallback, completionUrl, approvalResult, fingerprint } from './auth-protocol.mjs';
import { validCookie, sessionStatus } from './session.mjs';
import { boundedFetch } from './http.mjs';
import { readPrivateText } from './private-files.mjs';

async function callbackInput(options) {
  if (options['callback-url'] !== undefined) return options['callback-url'];
  if (!options['callback-file']) return undefined;
  try {
    return (await readPrivateText(options['callback-file'], 16384)).trim();
  } catch { throw new ChartsError('INVALID_ARGUMENT', 'The callback file must be a readable owner-only regular file of at most 16 KiB.'); }
}

export function credentialsFromHeaders(headers, responseUrl) {
  const result = {};
  for (const line of headers.getSetCookie()) {
    const [pair, ...attributes] = line.split(';'), index = pair.indexOf('=');
    const name = pair.slice(0, index).trim(), value = pair.slice(index + 1).trim();
    if (!['sessionid', 'sessionid_sign'].includes(name)) continue;
    const domain = attributes.find(item => /^\s*domain=/iu.test(item))?.split('=')[1]?.trim().replace(/^\./u, '').toLowerCase() ?? new URL(responseUrl).hostname;
    if (!['tradingview.com', 'www.tradingview.com'].includes(domain)) continue;
    const cookiePath = attributes.find(item => /^\s*path=/iu.test(item))?.split('=')[1]?.trim() ?? '/';
    if (cookiePath !== '/' || !validCookie(value)) continue;
    result[name === 'sessionid' ? 'session' : 'signature'] = value;
  }
  return result;
}

export function createAuth({ store, sdk, request = boundedFetch, now = Date.now }) {
  async function clearPending() {
    await store.removeRecord('candidate-session'); await store.removeRecord('pending-login');
  }
  async function validate(pending, candidate, signal) {
    signal?.throwIfAborted();
    const api = await sdk();
    const user = await api.getUser(candidate.credentials, { signal, fetch: request });
    if (!Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.username !== 'string' || !user.username
      || (pending.username && user.username.toLowerCase() !== pending.username.toLowerCase())) {
      throw new ChartsError('ACCOUNT_MISMATCH', 'The callback did not validate as the requested TradingView account.');
    }
    if (fingerprint(await store.load()) !== pending.previousBinding) throw new ChartsError('SESSION_CHANGED', 'The saved account changed during this login. Start a new authorization.');
    const session = { version: 1, credentials: candidate.credentials, loginId: pending.id,
      account: { id: user.id, username: user.username }, savedAt: new Date(now()).toISOString(),
      acquiredBy: 'native-desktop-callback', cookieExpiresAt: null };
    await store.save(session, { replace: pending.replace });
    await clearPending();
    return { status: 'authenticated', message: 'TradingView independently validated the callback session.',
      data: { ...sessionStatus(session), validated: true } };
  }
  return {
    async login(options, signal) {
      return store.lock(async () => {
        const session = await store.load();
        let pending = await store.read('pending-login');
        if (pending && session?.loginId === pending.id) { await clearPending(); pending = null; }
        if (pending && !['awaiting_callback', 'cancelled'].includes(pending.phase)) throw new ChartsError('LOGIN_IN_PROGRESS', 'Inspect auth status; finish validation or cancel the pending authorization before starting another.');
        if (session && !options.replace) return { status: 'authenticated', message: 'A local session is saved; use auth validate for a fresh check or login --replace to change account.', data: sessionStatus(session) };
        if (pending?.phase === 'awaiting_callback' && pending.expiresAt > now() && !options.replace) return approvalResult(pending);
        const attempt = createAttempt({ session, replace: options.replace, username: options.username, now: now() });
        await store.write('pending-login', attempt);
        return approvalResult(attempt);
      }, { signal });
    },
    async status(signal) {
      return store.lock(async () => {
        const pending = await store.read('pending-login');
        return { ...sessionStatus(await store.load()), pending: pending ? { loginId: pending.id,
          phase: pending.phase === 'awaiting_callback' && pending.expiresAt <= now() ? 'expired' : pending.phase,
          expiresAt: new Date(pending.expiresAt).toISOString() } : null };
      }, { signal });
    },
    async cancel(signal) {
      return store.lock(async () => { await clearPending();
        return { status: 'ok', message: 'The pending authorization was cancelled; the saved account is unchanged.' }; }, { signal });
    },
    async logout(signal) {
      return store.lock(async () => { await store.remove(); await clearPending();
        return { status: 'ok', message: 'Local Charts authorization and pending credentials were removed.' }; }, { signal });
    },
    async complete(options, signal) {
      if (options['callback-url'] !== undefined && options['callback-file'] !== undefined) throw new ChartsError('INVALID_ARGUMENT', 'Provide exactly one callback URL or callback file.');
      return store.lock(async () => {
        let pending = await store.read('pending-login');
        const session = await store.load();
        if (session?.loginId === options['login-id']) {
          if (pending?.id === session.loginId) await clearPending();
          return { status: 'authenticated', message: 'This authorization is already saved.', data: sessionStatus(session) };
        }
        if (!pending || pending.id !== options['login-id']) throw new ChartsError('LOGIN_NOT_FOUND', 'Use the login ID returned by charts login.');
        if (fingerprint(session) !== pending.previousBinding) throw new ChartsError('SESSION_CHANGED', 'The saved account changed during authorization.');
        const candidate = ['validating', 'exchanging', 'exchange_uncertain'].includes(pending.phase) ? await store.read('candidate-session') : null;
        if (candidate?.loginId === pending.id || pending.phase === 'validating') {
          if (candidate?.loginId !== pending.id) throw new ChartsError('STATE_ERROR', 'The acquired candidate session is missing. Start a fresh authorization.');
          if (pending.phase !== 'validating') {
            pending = { ...pending, phase: 'validating', keySource: undefined };
            await store.write('pending-login', pending);
          }
          return validate(pending, candidate, signal);
        }
        if (pending.phase !== 'awaiting_callback') throw new ChartsError('AUTH_OUTCOME_UNKNOWN', 'The previous exchange cannot be repeated. Cancel it and start a fresh authorization.');
        if (pending.expiresAt <= now()) throw new ChartsError('LOGIN_EXPIRED', 'The local approval deadline expired. Start a fresh authorization.');
        signal?.throwIfAborted();
        const supplied = await callbackInput(options);
        const token = supplied === undefined ? undefined : parseCallback(supplied);
        if (!token) throw new ChartsError('INVALID_ARGUMENT', 'Supply the official callback once using callback-url or callback-file.');
        signal?.throwIfAborted();
        await store.write('pending-login', { ...pending, phase: 'exchanging' });
        let response, body;
        try {
          response = await request(completionUrl(pending, token), { method: 'GET', redirect: 'manual', signal,
            headers: { referer: 'https://www.tradingview.com/', accept: 'application/json' } });
          const text = await response.text();
          body = text ? JSON.parse(text) : {};
          if (!body || Array.isArray(body) || typeof body !== 'object') throw new ChartsError('PROTOCOL_ERROR', 'TradingView returned an unexpected authorization response.');
        } catch (error) {
          await store.write('pending-login', { ...pending, phase: 'exchange_uncertain', keySource: undefined });
          throw error;
        }
        if (body.error === '2FA_required' || ['2FA_required', '2FA_challenge_not_generated'].includes(body.code)) {
          await store.write('pending-login', { ...pending, phase: 'additional_verification_required', keySource: undefined });
          return { status: 'additional_verification_required', message: 'TradingView requires an additional native-app 2FA step. This step is not yet implemented; no session was saved. The existing account is unchanged.' };
        }
        const credentials = credentialsFromHeaders(response.headers, response.url || 'https://auth.tradingview.com/');
        if (![200, 409].includes(response.status) || body.error || !credentials.session) {
          await store.write('pending-login', { ...pending, phase: 'rejected', keySource: undefined });
          throw new ChartsError('AUTH_REJECTED', 'TradingView did not issue an authenticated session for this callback. The exchange was not repeated.');
        }
        const acquired = { version: 1, loginId: pending.id, credentials };
        await store.write('candidate-session', acquired);
        await store.write('pending-login', { ...pending, phase: 'validating', keySource: undefined });
        return validate(pending, acquired, signal);
      }, { signal });
    },
  };
}
