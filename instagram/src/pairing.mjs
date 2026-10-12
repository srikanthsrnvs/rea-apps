import { constants, generateKeyPairSync, privateDecrypt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { InstagramError } from './errors.mjs';
import { InstagramClient, parseInstagramJson, readResponse } from './http.mjs';
import { sessionFromExport, sessionStatus } from './session.mjs';

const operations = {
  generate: ['useAirwaveGenerateLoginCodeMutation', '24426392696979234', 'airwave_login_generate_code'],
  listen: ['useAirwaveLoginListenValidationQuery', '30706232158975150', 'airwave_login_listen_validation'],
  exchange: ['useAirwaveLoginExchangeTokenQuery', '24248585958071086', 'airwave_login_exchange_token'],
};
const pollIntervalMs = 5000;
const webUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export class PairingClient {
  constructor(deviceId, { fetchImpl = fetch } = {}) {
    this.deviceId = deviceId;
    this.fetch = fetchImpl;
  }

  async query(operation, variables) {
    const [name, id, root] = operations[operation];
    let response;
    try {
      response = await this.fetch('https://i.instagram.com/graphql_www/', {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(25_000),
        headers: {
          'user-agent': 'InstagramAirwave 39.0.0.7.108 Android (32/12; 320dpi; 1920x1080; Google; Chromecast; sabrina; amlogic; en_US; 304000944)',
          'x-ig-app-id': '1281876400241826', 'x-instagram-app-id': '1281876400241826',
          'x-build-number': '304000944', 'x-ig-device-id': this.deviceId,
          'x-os-build-version': 'unknown', accept: '*/*',
          'content-type': 'application/x-www-form-urlencoded', 'x-fb-friendly-name': name,
        },
        body: new URLSearchParams({ doc_id: id, variables: JSON.stringify(variables), queryName: name }),
      });
    } catch { throw new InstagramError('NETWORK_ERROR', 'Instagram pairing could not be reached.'); }
    if (response.status === 429) {
      throw new InstagramError('RATE_LIMITED', 'Instagram asked this client to wait. No automatic retry was sent.');
    }
    if (!response.ok) throw new InstagramError('PAIRING_REJECTED', 'Instagram rejected the pairing request.', { httpStatus: response.status });
    let body;
    try { body = parseInstagramJson((await readResponse(response)).replace(/^for\s*\(;;\);/, '')); }
    catch (error) {
      if (error instanceof InstagramError) throw error;
      throw new InstagramError('INVALID_RESPONSE', 'Instagram returned an invalid pairing response.');
    }
    if (body?.error || body?.errors?.length || !body?.data?.[root]) {
      throw new InstagramError('PAIRING_REJECTED', 'Instagram did not return the expected pairing result. Run login --replace to start a fresh approval.');
    }
    return body.data[root];
  }
}

function invalidCredentials() {
  return new InstagramError('INVALID_RESPONSE', 'Instagram returned invalid or mismatched pairing credentials.');
}

function decodeBase64(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum || !value.length
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw invalidCredentials();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw invalidCredentials();
  return bytes;
}

export function sessionFromPairing(auth) {
  if (typeof auth?.access_token !== 'string' || !auth.access_token.startsWith('Bearer IGT:2:')
    || !/^\d+$/.test(String(auth.user_id ?? ''))) throw invalidCredentials();
  let payload;
  try { payload = parseInstagramJson(decodeBase64(auth.access_token.slice(13), 16384).toString('utf8')); }
  catch { throw invalidCredentials(); }
  if (!/^\d+$/.test(String(payload?.ds_user_id ?? ''))
    || String(payload.ds_user_id) !== String(auth.user_id)
    || typeof payload.sessionid !== 'string' || !payload.sessionid) throw invalidCredentials();
  const claim = auth.analytics_claim ?? '0';
  if (typeof claim !== 'string' || claim.length > 2048 || /[\r\n]/.test(claim)) throw invalidCredentials();
  let session;
  try {
    session = sessionFromExport({ userAgent: webUserAgent, cookies: ['ds_user_id', 'sessionid'].map(name => ({
      name, value: String(payload[name]), domain: '.instagram.com', path: '/', expires: -1,
      secure: true, httpOnly: name === 'sessionid',
    })) });
  } catch { throw invalidCredentials(); }
  return { ...session, wwwClaim: claim, acquiredBy: 'tv-pairing' };
}

function decryptNonce(ciphertext, key) {
  try {
    const bytes = decodeBase64(ciphertext, 344);
    if (bytes.length !== 256) throw invalidCredentials();
    const plaintext = privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, bytes);
    const value = plaintext.toString('utf8');
    if (!value.length || value.length > 1024 || !Buffer.from(value).equals(plaintext) || /[\x00-\x20\x7f]/.test(value)) throw invalidCredentials();
    return value;
  } catch { throw invalidCredentials(); }
}

export function pairingStatus(login, now = Date.now()) {
  if (!login || login.kind !== 'tv-pairing') return { status: 'not_started' };
  return {
    status: login.stage === 'acquired' ? 'validating' : login.expiresAt <= now ? 'expired' : login.stage === 'exchanging' ? 'exchange_uncertain' : 'pending',
    loginId: login.id, approvalUrl: login.approvalUrl,
    code: `${login.code.slice(0, 3)}-${login.code.slice(3, 6)}-${login.code.slice(6)}`,
    localDeadline: new Date(login.expiresAt).toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil(((login.nextPollAt ?? now + pollIntervalMs) - now) / 1000)),
    nextCommand: login.stage === 'exchanging' ? 'instagram login --replace' : 'instagram auth wait', browserRequiredOnHost: false,
    instructions: 'Open approvalUrl in your own browser. Sign in on Instagram, confirm the code, and click Continue until Instagram shows Success. If sign-in redirects to Home, reopen the same approvalUrl. Then run instagram auth wait on this host.',
  };
}

