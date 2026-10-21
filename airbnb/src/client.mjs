import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { request, requireSuccess } from './http.mjs';
import { readState, saveState } from './state.mjs';
import { AirbnbError } from './errors.mjs';
import { captureResponseContext, readRequestContext } from './request-context.mjs';
import { ensureDeviceContext } from './bootstrap.mjs';

export async function getDevice() {
  let device = await readState('device');
  if (!device) { device = { id: randomUUID() }; await saveState('device', device); }
  return device;
}
export function clientHeaders({ device, session, context = {} } = {}) {
  const aaj = (session?.aajAcquiredAt ?? 0) > (context.aajAcquiredAt ?? 0) ? session?.aaj : context.aaj ?? session?.aaj;
  return {
    'user-agent': `rea-airbnb/0.1 (${os.platform()}; ${os.arch()}; Node.js ${process.versions.node})`,
    'accept-language': 'en', 'x-airbnb-country': 'US',
    'x-airbnb-supports-airlock-v2': 'true',
    'x-airbnb-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(device?.id ? { 'x-airbnb-device-id': device.id } : {}),
    ...(session?.token ? { 'x-airbnb-oauth-token': session.token } : {}),
    ...(aaj ? { 'x-airbnb-aaj': aaj } : {}),
    ...(context.nativeSessionId || session?.nativeSessionId ? { 'x-airbnb-native-session-id': context.nativeSessionId || session?.nativeSessionId } : {}),
    ...(context.everestDeviceId ? { 'x-airbnb-everest-device-id': context.everestDeviceId } : {}),
  };
}
export async function createClient({ session, anonymous = false, optionalAuth = false, fetchImpl } = {}) {
  session ??= anonymous ? null : await readState('session');
  if (!anonymous && !optionalAuth && !session?.token) throw new AirbnbError('AUTH_REQUIRED', 'Sign in with airbnb login --phone +COUNTRYCODE_NUMBER --country US, or --email ADDRESS.');
  const device = await getDevice();
  await ensureDeviceContext({ headers: clientHeaders({ device, session, context: await readRequestContext() }), fetchImpl });
  async function prepare(spec) {
    return { ...spec, headers: { ...clientHeaders({ device, session, context: await readRequestContext() }), ...spec.headers } };
  }
  async function response(spec) {
    await ensureDeviceContext({ headers: clientHeaders({ device, session, context: await readRequestContext() }), fetchImpl });
    const headers = clientHeaders({ device, session, context: await readRequestContext() });
    const result = await request(spec, { headers, fetchImpl });
    await captureResponseContext(result);
    return result;
  }
  return {
    prepare,
    response,
    async request(spec) { return requireSuccess(await response(spec)); },
  };
}
