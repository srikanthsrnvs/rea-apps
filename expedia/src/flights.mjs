import { createHash, randomUUID } from 'node:crypto';
import { buildFlightSearchRequest, buildFlightSelectionRequest, buildFlightDetailRequest, buildFlightFareSelectionRequest, normalizeFlightSearchResponse, normalizeFlightDetailResponse, normalizeFlightFareOptions } from './flights-protocol.mjs';
import { withClient } from './auth.mjs';
import { readState, saveState } from './state.mjs';
import { ExpediaError } from './errors.mjs';

// Bind opaque server selections to the identity that obtained them. Checkout's
// returned device ID can differ, so callers persist this owner separately.
export function recordOwner(context) {
  const identity = context?.identity;
  if (typeof identity?.duaid !== 'string' || !identity.duaid) throw new ExpediaError('SESSION_IDENTITY_REQUIRED', 'A current Expedia identity is required.');
  return createHash('sha256').update(JSON.stringify([
    identity.duaid, identity.authState ?? null,
    identity.tuid == null ? null : String(identity.tuid),
    identity.expUserId == null ? null : String(identity.expUserId),
  ])).digest('hex');
}
export function assertRecordOwner(record, context) {
  if (!record?.owner || record.owner !== recordOwner(context)) throw new ExpediaError('SELECTION_OWNER_CHANGED', 'This selection belongs to another or an older login session. Search and prepare it again.');
}

async function cacheSearch(payload, input, context, variables) {
  const result = normalizeFlightSearchResponse(payload);
  const searchId = randomUUID();
  const expiresAt = new Date(Date.now() + 20 * 60000).toISOString();
  const offers = [];
  for (const offer of result.offers) {
    const offerId = randomUUID();
    await saveState(`offer-${offerId}`, { searchId, offer, expiresAt, input, context, variables, owner: recordOwner(context) });
    offers.push({ offerId, summary: offer.accessibilityMessage,
      journeys: offer.journeys.map(j => ({ times: j.departureAndArrivalTime, locations: j.departureAndArrivalLocations, duration: j.durationAndStops, airlines: j.airlines?.map(a => a.text) })),
      pricing: offer.pricingInformation, priceDisplay: offer.priceDisplay,
      fares: publicFares(offer.fareOptions ?? []),
    });
  }
  await saveState(`search-${searchId}`, { input, context, result, variables, expiresAt, owner: recordOwner(context) });
  return { searchId, status: result.status, expiresAt, offers, hasMore: Boolean(result.paginationConfig), messages: result.offers.length ? { noListingMessaging: result.messages?.noListingMessaging } : result.messages };
}

async function record(name) {
  const value = await readState(name);
  if (!value) throw new ExpediaError('SELECTION_NOT_FOUND', 'This local flight selection was not found. Search again.');
  if (Date.parse(value.expiresAt) <= Date.now()) throw new ExpediaError('SELECTION_EXPIRED', 'This flight selection expired. Search again for current availability.');
  return value;
}
function publicDetail(value, actions) {
  if (Array.isArray(value)) return value.map(v => publicDetail(v, actions));
  if (!value || typeof value !== 'object') return value;
  if (/^(?:Flights?|Identity).*Action$/.test(value.__typename ?? '')) {
    const id = randomUUID(); actions[id] = value;
    return { actionId: id, type: value.__typename, label: value.accessibility ?? value.displayAction ?? null };
  }
  return Object.fromEntries(Object.entries(value).filter(([k]) => !/analytics|egcs|clientMetadata/i.test(k)).map(([k, v]) => [k, publicDetail(v, actions)]));
}
function publicFares(fares) { return fares.map(({ actions, ...fare }, fareIndex) => ({ ...fare, fareIndex })); }
async function cacheDetails(client, saved, context, selected, offerId) {
  const payload = await client.graphql({ ...selected, group: 'flights' });
  if (selected.kind === 'search') return cacheSearch(payload, saved.input, context, selected.variables);
  const detail = normalizeFlightDetailResponse(payload);
  const priceRequest = buildFlightDetailRequest({ context, flightsDetailCriteria: selected.variables.flightsDetailCriteria }, { variant: 'priceSummary' });
  const summary = await client.graphql({ ...priceRequest, group: 'flights' });
  const priceSummary = normalizeFlightDetailResponse(summary);
  const actions = {}, detailId = randomUUID();
  const output = { detailId, offerId, status: 'details', expiresAt: saved.expiresAt, fares: publicFares(normalizeFlightFareOptions(detail)), details: publicDetail(detail, actions), priceSummary: publicDetail(priceSummary, actions) };
  await saveState(`detail-${detailId}`, { ...saved, detailId, offerId, detail, priceSummary, actions, flightsDetailCriteria: selected.variables.flightsDetailCriteria });
  return output;
}

export async function searchFlights(input) {
  return withClient(async (client, context) => {
    const request = buildFlightSearchRequest({ ...input, context });
    const payload = await client.graphql({ ...request, group: 'flights' });
    return cacheSearch(payload, input, context, request.variables);
  });
}

export async function flightDetails({ offerId, fareIndex }) {
  return withClient(async (client, context) => {
    const saved = await record(`offer-${offerId}`);
    assertRecordOwner(saved, context);
    const selected = fareIndex !== undefined || saved.offer.fareOptions?.length && saved.variables.flightsSearchContext.tripType !== 'ONE_WAY'
      ? buildFlightFareSelectionRequest({ context, offer: saved.offer, fareIndex: fareIndex ?? 0, baseVariables: saved.variables })
      : (() => { const value = buildFlightSelectionRequest({ context, selection: saved.offer, baseVariables: saved.variables }); return { ...value.request, kind: value.kind }; })();
    return cacheDetails(client, saved, context, selected, offerId);
  });
}

export async function selectFare({ detailId, fareIndex }) {
  return withClient(async (client, context) => {
    const saved = await record(`detail-${detailId}`);
    assertRecordOwner(saved, context);
    const fares = normalizeFlightFareOptions(saved.detail);
    if (!Number.isSafeInteger(fareIndex) || fareIndex < 0 || fareIndex >= fares.length) throw new ExpediaError('INVALID_FARE', 'Choose a fareIndex from the returned details.');
    const selected = buildFlightFareSelectionRequest({ context, flightsDetailCriteria: saved.flightsDetailCriteria, fare: fares[fareIndex] });
    return cacheDetails(client, saved, context, selected, saved.offerId);
  });
}

export async function airportSearch({ query }) {
  return withClient(async (client, context) => {
    const url = new URL(`https://www.expedia.com/api/v4/typeahead/${encodeURIComponent(query)}`);
    for (const [k, v] of Object.entries({ client: 'expedia.app.android.phone', lob: 'flights', locale: context.locale, siteid: context.siteId, maxresults: 10, format: 'json' })) url.searchParams.set(k, String(v));
    const payload = await client.request(url);
    const { normalizeAirportSuggestions } = await import('./flights-protocol.mjs');
    return normalizeAirportSuggestions(payload);
  });
}