// The store's lock serializes exchanges and session replacement across processes.
// Delays happen outside the lock so reads, cancellation and other agents remain usable.
export function createPairingAuth({ store, clientFactory = id => new PairingClient(id),
  validate = async session => {
    const client = new InstagramClient(session);
    await client.me();
    return client.session;
  }, now = Date.now, sleep = delay } = {}) {
  async function start({ replace = false, timeoutSeconds = 600 } = {}) {
    return store.lock(async () => {
      const previous = await store.read('login');
      if (!replace && previous?.kind === 'tv-pairing'
        && (previous.stage === 'acquired' || previous.expiresAt > now())) return pairingStatus(previous, now());
      if (previous && !replace && previous.kind !== 'tv-pairing') {
        throw new InstagramError('LOGIN_IN_PROGRESS', 'Another login is active. Use login --replace to start pairing instead.');
      }
      if (previous?.kind === 'tv-pairing' && previous.stage !== 'acquired' && previous.expiresAt <= now()) await store.remove('login');
      const deviceId = randomUUID();
      const { publicKey, privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const generated = await clientFactory(deviceId).query('generate', { device_id: deviceId, public_key: publicKey });
      if (!/^[A-Za-z]{10}$/.test(generated.code ?? '')) throw invalidCredentials();
      const code = generated.code.toUpperCase();
      const approval = new URL('https://www.instagram.com/activate');
      approval.search = new URLSearchParams({ code: `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6)}`,
        flow: 'login', login_session_id: randomUUID(), source: 'qr' }).toString();
      const login = { version: 1, kind: 'tv-pairing', id: randomUUID(), stage: 'pending',
        deviceId, privateKey, code, approvalUrl: approval.href,
        expiresAt: now() + timeoutSeconds * 1000, nextPollAt: now() };
      await store.save('login', login);
      return pairingStatus(login, now());
    });
  }

  async function poll({ loginId } = {}) {
    return store.lock(async () => {
      let login = await store.read('login');
      if (!login) {
        const session = await store.read('session');
        if (session?.pairingLoginId && (!loginId || session.pairingLoginId === loginId)) return { status: 'authenticated', ...sessionStatus(session) };
        throw new InstagramError('LOGIN_REQUIRED', 'Run instagram login to get an approval link.');
      }
      if (login.kind !== 'tv-pairing' || loginId && login.id !== loginId) throw new InstagramError('LOGIN_CANCELLED', 'This pairing was replaced by another login.');
      if (login.stage !== 'acquired' && login.expiresAt <= now()) {
        await store.remove('login');
        throw new InstagramError('LOGIN_EXPIRED', 'The local approval deadline passed. Run instagram login again.');
      }
      if (login.stage === 'exchanging') throw new InstagramError('EXCHANGE_UNCERTAIN', 'The token exchange did not finish locally. Run instagram login --replace for a fresh approval; the existing session is unchanged.');
      if (login.stage === 'pending') {
        if (login.nextPollAt > now()) return pairingStatus(login, now());
        login.nextPollAt = now() + pollIntervalMs;
        await store.save('login', login);
        const client = clientFactory(login.deviceId);
        const result = await client.query('listen', { code: login.code });
        if (result.encrypted_first_nonce_code === null) return pairingStatus(login, now());
        const first = decryptNonce(result.encrypted_first_nonce_code, login.privateKey);
        const second = result.encrypted_second_nonce_code == null ? null : decryptNonce(result.encrypted_second_nonce_code, login.privateKey);
        // Never automatically replay a possibly consumed exchange after a crash or
        // lost response. Save credentials before validation for recoverable retries.
        login = { ...login, stage: 'exchanging' };
        delete login.privateKey;
        await store.save('login', login);
        const auth = await client.query('exchange', { first_nonce_code: first, second_nonce_code: second, registration_code: login.code });
        const session = sessionFromPairing(auth);
        login = { ...login, stage: 'acquired', session };
        await store.save('login', login);
      }
      if (login.stage !== 'acquired') throw invalidCredentials();
      const session = await validate(structuredClone(login.session));
      const expected = login.session.cookies.find(c => c.name === 'ds_user_id')?.value;
      if (session.account?.id !== expected || !session.account?.username) throw invalidCredentials();
      await store.save('session', { ...session, pairingLoginId: login.id });
      await store.remove('login');
      return { status: 'authenticated', ...sessionStatus(session), browserRequiredAtRuntime: false };
    });
  }

  async function wait({ timeoutSeconds = 600 } = {}) {
    const deadline = now() + timeoutSeconds * 1000;
    let loginId;
    for (;;) {
      const result = await poll({ loginId });
      if (result.status === 'authenticated') return result;
      loginId = result.loginId;
      const remaining = deadline - now();
      if (remaining <= 0) throw new InstagramError('LOGIN_TIMEOUT', 'Still waiting for Instagram approval. The request remains available until its local deadline; run auth wait again.');
      await sleep(Math.min(result.retryAfterSeconds * 1000, remaining));
    }
  }

  async function cancel() {
    return store.lock(async () => {
      await store.remove('login');
      return { status: 'cancelled', existingSessionPreserved: true };
    });
  }
  return { start, poll, wait, cancel };
}
