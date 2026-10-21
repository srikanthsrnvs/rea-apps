import path from 'node:path';
import { readState, saveState, withStateLock, stateDirectory } from './state.mjs';

// These are opaque values issued by Airbnb's API, not locally generated proofs.
const HEADER_FIELDS = {
  'x-airbnb-aaj': 'aaj',
  'x-airbnb-set-native-session-id': 'nativeSessionId',
};
function value(headers, name) {
  const result = typeof headers?.get === 'function' ? headers.get(name)
    : headers?.[Object.keys(headers ?? {}).find(key => key.toLowerCase() === name)];
  if (typeof result !== 'string' || result.length > 65_536 || /[\x00-\x1f\x7f]/.test(result)) return undefined;
  return result;
}
export async function captureResponseContext(response) {
  const updates = {};
  for (const [header, field] of Object.entries(HEADER_FIELDS)) {
    const incoming = value(response.headers, header);
    if (incoming !== undefined && (field !== 'nativeSessionId' || incoming.trim())) updates[field] = incoming;
  }
  if (Object.keys(updates).length === 0) return;
  if (updates.nativeSessionId !== undefined) updates.nativeSessionAcquiredAt = Date.now();
  if (updates.aaj !== undefined) updates.aajAcquiredAt = Date.now();
  await updateRequestContext(updates);
}
export async function updateRequestContext(updates) {
  await withStateLock(async () => {
    await saveState('request-context', { ...await readState('request-context'), ...updates });
  }, { directory: path.join(stateDirectory, '.context-mutex') });
}
export async function readRequestContext() {
  let result = await readState('request-context') ?? {};
  // Native header-provider's default lifetime; this is not access-token expiry.
  if (result.nativeSessionAcquiredAt && Date.now() - result.nativeSessionAcquiredAt >= 63_115_200_000) {
    const { nativeSessionId: _, nativeSessionAcquiredAt: __, ...rest } = result;
    result = rest;
  }
  if (!Number.isSafeInteger(result.everestExpiresAt) || result.everestExpiresAt < Math.floor(Date.now() / 1000)) {
    const { everestDeviceId: _, everestExpiresAt: __, ...rest } = result;
    result = rest;
  }
  return result;
}
