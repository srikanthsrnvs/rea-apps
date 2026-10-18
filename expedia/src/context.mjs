import { randomUUID } from 'node:crypto';

// Recovered from BexApiContextInputProviderImpl and ServicesUtil in Android 2026.41.0.
export const APP_VERSION = '2026.41.0';
export function createContext({ duaid = randomUUID(), profile = null } = {}) {
  return {
    clientInfo: { name: 'android.com.expedia.bookings', version: APP_VERSION },
    currency: 'USD', device: { type: 'APP_PHONE' },
    identity: { authState: profile ? 'AUTHENTICATED' : 'ANONYMOUS', duaid,
      expUserId: profile?.expUserId == null ? null : String(profile.expUserId), tuid: String(profile?.tuid ?? '-1') },
    locale: 'en_US', siteId: 1, tpid: 1,
  };
}
export function clientHeaders({ sessionOrigin } = {}) {
  const origin = sessionOrigin?.kind === 'android_runtime' ? sessionOrigin : null;
  const platform = origin ? 'ANDROID' : 'CLI';
  const osVersion = origin?.osVersion ?? process.platform;
  const manufacturer = origin?.manufacturer ?? 'REA';
  const model = origin?.model ?? process.arch;
  return {
    'accept': 'application/json',
    'content-type': 'application/json',
    'user-agent': `ExpediaBookings/${APP_VERSION} (compatible; rea-expedia-cli/0.1; Node/${process.versions.node}; ${process.platform}; ${process.arch})`,
    'client-info': `android.com.expedia.bookings,${APP_VERSION},external`,
    // The optional Android fields describe the genuine session's origin. The
    // user agent always identifies this Node CLI and its executing platform.
    'x-eb-client': `PLATFORM:${platform};OS_VERSION:${osVersion};MANUFACTURER:${manufacturer};MODEL:${model};MODEL_NAME:${origin?.model ?? 'Expedia CLI'};UPGRADE:false;APP_VERSION:${APP_VERSION};LOCALE:en_US;APP_IDENTIFIER:com.expedia.bookings;`,
  };
}
