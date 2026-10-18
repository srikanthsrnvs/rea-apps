import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildFlightSearchVariables, buildFlightSearchRequest, normalizeFlightSearchResponse, normalizeFlightDetailResponse, normalizeAirportSuggestions, FLIGHT_OPERATIONS } from '../src/flights-protocol.mjs';
const base = () => ({ context: { siteId: 1, locale: 'en_US' }, origin: 'lax', destination: 'jfk', departDate: '2026-11-04' });
const loaded = listings => ({ data: { flightsSearch: { listingResult: { __typename: 'FlightsLoadedListingResult', listings } } } });
test('one way preserves typed search fields and isolates caller input', () => {
  const input = { ...base(), adults: 2, children: [5, 12], infantsInLap: 1, cabin: 'PREMIUM_ECONOMY', sortType: 'PRICE', pagination: { size: 20, startingIndex: 40 } };
  const v = buildFlightSearchVariables(input);
  assert.deepEqual(v.journeyCriteria, [{ origin: 'LAX', destination: 'JFK', departureDate: { day: 4, month: 11, year: 2026 } }]);
  assert.deepEqual(v.travelerDetails, [{ count: 2, travelerType: 'ADULT' }, { count: 2, ages: [5, 12], travelerType: 'CHILD' }, { count: 1, travelerType: 'INFANT_IN_LAP' }]);
  assert.equal(v.flightsSearchContext.tripType, 'ONE_WAY');
  assert.deepEqual(v.sortOption, { sortType: 'PRICE', sortOrder: 'INCREASING' });
  assert.deepEqual(v.searchPagination, { size: 20, startingIndex: 40 });
  v.context.siteId = 3; assert.equal(input.context.siteId, 1);
});
test('round trip uses separate reciprocal journey date inputs', () => {
  const v = buildFlightSearchVariables({ ...base(), returnDate: '2026-11-08' });
  assert.equal(v.flightsSearchContext.tripType, 'ROUND_TRIP');
  assert.deepEqual(v.journeyCriteria[1], { origin: 'JFK', destination: 'LAX', departureDate: { day: 8, month: 11, year: 2026 } });
});
test('multi city retains resolved metro and airport types and server context', () => {
  const continuation = { journeysContinuationId: 'opaque-server-token', previousFlightSelections: [{ journeyIndex: 0, offerIdentifier: 'opaque-offer' }] };
  const v = buildFlightSearchVariables({ context: base().context, flightsSearchContext: continuation, legs: [{ origin: { code: 'LON', locationType: 'METROCODE', regionId: '178279' }, destination: 'CDG', departDate: '2026-11-01' }, { origin: 'CDG', destination: 'FCO', departDate: '2026-11-04' }] });
  assert.equal(v.journeyCriteria[0].originAirportLocationType, 'METROCODE');
  assert.equal(v.journeyCriteria[0].originRegionId, '178279');
  assert.deepEqual(v.flightsSearchContext.previousFlightSelections, continuation.previousFlightSelections);
  assert.equal(v.flightsSearchContext.tripType, 'MULTI_DESTINATION');
});
test('invalid calendar dates, reverse dates, traveler and selection mistakes fail locally', () => {
  for (const input of [
    { ...base(), departDate: '2026-02-30' },
    { ...base(), returnDate: '2026-11-01' },
    { ...base(), adults: 0 },
    { ...base(), infantsInLap: 2 },
    { ...base(), children: [19] },
    { ...base(), cabin: 'ECONOMY' },
    { ...base(), origin: 'Los Angeles' },
    { ...base(), destination: 'LAX' },
    { ...base(), pagination: { size: 0, startingIndex: 0 } },
    { ...base(), sortOrder: 'INCREASING' },
    { ...base(), tripType: 'MULTI_DESTINATION' },
  ]) assert.throws(() => buildFlightSearchVariables(input), error => error.code === 'INVALID_ARGUMENT');
});
test('loading and loaded requests use exact app operations and variable scopes', () => {
  const r = buildFlightSearchRequest(base());
  assert.equal(r.operationName, 'androidFlightsResultsFlightsSearch');
  assert.equal(r.extensions.persistedQuery.sha256Hash, FLIGHT_OPERATIONS.search.sha256Hash);
  assert.equal(r.variables.skipFareSidesheetData, true);
  const loading = buildFlightSearchRequest(base(), { loading: true });
  assert.equal(loading.variables.queryState, 'LOADING');
  assert.equal(loading.variables.includeCarryOverFilter, undefined);
  assert.equal(loading.variables.skipFareSidesheetData, undefined);
});
test('published exact query document hashes agree with all provenance entries', async () => {
  const directory = new URL('../src/graphql/flights/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  for (const doc of manifest.documents) {
    const bytes = await readFile(new URL(doc.file, directory));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), doc.sha256, doc.operationName);
  }
  for (const op of Object.values(FLIGHT_OPERATIONS)) assert.equal(manifest.documents.find(doc => doc.operationName === op.operationName).sha256, op.sha256Hash);
});
test('flight results preserve opaque server selections and fare actions without invention', () => {
  const action = { type: 'DETAILS', flightsDetailCriteria: { journeyContinuationId: 'opaque-detail' }, journeySearchCriteria: { flightsSearchContext: { journeysContinuationId: 'opaque-next' } } };
  const response = loaded([{ __typename: 'FlightsStandardOffer', offerIdentifier: 'offer-xyz', journeyContinuationId: 'jcid', journeys: [{ departureAndArrivalLocations: 'LAX - JFK', detailsAndFares: { footer: { action: { clientAction: { __typename: 'FlightsNavigateToDetails', jcid: 'fare-jcid' } } } } }], pricingInformation: { mainPrice: { completeText: '$123' } }, selectOfferAction: action }]);
  const r = normalizeFlightSearchResponse(response);
  assert.equal(r.status, 'ready'); assert.equal(r.offers[0].offerIdentifier, 'offer-xyz');
  assert.deepEqual(r.offers[0].selectOfferAction, action);
  assert.equal(r.offers[0].journeys[0].detailsAndFares.footer.action.clientAction.jcid, 'fare-jcid');
  r.offers[0].selectOfferAction.type = 'changed'; assert.equal(response.data.flightsSearch.listingResult.listings[0].selectOfferAction.type, 'DETAILS');
});
test('pagination and loading status are retained; no final offers invented', () => {
  const r = normalizeFlightSearchResponse({ data: { flightsSearch: { listingResult: { __typename: 'FlightsLoadingListingResult', paginationConfig: { faresSeparationType: 'ONLY_BASE', pagination: { size: 50, startingIndex: 0 } }, detailsConfig: { paginationInfo: { size: 10, startingIndex: 0 } } } } } });
  assert.equal(r.status, 'loading'); assert.deepEqual(r.offers, []);
  assert.equal(r.paginationConfig.pagination.size, 50);
});
test('unrecognized, malformed, and GraphQL-error responses do not pass as empty results', () => {
  for (const value of [{}, { data: { flightsSearch: {} } }, loaded([{ __typename: 'NewFlightOfferShape', secretToken: 'x' }]), loaded([{}]), { data: { flightsSearch: { listingResult: { __typename: 'FlightsLoadedListingResult' } } } }]) assert.throws(() => normalizeFlightSearchResponse(value), error => error.code === 'UNSUPPORTED_RESPONSE');
  assert.throws(() => normalizeFlightSearchResponse({ errors: [{ message: 'Denied', extensions: { code: 'UNAUTHENTICATED' } }] }), error => error.code === 'GRAPHQL_ERROR');
});
test('explicit no results differs from an unsupported payload', () => {
  const r = normalizeFlightSearchResponse({ data: { flightsSearch: { listingResult: null, noListingMessaging: { header: 'No flights found' } } } });
  assert.equal(r.status, 'no_results');
});
test('fare details remain structured and airport identities retain source fields', () => {
  const detail = { footer: { clientAction: { resource: { value: '/checkout?opaque=server' } } }, priceSummary: { value: '$123' } };
  assert.deepEqual(normalizeFlightDetailResponse({ data: { flightsDetail: detail } }), detail);
  assert.throws(() => normalizeFlightDetailResponse({ data: {} }), error => error.code === 'UNSUPPORTED_RESPONSE');
  const r = normalizeAirportSuggestions({ query: 'lax', suggestions: [{ gaiaId: 'LAX', type: 'airport', hierarchyInfo: { airport: { airportCode: 'LAX', metrocode: 'QLA' } }, regionNames: { fullName: 'Los Angeles (LAX)' }, analytics: 'discard' }] });
  assert.equal(r.suggestions[0].hierarchyInfo.airport.airportCode, 'LAX'); assert.equal(r.suggestions[0].analytics, undefined);
});

