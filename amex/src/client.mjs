import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { request, requireSuccess } from './http.mjs';
import { readState, saveState, withStateLock, stateDirectory } from './state.mjs';
import { AmexError } from './errors.mjs';

const processId = randomUUID();
let processSequence = 0;
const headerName = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const safe = value => typeof value === 'string' && value.length <= 65_536 && !/[\x00-\x1f\x7f]/u.test(value);
export function clientHeaders({ device, session, sequence = 0, now = new Date() } = {}) {
  const headers = {
    'accept': 'application/json', 'content-type': 'application/json',
    'user-agent': `rea-amex/0.1 (${os.type()}; ${os.arch()}; Node.js ${process.versions.node}; protocol 7.34.1)`,
    'x-axp-app-id': 'com.americanexpress.android.acctsvcs.us', 'x-axp-app-market': 'us',
    'x-axp-app-name': 'AMEX', 'x-axp-app-version': '7.34.1',
    // The server selects its protocol by x-axp-os. Anonymous initialization
    // rejects Linux and accepts the shipped Android selector. Host metadata and
    // User-Agent remain truthful; this does not assert device integrity.
    'x-axp-os': 'Android', 'x-axp-os-version': os.release(),
    'x-axp-device-model': `${os.type()}/${os.machine()}`, 'x-axp-manufacturer': 'UNAVAILABLE',
    'x-axp-device-code-name': os.machine(),
    'x-axp-device-id': device.deviceId, 'x-axp-instance-id': device.instanceId,
    'x-axp-locales': 'x-axp-locales: en-US',
    'x-axp-device-time': now.toISOString(),
    'x-axp-device-timezone-name': Intl.DateTimeFormat().resolvedOptions().timeZone,
    'x-axp-timezoneoffset': String(-now.getTimezoneOffset() * 60_000),
    'x-axp-request-id': randomUUID(), 'x-axp-process-id': processId,
    'x-axp-request-sequence': String(sequence), 'x-axp-public-guid': session?.publicGuid || 'UNAVAILABLE',
  };
  if (session?.jsonWebToken?.rawToken) headers.authorization = `AMAT ${session.jsonWebToken.rawToken}`;
  if (session?.gateKeeperCookie) headers['x-axp-gatekeeper'] = session.gateKeeperCookie;
  if (session?.cupcake) headers['x-axp-blueboxvalues'] = session.cupcake;
  for (const entry of session?.additionalHeaders ?? []) {
    const name = entry?.header?.toLowerCase(), value = entry?.value;
    if (!safe(name) || !headerName.test(name) || !safe(value) || ['host', 'content-length', 'connection', 'transfer-encoding'].includes(name)) {
      throw new AmexError('UNSUPPORTED_SESSION_HEADER', 'Amex returned a session header this client cannot safely use.');
    }
    headers[name] = value;
  }
  for (const value of Object.values(headers)) if (!safe(value)) throw new AmexError('INVALID_SESSION', 'The saved client or session metadata is invalid.');
  return headers;
}

async function nextProfile() {
  return withStateLock(async () => {
    let device = await readState('device');
    if (!device) {
      device = { version: 1, deviceId: randomBytes(8).toString('hex'), instanceId: randomUUID() };
      await saveState('device', device);
    }
    if (typeof device.deviceId !== 'string' || !device.deviceId || typeof device.instanceId !== 'string' || !device.instanceId) throw new AmexError('INVALID_CLIENT_STATE', 'The saved installation metadata is invalid.');
    return { device, sequence: processSequence++ };
  }, { directory: path.join(stateDirectory, '.request-mutex') });
}

export async function createClient({ session, anonymous = false, fetchImpl } = {}) {
  const explicit = session !== undefined;
  session = anonymous ? null : session ?? await readState('session');
  if (!anonymous && (!session?.jsonWebToken?.rawToken || !explicit && (session.validated !== true || !session.ownerId || !Number.isFinite(Date.parse(session.validatedAt))))) {
    throw new AmexError('AUTH_REQUIRED', 'Sign in to Amex before accessing the account.');
  }
  async function response(spec) {
    const profile = await nextProfile();
    return request(spec, { headers: clientHeaders({ ...profile, session }), fetchImpl });
  }
  return { response, async request(spec) { return requireSuccess(await response(spec)); } };
}
