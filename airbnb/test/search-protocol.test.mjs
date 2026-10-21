import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAutocomplete, buildStaysSearch, buildListingDetails, buildCalendar,
  normalizeAutocomplete, normalizeStaysSearch,
} from '../src/search-protocol.mjs';

const invalid = { code: 'INVALID_ARGUMENT' };
const params = request => Object.fromEntries(request.variables.staysSearchRequest.rawParams.map(item => [item.filterName, item.filterValues]));

test('autocomplete uses the Explore REST contract and leaves encoding to transport', () => {
  const request = buildAutocomplete({ query: 'Montréal & Québec', language: 'fr', country: 'ca', limit: 8 });
  assert.equal(request.path, 'autocompletes');
  assert.equal(request.query.user_input, 'Montréal & Québec');
  assert.equal(request.query.country, 'CA');
  assert.equal(request.query.num_results, 8);
  assert.equal(request.query.options, 'hide_nav_results|should_filter_by_vertical_refinement|simple_search');
  assert.equal(request.query.api_version, '1.0.7');
  assert.equal(request.query.cdn_cache, 1);
});

test('autocomplete preserves config tokens and supports bounds crossing the antimeridian', () => {
  const request = buildAutocomplete({
    query: 'Fiji', satoriConfigToken: 'opaque+/=', apiVersion: '2.0.0', region: '8', verticalRefinement: 'for_you',
    bounds: { neLat: -15, swLat: -20, swLng: 170, neLng: -170 },
  });
  assert.equal(request.query.satori_config_token, 'opaque+/=');
  assert.equal(request.query.api_version, '2.0.0');
  assert.equal(request.query.region, 8);
  assert.equal(request.query.sw_lng, 170);
  assert.equal(request.query.ne_lng, -170);
  assert.ok(!Object.hasOwn(request.query, 'vertical_refinement'));
});

test('stays search represents dates, guests, price and location as named string arrays', () => {
  const request = buildStaysSearch({
    query: 'Paris', placeId: 'ChIJD7fiBh9u5kcRYJSMaMOCCwQ',
    checkin: '2028-02-29', checkout: '2028-03-02', adults: '2', children: 1, pets: 1,
    minPrice: 50, maxPrice: '250.50', currency: 'eur', limit: 12,
    bounds: { ne_lat: 49, ne_lng: 3, sw_lat: 48, sw_lng: 2 },
  });
  assert.equal(request.operationName, 'StaysSearch');
  assert.equal(request.hash, '0f2b6b69de61b5db4ab063321b347ed68529f56eba0b8d847799bda2a57a45ef');
  const p = params(request);
  assert.deepEqual(p.query, ['Paris']);
  assert.deepEqual(p.checkin, ['2028-02-29']);
  assert.deepEqual(p.checkout, ['2028-03-02']);
  assert.deepEqual(p.adults, ['2']);
  assert.deepEqual(p.children, ['1']);
  assert.deepEqual(p.infants, ['0']);
  assert.deepEqual(p.pets, ['1']);
  assert.deepEqual(p.price_min, ['50']);
  assert.deepEqual(p.price_max, ['250.5']);
  assert.deepEqual(p.currency, ['EUR']);
  assert.deepEqual(p.itemsPerGrid, ['12']);
  assert.deepEqual(p.ne_lat, ['49']);
  assert.equal(request.variables.staysSearchRequest.searchType, 'SEARCH_QUERY');
});

test('cursor requests retain all search inputs and switch to native slim pagination', () => {
  const input = { query: 'Kyoto', checkin: '2027-04-05', checkout: '2027-04-08', adults: 3, filters: { amenities: ['4', '9'] } };
  const first = buildStaysSearch(input);
  const cursor = 'opaque+/= token';
  const next = buildStaysSearch({ ...input, cursor });
  assert.deepEqual(params(next), params(first));
  assert.equal(next.variables.staysSearchRequest.cursor, cursor);
  assert.equal(next.variables.slimPaginationRequest, true);
  assert.equal(next.variables.skipMapResults, true);
  assert.equal(next.variables.staysSearchRequest.maxMapItems, 0);
  assert.equal(first.variables.staysSearchRequest.cursor, null);
  assert.equal(first.variables.slimPaginationRequest, false);
  assert.equal(first.variables.skipMapResults, false);
});