test('detail requests use opaque server criteria and exact variant scope', async () => {
  const { buildFlightDetailRequest } = await import('../src/flights-protocol.mjs');
  const input = { context: base().context, selection: { type: 'GO_TO_DETAILS', flightsDetailCriteria: { __typename: 'FlightsDetailCriteria', journeyContinuationId: 'server-jcid', originalBookingId: null } }, shoppingContext: { multiItem: { id: 'opaque-shopping' } } };
  const detail = buildFlightDetailRequest(input);
  assert.equal(detail.operationName, 'androidFlightsRateDetailFlightsDetailLoaded');
  assert.deepEqual(detail.variables.flightsDetailCriteria, { journeyContinuationId: 'server-jcid', originalBookingId: null });
  assert.equal(detail.variables.queryState, 'LOADED'); assert.equal(detail.variables.shoppingContext, undefined);
  const price = buildFlightDetailRequest(input, { variant: 'priceSummary' });
  assert.deepEqual(Object.keys(price.variables).sort(), ['context', 'flightsDetailCriteria']);
  assert.equal(price.operationName, 'FlightsDetailPriceSummary');
  assert.throws(() => buildFlightDetailRequest({ context: base().context, flightsDetailCriteria: { offerIdentifier: 'not-a-jcid' } }), error => error.code === 'INVALID_ARGUMENT');
});
test('server next-leg search action moves previous selection inputs and clears old page', async () => {
  const { buildFlightSelectionRequest } = await import('../src/flights-protocol.mjs');
  const action = { type: 'GO_TO_SEARCH', journeySearchCriteria: { __typename: 'FlightsJourneySearchCriteria', journeyCriteria: [{ departureDate: { day: 8, month: 11, year: 2026 }, origin: 'JFK', destination: 'LAX' }], flightsSearchContext: { tripType: 'ROUND_TRIP', journeysContinuationId: 'next-leg-jcid' }, previousFlightSelections: [{ journeyIndex: 0, offerIdentifier: 'opaque-first-flight' }], travelerDetails: [{ count: 1, travelerType: 'ADULT' }], searchPreferences: { cabinClass: 'COACH' } } };
  const r = buildFlightSelectionRequest({ context: base().context, selection: action, baseVariables: { searchPagination: { size: 25, startingIndex: 75 }, sortOption: { sortType: 'PRICE', sortOrder: 'INCREASING' } } });
  assert.equal(r.kind, 'search');
  assert.equal(r.request.variables.searchPagination, undefined);
  assert.deepEqual(r.request.variables.flightsSearchContext.previousFlightSelections, [{ journeyIndex: 0, offerIdentifier: 'opaque-first-flight' }]);
  assert.equal(r.request.variables.journeyCriteria[0].origin, 'JFK');
  assert.equal(r.request.variables.sortOption.sortType, 'PRICE');
  assert.equal(r.request.variables.__typename, undefined);
  assert.throws(() => buildFlightSelectionRequest({ context: base().context, selection: { type: 'GO_TO_SEARCH', journeySearchCriteria: { flightsSearchContext: { journeysContinuationId: 'incomplete' } } } }), error => error.code === 'INVALID_ARGUMENT');
});
test('selection dispatcher accepts server action only and never infers checkout execution', async () => {
  const { buildFlightSelectionRequest } = await import('../src/flights-protocol.mjs');
  const r = buildFlightSelectionRequest({ context: base().context, selection: { selectOfferAction: { type: 'GO_TO_DETAILS', flightsDetailCriteria: { journeyContinuationId: 'native-token' } } } });
  assert.equal(r.kind, 'detail'); assert.equal(r.request.variables.flightsDetailCriteria.journeyContinuationId, 'native-token');
  assert.throws(() => buildFlightSelectionRequest({ context: base().context, selection: { type: 'BOOK', flightsDetailCriteria: { journeyContinuationId: 'native-token' } } }), error => error.code === 'UNSUPPORTED_ACTION');
});

