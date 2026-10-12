import test from 'node:test';
import assert from 'node:assert/strict';
import { searchRequest, normalizeSearch, resolveRequest, normalizeResolved } from '../src/locations.mjs';

test('search wraps the grounded request and validates coordinates and context', () => {
  assert.deepEqual(searchRequest('  Example station  ', '10,20'), {
    coordinate: { latitude: 10, longitude: 20 }, query: 'Example station', context: 'DROPOFF',
    userTappedSearchButton: true, useCase: 'DESTINATION_ONLY',
  });
  assert.equal(searchRequest('Station', '10,20', 'PICKUP').context, 'PICKUP');
  assert.throws(() => searchRequest('', '10,20'), /nonempty/);
  assert.throws(() => searchRequest('Station', '91,20'), /range/);
  assert.throws(() => searchRequest('Station', '10,20', 'UNKNOWN'), /context/);
});

test('resolve uses the native fallback anchor and path-free request', () => {
  assert.deepEqual(resolveRequest('place-one', 'example-provider'), {
    requestLocation: { locationSource: 'Search', anchorGeolocation: { location: { id: 'place-one', provider: 'example-provider' } }, targetLocation: { latitude: 0, longitude: 0 } },
    context: 'DROPOFF', requestNearbyLocations: true,
  });
  assert.throws(() => resolveRequest('', 'example-provider'), /ID/);
  assert.throws(() => resolveRequest('place-one', ''), /provider/);
  assert.throws(() => resolveRequest('place-one', 'example-provider', 'UNKNOWN'), /context/);
});

test('resolved anchors preserve numeric coordinates and leave access points for raw inspection', () => {
  const location = { id: 'place-one', provider: 'example-provider', name: 'Example Station', coordinate: { latitude: 10, longitude: 20 } };
  const summary = normalizeResolved({ resultantLocations: [
    { anchorGeolocation: { location }, dropoffs: [{ coordinate: { latitude: 11, longitude: 21 } }] },
  ], locationSuggestions: [{ location }] });
  assert.equal(summary.resultCount, 1);
  assert.equal(summary.results[0].latitude, 10);
  assert.equal(summary.results[0].longitude, 20);
  assert.deepEqual(summary.warnings, []);
  assert.throws(() => normalizeResolved({}), /Unrecognized/);
  assert.equal(normalizeResolved({ locationSuggestions: [{ location: { coordinate: { latitude: 91, longitude: '20' } } }] }).results[0].latitude, null);
  assert.equal(normalizeSearch([{ sidetable: { tap: { geolocationResult: { location } } } }]).results[0].latitude, 10);
});

test('normalization uses every geolocation sidetable, preserves identifiers, and skips UI actions', () => {
  const metadata = { geolocationResult: { location: {
    id: 'place-one', provider: 'example-provider', name: 'Example Station', title: 'Station',
    subtitle: 'Example City', fullAddress: '1 Example Road', addressLine1: '1 Example Road', addressLine2: 'Example City',
  } } };
  const normalized = normalizeSearch([
    { sidetable: { arbitraryTap: metadata, openMap: { action: 'OPEN_MAP' } } },
    { sidetable: { repeated: metadata, anotherProvider: { geolocationResult: { location: { id: 'place-one', provider: 'other' } } } } },
    null, {}, { sidetable: [] },
  ]);
  const results = normalized.results;
  assert.equal(normalized.resultCount, 2);
  assert.deepEqual(results[0], {
    rowIndex: 0, sidetableKey: 'arbitraryTap', id: 'place-one', provider: 'example-provider',
    name: 'Example Station', title: 'Station', subtitle: 'Example City', address: '1 Example Road',
    addressLine1: '1 Example Road', addressLine2: 'Example City', latitude: null, longitude: null,
  });
  assert.equal(results[1].provider, 'other');
  assert.equal(results[1].address, null);
  assert.deepEqual(normalizeSearch([]), { resultCount: 0, results: [], warnings: [] });
  assert.throws(() => normalizeSearch({}), /rows/);
});