test('returned autocomplete filters survive intact, with explicit CLI options taking precedence', () => {
  const rawParams = [
    { filterName: 'query', filterValues: ['Original'] },
    { filterName: 'place_id', filterValues: ['server-place'] },
    { filterName: 'adults', filterValues: ['4'] },
    { filterName: 'refinement_paths', filterValues: ['/homes'] },
    { filterName: 'server_supplied_filter', filterValues: ['opaque:A', 'B'] },
  ];
  const snapshot = structuredClone(rawParams);
  const request = buildStaysSearch({ rawParams, query: 'Override', children: 2 });
  const p = params(request);
  assert.deepEqual(p.query, ['Override']);
  assert.deepEqual(p.place_id, ['server-place']);
  assert.deepEqual(p.adults, ['4']);
  assert.deepEqual(p.children, ['2']);
  assert.deepEqual(p.server_supplied_filter, ['opaque:A', 'B']);
  assert.deepEqual(request.variables.staysSearchRequest.refinementPaths, ['/homes']);
  assert.deepEqual(rawParams, snapshot);
  assert.equal(new Set(request.variables.staysSearchRequest.rawParams.map(x => x.filterName)).size, request.variables.staysSearchRequest.rawParams.length);
});

test('listing details preserves large IDs and both native booking-input formats', () => {
  const id = '12345678901234567890';
  const request = buildListingDetails({ listingId: id, checkin: '2027-01-01', checkout: '2027-01-05', adults: 2, children: 1, infants: 1, pets: 2 });
  assert.equal(request.operationName, 'StaysPdpSectionsQuery');
  assert.equal(Buffer.from(request.variables.id, 'base64').toString(), `StayListing:${id}`);
  assert.equal(Buffer.from(request.variables.demandStayListingId, 'base64').toString(), `DemandStayListing:${id}`);
  assert.equal(request.variables.checkIn, '2027-01-01');
  assert.equal(request.variables.checkInDate, '2027-01-01');
  assert.deepEqual(request.variables.dateRange, { startDate: '2027-01-01', endDate: '2027-01-05' });
  assert.deepEqual(request.variables.guestCounts, { numberOfAdults: 2, numberOfChildren: 1, numberOfInfants: 1, numberOfPets: 2 });
  assert.equal(request.variables.includeEntityBookItBarSectionQuery, true);
});

test('listing details without dates does not fabricate dates and copies section selectors', () => {
  const sectionIds = ['BOOK_IT_SIDEBAR', 'AVAILABILITY_CALENDAR'];
  const request = buildListingDetails({ listingId: 123, sectionIds, includeBookItBar: false });
  assert.ok(!Object.hasOwn(request.variables, 'checkIn'));
  assert.ok(!Object.hasOwn(request.variables, 'dateRange'));
  assert.deepEqual(request.variables.sectionIds, sectionIds);
  request.variables.sectionIds.push('MORE');
  assert.equal(sectionIds.length, 2);
  assert.equal(request.variables.includeEntityBookItBarSectionQuery, false);
});

test('availability calendar uses DemandStayListing and a calendar month rather than an offset', () => {
  const request = buildCalendar({ listingId: 123, month: '12', year: '2027', count: '3' });
  assert.equal(request.operationName, 'PdpAvailabilityCalendarQuery');
  assert.equal(request.hash, 'e00c2132fc81efb79b6eae87065836360bd03b1051a0cc2c7621ce4d9358023b');
  assert.equal(Buffer.from(request.variables.listingId, 'base64').toString(), 'DemandStayListing:123');
  assert.deepEqual(request.variables.input, { month: 12, year: 2027, count: 3, returnPropertyLevelCalendarIfApplicable: false });
});

test('rejects impossible dates, partial ranges and reversed ranges before transport', () => {
  for (const dates of [
    { checkin: '2027-02-29', checkout: '2027-03-01' },
    { checkin: '2027-04-31', checkout: '2027-05-02' },
    { checkin: '2027-01-01' },
    { checkin: '2027-01-05', checkout: '2027-01-01' },
    { checkin: '2027-01-01', checkout: '2027-01-01' },
    { checkin: '2027-1-01', checkout: '2027-01-05' },
  ]) {
    assert.throws(() => buildStaysSearch(dates), invalid);
    assert.throws(() => buildListingDetails({ listingId: 1, ...dates }), invalid);
  }
});