test('airport normalizer recognizes native q/rid/rc/sr wire aliases and metro identities', () => {
  const r = normalizeAirportSuggestions({ q: 'Los Angeles', rid: 'public-fixture-request', rc: 'OK', sr: [{ '@type': 'gaiaRegionResult', index: '0', gaiaId: '6138913', type: 'METROCODE', regionNames: { fullName: 'Los Angeles, CA, United States of America (QLA-All Airports)' }, coordinates: { lat: '33.92240850678621', long: '-117.99158214508483' }, hierarchyInfo: { country: { isoCode2: 'US' }, airport: { airportCode: 'QLA', airportId: '6138913', metrocode: 'QLA', multicity: '178280' } } }] });
  assert.equal(r.query, 'Los Angeles'); assert.equal(r.requestId, 'public-fixture-request'); assert.equal(r.returnCode, 'OK');
  assert.equal(r.suggestions[0].type, 'METROCODE'); assert.equal(r.suggestions[0]['@type'], 'gaiaRegionResult');
  assert.equal(r.suggestions[0].hierarchyInfo.airport.airportCode, 'QLA'); assert.equal(r.suggestions[0].coordinates.long, '-117.99158214508483');
});

test('fare choices preserve price, amenities, action state and opaque selection values', async () => {
  const { normalizeFlightFareOptions } = await import('../src/flights-protocol.mjs');
  const payload = { data: { flightsDetail: { flightsSelectedJourneyDetails: [{ fareDetails: { fareSummary: { detailsAndFares: { flightsDetailsAndFares: { sections: [{ __typename: 'FlightsFaresInformation', fares: [{ state: 'UNSELECTED', associatedLeg: 0, heading: { farePricing: [{ priceLockup: { lockupPrice: '$161' } }] }, fareDetails: [{ heading: 'Economy' }], amenities: [{ text: 'Carry-on included' }], action: [{ states: ['UNSELECTED'], action: { primary: 'Select', disabled: false, clientAction: { __typename: 'FlightsSelectionAction', value: 'opaque-upsell', analyticsList: ['excluded'] } } }] }] }] } } } } }] } } };
  const fares = normalizeFlightFareOptions(payload);
  assert.equal(fares.length, 1); assert.equal(fares[0].associatedLeg, 0);
  assert.equal(fares[0].actions[0].clientAction.value, 'opaque-upsell');
  assert.equal(fares[0].actions[0].clientAction.analyticsList, undefined);
  assert.equal(fares[0].actions[0].button.disabled, false);
  assert.equal(fares[0].heading.farePricing[0].priceLockup.lockupPrice, '$161');
  assert.throws(() => normalizeFlightFareOptions({ data: { flightsDetail: {} } }), error => error.code === 'UNSUPPORTED_RESPONSE');
});

