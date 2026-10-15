import { createHash, randomBytes, randomUUID } from 'node:crypto';

// Defaults recovered from Uber Android 4.651.10003 and verified with this
// account. Backend eligibility and future protocol compatibility may vary.
export const defaults = Object.freeze({
  authHost: 'https://auth.uber.com/v2',
  callback: 'https://auth.uber.com/v2/applogin/helix',
  apiHost: 'https://cn-geo1.uber.com',
  clientName: 'client',
  clientVersion: '4.651.10003',
  clientId: 'com.ubercab',
  firstPartyClientID: 'zozycDbnl17oSjKXdw_x_QuNvq5wfRHq',
  appID: 'RIDER',
});

export function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function createContext(overrides = {}) {
  return {
    ...defaults,
    deviceId: randomUUID(),
    appDeviceId: randomUUID(),
    clientSession: randomUUID(),
    ...overrides,
  };
}

export function createLogin(context, callback) {
  const redirect = new URL(callback);
  if (redirect.protocol === 'http:') {
    throw new Error(
      'Uber does not allow the localhost HTTP callback. Use its native HTTPS callback and paste the completed URL into uber auth complete.',
    );
  }
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL(context.authHost);
  const query = {
    showDebugInfo: 'false',
    'x-uber-device': 'android',
    'x-uber-client-name': context.clientName.toLowerCase(),
    'x-uber-client-version': context.clientVersion,
    'x-uber-client-id': context.clientId,
    firstPartyClientID: context.firstPartyClientID,
    isEmbedded: 'true',
    codeChallenge: pkceChallenge(verifier),
    app_url: callback,
    asms: 'false',
    'x-uber-device-udid': context.deviceId,
    sim_mcc: '',
    sim_mnc: '',
    'x-uber-app-device-id': context.appDeviceId,
    'x-uber-cold-launch-id': randomUUID(),
  };
  for (const [name, value] of Object.entries(query))
    url.searchParams.set(name, value);
  return {
    url: url.href,
    callback,
    verifier,
    context: { ...context },
    createdAt: new Date().toISOString(),
  };
}

export function parseCallback(value, expectedCallback) {
  const url = new URL(value);
  const expected = new URL(expectedCallback);
  if (
    url.protocol !== expected.protocol ||
    url.host !== expected.host ||
    url.pathname !== expected.pathname ||
    url.username ||
    url.password
  ) {
    throw new Error('Callback does not match the pending login');
  }
  const session = url.searchParams.get('session');
  if (!session) throw new Error('Callback has no session parameter');
  return { session, authCode: url.searchParams.get('authCode') ?? session };
}

export function sessionExchange(context, pending, callback, deviceData = {}) {
  return {
    formContainerAnswer: {
      inAuthSessionID: callback.session,
      formAnswer: {
        flowType: 'SIGN_IN',
        screenAnswers: [
          {
            screenType: 'SESSION_VERIFICATION',
            eventType: 'TypeVerifySession',
            fieldAnswers: [
              {
                fieldType: 'SESSION_VERIFICATION_CODE',
                sessionVerificationCode: callback.authCode,
              },
              { fieldType: 'CODE_VERIFIER', codeVerifier: pending.verifier },
            ],
          },
        ],
        deviceData: JSON.stringify(deviceData),
        firstPartyClientID: context.firstPartyClientID,
        standardFlow: true,
        appID: context.appID,
      },
    },
  };
}

export function requestHeaders(context, token) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-uber-call-uuid': randomUUID(),
    'x-uber-device': 'android',
    'x-uber-client-name': context.clientName,
    'x-uber-client-version': context.clientVersion,
    'x-uber-client-id': context.clientId,
    'x-uber-device-id': context.deviceId,
    'x-uber-app-device-id': context.appDeviceId,
    'x-uber-session-enabled': 'TRUE',
    'x-uber-request-uuid': randomUUID(),
    'x-uber-device-epoch': String(Date.now()),
  };
  if (context.clientSession)
    headers['x-uber-client-session'] = context.clientSession;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

export function extractOAuth(body, depth = 0) {
  if (!body || typeof body !== 'object' || depth > 5) return null;
  if (typeof body.accessToken === 'string' && body.accessToken) return body;
  for (const key of ['oAuthInfo', 'response', 'data', 'result']) {
    const found = extractOAuth(body[key], depth + 1);
    if (found) return found;
  }
  return null;
}

export function extractLoginSession(body, depth = 0) {
  if (!body || typeof body !== 'object' || depth > 5) return null;
  const oauth =
    body.oAuthInfo ?? (typeof body.accessToken === 'string' ? body : null);
  if (oauth?.accessToken) {
    return {
      ...oauth,
      ...Object.fromEntries(
        ['apiToken', 'userUUID', 'authSessionID', 'inAuthSessionID']
          .filter((key) => typeof body[key] === 'string')
          .map((key) => [key, body[key]]),
      ),
    };
  }
  for (const key of ['response', 'data', 'result']) {
    const found = extractLoginSession(body[key], depth + 1);
    if (found) return found;
  }
  return null;
}

export function coordinate(value) {
  if (typeof value !== 'string')
    throw new Error('Coordinates are required as latitude,longitude');
  const parts = value.split(',');
  if (parts.length !== 2 || parts.some((part) => !part.trim()))
    throw new Error('Coordinates must be latitude,longitude');
  const [latitude, longitude] = parts.map(Number);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    throw new Error('Coordinates are outside the latitude/longitude range');
  }
  return { latitude, longitude };
}

export function shoppingRequest(from, to, via = []) {
  const waypoint = (point, taskType) => ({
    taskTypes: [taskType],
    locationSpec: { provider: 'unset', point, backwardsCompatibleInfo: {} },
  });
  return {
    orderSelectionExperience: 'RIDES',
    pickupWaypoint: waypoint(coordinate(from), 'PICKUP'),
    waypointSpecs: [
      ...via.map((point) => waypoint(coordinate(point), 'VIA')),
      waypoint(coordinate(to), 'DROP_OFF'),
    ],
  };
}

export function decodeLong(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Number.isInteger(value.high) ||
    !Number.isInteger(value.low)
  ) {
    throw new Error('Expected a high/low duration object');
  }
  const bits = (BigInt(value.high >>> 0) << 32n) | BigInt(value.low >>> 0);
  return value.unsigned ? bits : BigInt.asIntN(64, bits);
}

export function withExpiry(oauth, now = Date.now()) {
  const expiry = (value) => {
    if (value === undefined || value === null) return null;
    const seconds = decodeLong(value);
    if (seconds <= 0n) return null;
    const milliseconds = BigInt(now) + seconds * 1000n;
    if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('Token expiry exceeds the supported timestamp range');
    return Number(milliseconds);
  };
  return {
    ...oauth,
    receivedAt: new Date(now).toISOString(),
    expiresAt: expiry(oauth.expiresIn),
    refreshExpiresAt: expiry(oauth.refreshTokenExpiresIn),
  };
}