test('rejects invalid guest counts, IDs, bounds, prices, cursor and calendar input', () => {
  for (const options of [{ adults: 0 }, { children: -1 }, { infants: 0.5 }, { pets: true }, { cursor: '' },
    { minPrice: -1 }, { minPrice: 50, maxPrice: 20 }, { maxPrice: Infinity },
    { bounds: { neLat: 91, neLng: 1, swLat: 0, swLng: 0 } },
    { bounds: { neLat: 10, neLng: 1, swLat: 20, swLng: 0 } },
    { bounds: { neLat: 10 } }, { rawParams: [{ filterName: 'query', filterValues: null }] },
  ]) assert.throws(() => buildStaysSearch(options), invalid);
  for (const listingId of [0, -1, Number.MAX_SAFE_INTEGER + 1, '123abc', 'https://www.airbnb.com/rooms/123', '', null]) assert.throws(() => buildListingDetails({ listingId }), invalid);
  for (const options of [{ month: 0, year: 2027 }, { month: 13, year: 2027 }, { month: 1 }, { month: 1, year: 2027, count: 0 }]) assert.throws(() => buildCalendar({ listingId: 1, ...options }), invalid);
  assert.throws(() => buildAutocomplete({ query: 'x', limit: 0 }), invalid);
  assert.throws(() => buildAutocomplete({ query: 'x', country: 'Canada' }), invalid);
  assert.throws(() => buildAutocomplete({ query: '\n' }), invalid);
});

// Constructed fixtures follow shipped DTO topology; no live Airbnb data is used.
test('search response retains union results, metadata, raw payload and opaque cursors', () => {
  const card = { __typename: 'SearchResult', listing: { id: '1' }, undiscoveredField: { a: 1 } };
  const payload = { data: { presentation: { staysSearch: { results: {
    searchResults: [card], paginationInfo: { nextPageCursor: 'next+/=', previousPageCursor: 'previous' },
    loggingMetadata: { serverData: 'keep' }, unknownResultField: 'keep',
  }, mapResults: { extra: true } } } }, extensions: { trace: 'keep' } };
  const result = normalizeStaysSearch(payload);
  assert.equal(result.raw, payload);
  assert.equal(result.items[0], card);
  assert.equal(result.result.unknownResultField, 'keep');
  assert.equal(result.nextCursor, 'next+/=');
  assert.equal(result.previousCursor, 'previous');
});

test('an empty result page can still continue, while an absent cursor is not invented', () => {
  const results = { searchResults: [], paginationInfo: { nextPageCursor: 'continue' } };
  assert.equal(normalizeStaysSearch({ data: { presentation: { staysSearch: { results } } } }).nextCursor, 'continue');
  assert.equal(normalizeStaysSearch({ presentation: { staysSearch: { results: { searchResults: [] } } } }).nextCursor, null);
});

test('autocomplete retains the full suggestion and response instead of discarding selection filters', () => {
  const term = { display_name: 'Paris', explore_search_params: { params: [{ key: 'query', value: 'Paris' }] }, arbitrary: true };
  const payload = { autocomplete_terms: [term], metadata: { config: 'keep' }, unknown: 'keep' };
  const result = normalizeAutocomplete(payload);
  assert.equal(result.raw, payload);
  assert.equal(result.items[0], term);
  assert.deepEqual(result.metadata, { config: 'keep' });
});

test('unexpected and error responses fail with raw evidence, even when partial data exists', () => {
  for (const payload of [{}, { data: {} }, { data: { presentation: { staysSearch: { results: { searchResults: null } } } } }]) {
    assert.throws(() => normalizeStaysSearch(payload), error => error.code === 'UNSUPPORTED_RESPONSE' && error.raw === payload);
  }
  const partial = { errors: [{ message: 'Auth required' }], data: { presentation: { staysSearch: { results: { searchResults: [] } } } } };
  assert.throws(() => normalizeStaysSearch(partial), error => error.code === 'GRAPHQL_ERROR' && error.raw === partial);
  assert.throws(() => normalizeAutocomplete({ errorCode: 403, autocomplete_terms: [] }), { code: 'API_ERROR' });
  assert.throws(() => normalizeAutocomplete({}), { code: 'UNSUPPORTED_RESPONSE' });
});