test('fare selection sends native opaque value as upsellOfferToken while preserving base criteria', async () => {
  const { buildFlightFareSelectionRequest } = await import('../src/flights-protocol.mjs');
  const criteria = { journeyContinuationId: 'server-jcid', originalBookingId: null, lastSelectedOfferTokensInformation: { tokens: ['preserved'] } };
  const fare = { state: 'UNSELECTED', actions: [{ states: ['SELECTED'], button: { disabled: true }, clientAction: { __typename: 'FlightsSelectionAction', value: 'wrong-state' } }, { states: ['UNSELECTED'], button: { disabled: false }, clientAction: { __typename: 'FlightsSelectionAction', value: 'native-upsell-token' } }] };
  const r = buildFlightFareSelectionRequest({ context: base().context, flightsDetailCriteria: criteria, fare });
  assert.equal(r.operationName, 'androidFlightsRateDetailFlightsDetailLoaded');
  assert.deepEqual(r.variables.flightsDetailCriteria, { ...criteria, upsellOfferToken: 'native-upsell-token' });
  assert.equal(criteria.upsellOfferToken, undefined);
  assert.throws(() => buildFlightFareSelectionRequest({ context: base().context, flightsDetailCriteria: criteria, fare: { state: 'SELECTED', actions: [{ button: { disabled: true }, clientAction: { __typename: 'FlightsSelectionAction', value: 'already-selected' } }] } }), error => error.code === 'FARE_ALREADY_SELECTED');
  assert.throws(() => buildFlightFareSelectionRequest({ context: base().context, flightsDetailCriteria: criteria, selectionAction: { __typename: 'FlightsBoundNavigation', value: 'not-same-contract' } }), error => error.code === 'INVALID_ARGUMENT');
});

