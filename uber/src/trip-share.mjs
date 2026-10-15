import { authenticatedRequest } from './client.mjs';
import { requireUUID } from './plans.mjs';
import { readState } from './state.mjs';
const resolvedTokens = new Map();

// Android ShareApi.shareTrip GET annotation and ShareTripResponse writer.
// This retrieves a link; it does not send it to contacts or change safety contacts.
export async function getTripShareLink(tripId, { send = authenticatedRequest } = {}) {
  requireUUID(tripId, 'Trip ID');
  const response = await send(`/rt/trips/${tripId}/share-yo-ride?shareTripType=RIDER_SHARE`, {}, { method: 'GET', readOnly: true });
  let url;
  try { url = new URL(response.shareUrl); } catch { throw new Error('Uber did not return a valid trip-sharing link'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || (url.hostname !== 'uber.com' && !url.hostname.endsWith('.uber.com'))) {
    throw new Error('Uber returned an unexpected trip-sharing host');
  }
  return { tripId, shareUrl: url.href, source: 'native_trip_share', iframeSupportVerified: false,
    warning: 'Anyone with this link may see trip details. Native Android map parity and iframe support are unverified.' };
}


export async function fetchSharedTrip(tripId, { send = authenticatedRequest, fetcher = fetch, readOwner = async () => (await readState('session'))?.userUUID } = {}) {
  requireUUID(tripId, 'Trip ID');
  const owner = await readOwner();
  const cacheKey = owner ? `${owner}:${tripId}` : null;
  let cached = cacheKey ? resolvedTokens.get(cacheKey) : null;
  if (cached?.until <= Date.now()) cached = null;
  let token = cached?.token;
  if (!token) {
    const link = await getTripShareLink(tripId, { send });
    let url = new URL(link.shareUrl);
    for (let redirects = 0; redirects < 5; redirects++) {
      token = url.searchParams.get('share_token');
      if (token) break;
      const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), referrerPolicy: 'no-referrer' });
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
      const next = new URL(location, url);
      if (next.protocol !== 'https:' || next.username || next.password || next.port || !next.hostname.endsWith('.uber.com')) throw new Error('Unexpected Uber sharing redirect');
      url = next;
    }
    if (!token || token.length > 4096) throw new Error('Uber sharing link did not resolve to a tracking token');
    if (cacheKey) {
      if (resolvedTokens.size >= 16) resolvedTokens.delete(resolvedTokens.keys().next().value);
      resolvedTokens.set(cacheKey, { token, until: Date.now() + 60000 });
    }
  }
  // ShareClient.a -> ks3.i.apply wraps the native FetchRequest under request.
  return send('/rt/sharetrip/fetch', { request: { shareToken: token, usePolylines: true } }, { readOnly: true });
}
