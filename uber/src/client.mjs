import { setTimeout as delay } from 'node:timers/promises';
import { requestHeaders, extractOAuth, withExpiry } from './protocol.mjs';
import { readState, saveState, stateDirectory, withStateLock } from './state.mjs';

export class UberError extends Error {
  constructor(message, { status, code, endpoint } = {}) {
    super(message);
    this.name = 'UberError';
    Object.assign(this, {status, code, endpoint});
  }
}

export async function request(config, endpoint, body, token, { retry = false, integrityToken, callUuid, method='POST', extraHeaders={} } = {}) {
  if (!['GET','POST'].includes(method)) throw new Error('Unsupported HTTP method');
  const attempts = retry ? 3 : 1;
  const headers = {...requestHeaders(config, token),...extraHeaders};
  if (integrityToken) headers['x-uber-cit'] = integrityToken;
  if (callUuid) headers['x-uber-call-uuid'] = callUuid;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response, raw;
    try {
      let target = new URL(endpoint, config.apiHost);
      for (let redirects = 0; ; redirects++) {
        response = await fetch(target, {
          method, headers, ...(method==='GET' ? {} : {body:JSON.stringify(body)}),
          signal: AbortSignal.timeout(30000), redirect: 'manual',
        });
        if (![307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects >= 3) throw new Error('Invalid or excessive API redirects');
        const next = new URL(location, target);
        if (next.protocol !== 'https:' || next.username || next.password || next.port ||
            !/^cn-[a-z0-9-]+(?:\.cfe)?\.uber\.com$/.test(next.hostname) ||
            next.pathname.replace(/\/$/, '') !== target.pathname.replace(/\/$/, '') || next.search !== target.search) {
          throw new Error('Refusing to send credentials to an unexpected redirect target');
        }
        target = next;
      }
      raw = await response.text();
    } catch (error) {
      if (!['TypeError', 'TimeoutError', 'AbortError'].includes(error.name)) throw error;
      if (attempt + 1 < attempts) { await delay(250 * 2 ** attempt); continue; }
      throw new UberError(`Network request failed: ${error.cause?.code ?? error.name}`, { code: 'network_error', endpoint });
    }
    const contentType = response.headers.get('content-type') ?? '';
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = { raw }; }
    const record = { endpoint, status: response.status, contentType, headers: Object.fromEntries(response.headers), receivedAt: new Date().toISOString(), body: payload };
    await saveState('last-response', record);
    if (endpoint.includes('silk-screen')) await saveState('last-login-response', record);
    if (endpoint.includes('oauth2/token')) await saveState('last-refresh-response', record);
    if (retry && [502, 503, 504].includes(response.status) && attempt + 1 < attempts) { await delay(250 * 2 ** attempt); continue; }
    if (!response.ok) {
      if (response.status === 401 && response.headers.get('www-authenticate')?.trim().toLowerCase() === 'uber-cit-sig') {
        throw new UberError('Uber requires a current client integrity credential for this endpoint', {
          status: response.status, code: 'integrity_required', endpoint,
        });
      }
      const fieldErrors = endpoint.includes('silk-screen') && Array.isArray(payload.screenErrors)
        ? payload.screenErrors.flatMap(screen => Object.values(screen.errors ?? {}).map(error => error?.errorType)) : [];
      const code = payload.code ?? fieldErrors.find(value => ['SMS_OTP_INCORRECT', 'EMAIL_OTP_INCORRECT', 'FRAUD_LOGIN_DENIED'].includes(value));
      throw new UberError(`Uber returned HTTP ${response.status}${code ? ` (${code})` : ''}; response saved privately in ${stateDirectory}/last-response.json`, {
        status: response.status, code, endpoint,
      });
    }
    if (!contentType.includes('json')) throw new UberError(`Unsupported response Content-Type ${contentType}`, { code:'unexpected_response', endpoint });
    return payload;
  }
}

async function refreshUnlocked(session) {
  if (!session?.refreshToken || !session?.context) throw new Error('No refreshable session; run uber login');
  if (session.refreshExpiresAt && session.refreshExpiresAt <= Date.now()) throw new Error('Refresh token expired; run uber login');
  const response = await request(session.context, '/rt/identity/oauth2/token', {request: {
    clientID: session.context.firstPartyClientID, refreshToken: session.refreshToken, grantType: 'REFRESH_TOKEN',
  }});
  const oauth = extractOAuth(response);
  if (!oauth) throw new Error('Refresh response contains no recognized access token');
  const next = withExpiry({ ...session, ...oauth });
  await saveState('session', next);
  return next;
}

export async function refresh() {
  return withStateLock(async () => refreshUnlocked(await readState('session')));
}

async function integrity(session, force = false) {
  const existing = await readState('integrity');
  if (!force && existing?.contextDeviceId === session.context.deviceId && existing?.expiresAt > Date.now() + 15000) return existing;
  const response = await request(session.context, '/rt/devices/exemption', {
    request: { token: '', exemptToken: existing?.contextDeviceId === session.context.deviceId ? existing.token : '' },
  }, session.accessToken);
  if (typeof response.token !== 'string' || !response.token || !Number.isSafeInteger(response.metadata?.expiry)) {
    throw new UberError('Uber did not issue an integrity exemption; this account or client may not be eligible', {code:'exemption_unavailable'});
  }
  const next = { token: response.token, expiresAt: response.metadata.expiry * 1000, contextDeviceId:session.context.deviceId };
  if (next.expiresAt <= Date.now() + 5000) throw new UberError('Uber issued an already expired integrity credential', {code:'exemption_expired'});
  await saveState('integrity', next);
  return next;
}

// Keep token refresh, journal writes and a mutation in one local transaction.
// Mutations never retry: a network failure can occur after Uber accepted a ride.
export async function authenticatedOperation(operation) {
  return withStateLock(async () => {
    let session = await readState('session');
    if (!session?.accessToken || !session?.context) throw new Error('Login is required; run uber login');
    if (session.expiresAt && session.expiresAt <= Date.now() + 60000) session = await refreshUnlocked(session);
    const send = async (endpoint, body, { readOnly = true, callUuid,method='POST',extraHeaders } = {}) => {
      let credential = await integrity(session);
      try {
        return await request(session.context, endpoint, body, session.accessToken, { retry: readOnly, integrityToken: credential.token, callUuid,method,extraHeaders });
      } catch (error) {
        if (!readOnly || error.code !== 'integrity_required') throw error;
        credential = await integrity(session, true);
        return request(session.context, endpoint, body, session.accessToken, { retry:true, integrityToken:credential.token, callUuid,method,extraHeaders });
      }
    };
    return operation({session, send});
  });
}

export async function authenticatedRequest(endpoint, body, options) {
  return authenticatedOperation(({send}) => send(endpoint, body, options));
}

// A stream must release the account lock before its long-lived network read.
// The caller separately guards this generation before accepting each message.
export async function authenticatedStreamContext() {
  return authenticatedOperation(async ({session}) => {
    if (!session.userUUID || !session.mapViewerGeneration) throw new Error('Initialize the map session guard before streaming');
    const credential = await integrity(session);
    return { owner: `${session.userUUID}:${session.mapViewerGeneration}`,
      headers: { ...requestHeaders(session.context, session.accessToken), 'x-uber-cit': credential.token } };
  });
}