test('roundtrip native fare navigation loads return offers then final two-leg details', async () => {
  const { buildFlightFareSelectionRequest } = await import('../src/flights-protocol.mjs');
  const baseVariables = buildFlightSearchVariables({ ...base(), returnDate: '2026-11-08', pagination: { size: 25, startingIndex: 50 } });
  assert.equal(baseVariables.skipFareSidesheetData, false);
  const rawOffer = clientAction => ({ __typename: 'FlightsStandardOffer', journeys: [{ departureAndArrivalLocations: 'LAX - JFK', detailsAndFares: { flightsDetailsAndFares: { sections: [{ __typename: 'FlightsFaresInformation', fares: [{ state: 'UNSELECTED', associatedLeg: 0, heading: { farePricing: [{ priceLockup: { lockupPrice: '$204' } }] }, action: [{ states: ['UNSELECTED'], action: { primary: 'Select', disabled: false, clientAction } }] }] }] } } }] });
  const outbound = normalizeFlightSearchResponse(loaded([rawOffer({ __typename: 'FlightsBoundNavigation', flightsBoundNavigationJcid: 'server-next-bound', mipt: null })])).offers[0];
  assert.equal(outbound.fareOptions.length, 1);
  const next = buildFlightFareSelectionRequest({ context: base().context, offer: outbound, fareIndex: 0, baseVariables });
  assert.equal(next.kind, 'search');
  assert.equal(next.variables.flightsSearchContext.journeysContinuationId, 'server-next-bound');
  assert.deepEqual(next.variables.journeyCriteria, baseVariables.journeyCriteria);
  assert.equal(next.variables.searchPagination, undefined);
  assert.equal(baseVariables.flightsSearchContext.journeysContinuationId, undefined);
  const returning = normalizeFlightSearchResponse(loaded([rawOffer({ __typename: 'FlightsNavigateToDetails', jcid: 'server-final-roundtrip', obid: null })])).offers[0];
  const final = buildFlightFareSelectionRequest({ context: base().context, offer: returning, fareIndex: 0, baseVariables: next.variables });
  assert.equal(final.kind, 'detail');
  assert.equal(final.variables.flightsDetailCriteria.journeyContinuationId, 'server-final-roundtrip');
  assert.equal(final.operationName, 'androidFlightsRateDetailFlightsDetailLoaded');
});
test('native fare actions reject packages and missing preloaded choices explicitly', async () => {
  const { buildFlightFareSelectionRequest } = await import('../src/flights-protocol.mjs');
  assert.throws(() => buildFlightFareSelectionRequest({ context: base().context, offer: { fareOptions: [] }, fareIndex: 0 }), error => error.code === 'FARE_UNAVAILABLE');
  assert.throws(() => buildFlightFareSelectionRequest({ context: base().context, baseVariables: buildFlightSearchVariables(base()), selectionAction: { __typename: 'FlightsBoundNavigation', jcid: 'opaque-bound', mipt: 'package-price-token' } }), error => error.code === 'UNSUPPORTED_ACTION');
});
