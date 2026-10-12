import { coordinate } from './protocol.mjs';

const text = value => typeof value === 'string' ? value : null;
const degree = (value, limit) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;

function summarizeLocation(location) {
  return {
    id: text(location.id), provider: text(location.provider), name: text(location.name),
    title: text(location.title), subtitle: text(location.subtitle), address: text(location.fullAddress),
    addressLine1: text(location.addressLine1), addressLine2: text(location.addressLine2),
    latitude: degree(location.coordinate?.latitude, 90),
    longitude: degree(location.coordinate?.longitude, 180),
  };
}

/** TextSearchRequest fields recovered from the native Gson adapter. */
export function searchRequest(query, near, context = 'DROPOFF') {
  if (typeof query !== 'string' || !query.trim()) throw new Error('Search query must be nonempty');
  if (!['PICKUP', 'DROPOFF'].includes(context)) throw new Error('Search context must be PICKUP or DROPOFF');
  return {
    coordinate: coordinate(near),
    query: query.trim(),
    context,
    userTappedSearchButton: true,
    useCase: 'DESTINATION_ONLY',
  };
}

/** Geolocation results are sidetable entries, rather than rendered UI bindings. */
export function normalizeSearch(rows) {
  if (!Array.isArray(rows)) throw new Error('Unrecognized search response: rows is missing; use --raw to inspect the response');
  const results = [];
  const seen = new Set();
  for (const [rowIndex, row] of rows.entries()) {
    if (!row?.sidetable || typeof row.sidetable !== 'object' || Array.isArray(row.sidetable)) continue;
    for (const [sidetableKey, metadata] of Object.entries(row.sidetable)) {
      const location = metadata?.geolocationResult?.location;
      if (!location || typeof location !== 'object' || Array.isArray(location)) continue;
      const id = text(location.id);
      const provider = text(location.provider);
      if (id && seen.has(JSON.stringify([provider, id]))) continue;
      if (id) seen.add(JSON.stringify([provider, id]));
      results.push({
        rowIndex,
        sidetableKey,
        ...summarizeLocation(location),
      });
    }
  }
  return {
    resultCount: results.length,
    results,
    warnings: results.some(result => result.latitude === null || result.longitude === null)
      ? ['Some search results carry only opaque location IDs. Coordinates require a separate location-resolution response.'] : [],
  };
}

/** Native fallback getPlace request; riderUUID=me belongs in the URL path. */
export function resolveRequest(id, provider, context = 'DROPOFF') {
  if (typeof id !== 'string' || !id.trim()) throw new Error('Location ID must be nonempty');
  if (typeof provider !== 'string' || !provider.trim()) throw new Error('Location provider must be nonempty');
  if (!['PICKUP', 'DROPOFF'].includes(context)) throw new Error('Resolve context must be PICKUP or DROPOFF');
  return {
    requestLocation: {
      locationSource: 'Search',
      anchorGeolocation: { location: { id, provider } },
      targetLocation: { latitude: 0, longitude: 0 },
    },
    context,
    requestNearbyLocations: true,
  };
}

/** Preserve the backend's anchor coordinates; never choose a pickup/dropoff access point implicitly. */
export function normalizeResolved(payload) {
  const body = payload?.body ?? payload;
  if (!body || (!Array.isArray(body.resultantLocations) && !Array.isArray(body.locationSuggestions))) {
    throw new Error('Unrecognized resolve response: resultantLocations or locationSuggestions is missing; use --raw to inspect the response');
  }
  const locations = [
    ...(Array.isArray(body.resultantLocations) ? body.resultantLocations.map(value => value?.anchorGeolocation?.location) : []),
    ...(Array.isArray(body.locationSuggestions) ? body.locationSuggestions.map(value => value?.location) : []),
  ];
  const results = [];
  const seen = new Set();
  for (const location of locations) {
    if (!location || typeof location !== 'object' || Array.isArray(location)) continue;
    const result = summarizeLocation(location);
    const key = JSON.stringify([result.provider, result.id, result.latitude, result.longitude]);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(result);
  }
  return {
    resultCount: results.length,
    results,
    warnings: !results.length || results.some(result => result.latitude === null || result.longitude === null)
      ? ['The response has no usable anchor coordinate for some results. Use --raw to inspect pickup/dropoff suggestions.'] : [],
  };
}
