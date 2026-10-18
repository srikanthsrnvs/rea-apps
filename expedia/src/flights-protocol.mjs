import { ExpediaError } from './errors.mjs';

// Names and persisted-document hashes are grounded in the shipped Android queries.
export const FLIGHT_OPERATIONS = Object.freeze({
  search: { operationName: 'androidFlightsResultsFlightsSearch', sha256Hash: 'bcc38aa12dc7969fdbd4e853b21c6a8ae999bb63d30919ec59b691373c8665fa' },
  loading: { operationName: 'androidFlightsSearchResultsLoading', sha256Hash: '0e7e4e47a67008e54cf666d743a1ba42d9baef94b4d115cbe7192d50ea72a9e9' },
  listings: { operationName: 'FlightListingsLoaded', sha256Hash: 'c1b50f00553818328bdef2a157ef96c23f24210f46e7dd14103afb951fdb586f' },
  listingsLoading: { operationName: 'FlightListingsLoading', sha256Hash: '1c6ab85801b55e7e7ff3c6303cc15be91bd809b54a4061cba01b34fd8d571d86' },
});
const CABINS = new Set(['ANY', 'COACH', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST']);
const TRIPS = new Set(['ONE_WAY', 'ROUND_TRIP', 'MULTI_DESTINATION']);
const SORTS = new Set(['ARRIVAL', 'BEST_BETS', 'BEST_SORT', 'CROSS_SORT', 'DEPARTURE', 'DURATION', 'NONSTOP', 'PRICE', 'RECOMMENDED']);
const ORDERS = new Set(['DECREASING', 'INCREASING']);
const LOCATION_TYPES = new Set(['AIRPORT', 'METROCODE', 'UNSPECIFIED']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => value === undefined ? undefined : structuredClone(value);
const invalid = message => { throw new ExpediaError('INVALID_ARGUMENT', message); };
function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} must be an integer between ${min} and ${max}.`);
  return value;
}
function date(value, label) {
  if (object(value)) {
    const y = integer(value.year, `${label}.year`, 1900, 2200);
    const m = integer(value.month, `${label}.month`, 1, 12);
    const d = integer(value.day, `${label}.day`, 1, 31);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) invalid(`${label} is not a valid date.`);
    return { day: d, month: m, year: y };
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(`${label} must use YYYY-MM-DD.`);
  const [year, month, day] = value.split('-').map(Number);
  return date({ year, month, day }, label);
}
function dateNumber(value) { return Date.UTC(value.year, value.month - 1, value.day); }
function location(value, label) {
  if (typeof value === 'string') {
    if (!/^[A-Za-z]{3}$/.test(value)) invalid(`${label} must be a three-letter airport or metro code.`);
    return { code: value.toUpperCase(), locationType: undefined };
  }
  if (!object(value)) invalid(`${label} must be an airport code or a location object.`);
  const code = location(value.code ?? value.airportCode, label).code;
  if (value.locationType !== undefined && !LOCATION_TYPES.has(value.locationType)) invalid(`${label}.locationType is invalid.`);
  return { code, locationType: value.locationType, regionId: value.regionId };
}
function journey(input, index) {
  if (!object(input)) invalid(`Flight leg ${index + 1} is missing.`);
  const origin = location(input.origin, `leg ${index + 1} origin`);
  const destination = location(input.destination, `leg ${index + 1} destination`);
  if (origin.code === destination.code) invalid(`Flight leg ${index + 1} must have different origin and destination.`);
  const result = { departureDate: date(input.departDate ?? input.departureDate, `leg ${index + 1} departure`), destination: destination.code, origin: origin.code };
  for (const [prefix, value] of [['origin', origin], ['destination', destination]]) {
    if (value.locationType !== undefined) result[`${prefix}AirportLocationType`] = value.locationType;
    if (value.regionId !== undefined) result[`${prefix}RegionId`] = String(value.regionId);
  }
  return result;
}
function pagination(input) {
  if (!object(input)) invalid('pagination must contain size and startingIndex.');
  return { size: integer(input.size, 'pagination.size', 1, 1000), startingIndex: integer(input.startingIndex, 'pagination.startingIndex', 0, 1000000) };
}

export function buildFlightSearchVariables(input = {}) {
  if (!object(input.context)) invalid('A caller-supplied Expedia context is required.');
  let tripType = input.tripType ?? (input.legs ? 'MULTI_DESTINATION' : input.returnDate ? 'ROUND_TRIP' : 'ONE_WAY');
  if (!TRIPS.has(tripType)) invalid('tripType must be ONE_WAY, ROUND_TRIP, or MULTI_DESTINATION.');
  let legs;
  if (input.legs !== undefined) {
    if (!Array.isArray(input.legs) || input.legs.length < 1 || input.legs.length > 6) invalid('legs must contain between one and six flight legs.');
    legs = input.legs.map(journey);
  } else {
    legs = [journey(input, 0)];
    if (tripType === 'ROUND_TRIP') legs.push(journey({ origin: input.destination, destination: input.origin, departDate: input.returnDate }, 1));
    else if (tripType === 'MULTI_DESTINATION') invalid('MULTI_DESTINATION requires explicit legs.');
  }
  if (tripType === 'ONE_WAY' && legs.length !== 1) invalid('ONE_WAY requires exactly one flight leg.');
  if (tripType === 'ROUND_TRIP' && (legs.length !== 2 || legs[0].origin !== legs[1].destination || legs[0].destination !== legs[1].origin)) invalid('ROUND_TRIP requires two reciprocal flight legs.');
  if (tripType === 'MULTI_DESTINATION' && legs.length < 2) invalid('MULTI_DESTINATION requires at least two flight legs.');
  for (let i = 1; i < legs.length; i++) if (dateNumber(legs[i].departureDate) < dateNumber(legs[i - 1].departureDate)) invalid('Flight legs must be in departure date order.');
  const adults = integer(input.adults ?? 1, 'adults', 1, 9);
  const children = input.children ?? [];
  if (!Array.isArray(children)) invalid('children must be an array of ages.');
  children.forEach(age => integer(age, 'child age', 2, 17));
  const lap = integer(input.infantsInLap ?? 0, 'infantsInLap', 0, 9);
  const seated = integer(input.infantsInSeat ?? 0, 'infantsInSeat', 0, 9);
  if (lap > adults) invalid('Each infant in lap requires an adult.');
  if (adults + children.length + lap + seated > 9) invalid('Searches support at most nine travelers.');
  const cabin = input.cabin ?? 'COACH';
  if (!CABINS.has(cabin)) invalid('cabin must be ANY, COACH, PREMIUM_ECONOMY, BUSINESS, or FIRST.');
  const travelerDetails = [{ count: adults, travelerType: 'ADULT' }];
  if (children.length) travelerDetails.push({ ages: [...children], count: children.length, travelerType: 'CHILD' });
  if (lap) travelerDetails.push({ count: lap, travelerType: 'INFANT_IN_LAP' });
  if (seated) travelerDetails.push({ count: seated, travelerType: 'INFANT_IN_SEAT' });
  const result = {
    context: clone(input.context), journeyCriteria: legs, travelerDetails,
    flightsSearchContext: { ...clone(input.flightsSearchContext ?? {}), tripType },
    searchPreferences: { ...clone(input.searchPreferences ?? {}), cabinClass: cabin },
    queryState: input.queryState ?? 'LOADED',
    includeCarryOverFilter: input.includeCarryOverFilter ?? false,
    hideDetailsExpando: input.hideDetailsExpando ?? false,
    skipFareSidesheetData: input.skipFareSidesheetData ?? (tripType === 'ONE_WAY'),
  };
  if (!['LOADING', 'LOADED'].includes(result.queryState)) invalid('queryState must be LOADING or LOADED.');
  if (input.sortType !== undefined) {
    if (!SORTS.has(input.sortType)) invalid('sortType is invalid.');
    const sortOrder = input.sortOrder ?? 'INCREASING';
    if (!ORDERS.has(sortOrder)) invalid('sortOrder must be INCREASING or DECREASING.');
    result.sortOption = { sortType: input.sortType, sortOrder };
  } else if (input.sortOrder !== undefined) invalid('sortOrder requires sortType.');
  if (input.pagination !== undefined) result.searchPagination = pagination(input.pagination);
  for (const key of ['flightsSearchComponentCriteria', 'shoppingSearchCriteria', 'shoppingContext', 'faresSeparationType', 'flightsDevicePermissionsInput', 'insuranceCriteria', 'flightsListingsViewType']) {
    if (input[key] !== undefined) result[key] = clone(input[key]);
  }
  if (input.searchFilters !== undefined) {
    if (!Array.isArray(input.searchFilters)) invalid('searchFilters must be an array of server filter values.');
    result.searchFiltersList = clone(input.searchFilters);
  }
  return result;
}

export function buildFlightSearchRequest(input, { loading = false } = {}) {
  const operation = FLIGHT_OPERATIONS[loading ? 'loading' : 'search'];
  const variables = buildFlightSearchVariables(input);
  if (loading) {
    variables.queryState = 'LOADING';
    delete variables.includeCarryOverFilter;
    delete variables.hideDetailsExpando;
    delete variables.skipFareSidesheetData;
    delete variables.flightsListingsViewType;
  }
  return { operationName: operation.operationName, variables, extensions: { persistedQuery: { version: 1, sha256Hash: operation.sha256Hash } } };
}

function dataOf(payload) {
  if (!object(payload)) throw new ExpediaError('UNSUPPORTED_RESPONSE', 'Expedia returned an unfamiliar response.');
  if (Array.isArray(payload.errors) && payload.errors.length) throw new ExpediaError('GRAPHQL_ERROR', 'Expedia did not complete this request.', { errors: payload.errors.map(error => ({ message: String(error.message ?? 'GraphQL error'), code: error.extensions?.code ?? null })) });
  return object(payload.data) ? payload.data : payload;
}
function pick(value, keys) {
  if (!object(value)) return null;
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, clone(value[key])]));
}
function normalizeOffer(value, index) {
  return {
    index, type: value.__typename, offerIdentifier: value.offerIdentifier ?? null,
    journeyContinuationId: value.journeyContinuationId ?? null,
    accessibilityMessage: value.accessibilityMessage ?? value.bargainFareAccessibilityMessage ?? null,
    journeys: clone(value.journeys ?? []),
    pricingInformation: clone(value.pricingInformation ?? value.bargainPricingInformation ?? null),
    priceDisplay: clone(value.priceDisplay ?? null),
    farePriceDisplayButtons: clone(value.farePriceDisplayButtons ?? []),
    selectOfferAction: clone(value.selectOfferAction ?? null),
    badges: clone(value.badgesList ?? []),
    shoppingOfferContent: clone(value.flightsShoppingOfferContent ?? null),
    fareOptions: normalizeFlightFareOptions({ journeys: value.journeys ?? [] }),
    header: clone(value.header ?? null), description: clone(value.description ?? null),
  };
}
export function normalizeFlightSearchResponse(payload) {
  const data = dataOf(payload);
  const search = data.flightsSearch;
  if (!object(search)) throw new ExpediaError('UNSUPPORTED_RESPONSE', 'Expedia returned no flightsSearch result.');
  const result = search.listingResult;
  const messages = pick(search, ['failedRequestMessaging', 'noListingMessaging', 'banners', 'pageTitle']);
  const common = {
    messages, shoppingContext: clone(search.shoppingContext ?? null),
    stepIndicator: clone(search.stepIndicator ?? null),
    sortAndFilter: clone(search.universalSortAndFilterResult ?? null),
    paginationConfig: clone(result?.paginationConfig ?? null),
    detailsConfig: clone(result?.detailsConfig ?? null),
  };
  if (result?.__typename === 'FlightsLoadingListingResult') return { status: 'loading', offers: [], ...common };
  if (result?.__typename !== 'FlightsLoadedListingResult') {
    if (search.failedRequestMessaging) return { status: 'unavailable', offers: [], ...common };
    if (search.noListingMessaging && (result === null || result === undefined)) return { status: 'no_results', offers: [], ...common };
    throw new ExpediaError('UNSUPPORTED_RESPONSE', 'Expedia returned an unfamiliar flight listing result.', { resultType: result?.__typename ?? null });
  }
  if (!Array.isArray(result.listings)) throw new ExpediaError('UNSUPPORTED_RESPONSE', 'Expedia flight listings are missing.');
  const offers = [];
  const otherListings = [];
  const knownAuxiliaryTypes = new Set(['FlightsFuzzyFilterCard', 'FlightsHeaderListing', 'FlightsListingMessagingCard', 'FlightsCarryOverFiltersCard', 'InsurtechPrimingCardListing', 'FlightsOneKeyBannerListing', 'FlightsManagedBannerListing', 'FlightsQuickFiltersContainerListing', 'FlightsSponsoredContentAdListing', 'FlightsCrossSellMessage']);
  result.listings.forEach((listing, index) => {
    if (!object(listing) || typeof listing.__typename !== 'string') throw new ExpediaError('UNSUPPORTED_RESPONSE', 'Expedia returned a malformed flight listing.');
    if (['FlightsStandardOffer', 'FlightsBargainFareOffer'].includes(listing.__typename)) offers.push(normalizeOffer(listing, index));
    else otherListings.push(clone(listing));
  });
  if (!offers.length && otherListings.some(listing => !knownAuxiliaryTypes.has(listing.__typename))) throw new ExpediaError('UNSUPPORTED_RESPONSE', 'Expedia returned unrecognized flight listing types.', { resultTypes: [...new Set(otherListings.map(listing => listing.__typename))] });
  return { status: offers.length ? 'ready' : search.noListingMessaging ? 'no_results' : 'ready', offers, otherListings, listingsStatus: result.flightsLoadedListingsStatus ?? null, ...common };
}
export function normalizeFlightDetailResponse(payload) {
  const data = dataOf(payload);
  if (!object(data.flightsDetail)) throw new ExpediaError('UNSUPPORTED_RESPONSE', 'Expedia returned no flightsDetail result.');
  // Fare actions and server continuation tokens remain intact for the next request.
  return clone(data.flightsDetail);
}
export function normalizeAirportSuggestions(payload) {
  const data = dataOf(payload);
  const suggestions = data.suggestions ?? data.sr;
  if (!Array.isArray(suggestions)) throw new ExpediaError('UNSUPPORTED_RESPONSE', 'Expedia returned no airport suggestions collection.');
  return { query: data.query ?? data.q ?? null, requestId: data.requestId ?? data.rid ?? null, returnCode: data.returnCode ?? data.rc ?? null, suggestions: suggestions.map(value => {
    if (!object(value)) throw new ExpediaError('UNSUPPORTED_RESPONSE', 'Expedia returned a malformed airport suggestion.');
    return pick(value, ['@type', 'index', 'gaiaId', 'type', 'regionType', 'category', 'regionNames', 'coordinates', 'hierarchyInfo', 'essId', 'isMinorAirport']);
  }) };
}

export const FLIGHT_DETAIL_OPERATIONS = Object.freeze({
  detail: { operationName: 'androidFlightsRateDetailFlightsDetailLoaded', sha256Hash: 'a1e08922f93d404874c5fc419767ca26d26e707f1e086e37a7982c2331978c09' },
  priceSummary: { operationName: 'FlightsDetailPriceSummary', sha256Hash: '5e2bce66d572f1c18c612dd3825dd5166dca24a2cec7d2b9cf6c42d3fc32ee3c' },
  productCard: { operationName: 'FlightsProductCard', sha256Hash: '13ff047d234e913e89e424601496d79a1898ab312a92bf742285c28d6e85339f' },
  journeyInformation: { operationName: 'FlightDetailsFISQuery', sha256Hash: 'fdb6688b528ba625fd7a00ec829be5c810957f11d944077f3b4484ac3795194d' },
});
function inputOnly(value) {
  if (Array.isArray(value)) return value.map(inputOnly);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '__typename').map(([key, item]) => [key, inputOnly(item)]));
}
function actionOf(selection) {
  const action = selection?.selectOfferAction ?? selection;
  if (!object(action)) invalid('A server-returned flight selection action is required.');
  return action;
}
export function buildFlightDetailVariables(input = {}, { variant = 'detail' } = {}) {
  if (!FLIGHT_DETAIL_OPERATIONS[variant]) invalid('Unknown flight detail request variant.');
  if (!object(input.context)) invalid('A caller-supplied Expedia context is required.');
  const action = input.selection === undefined ? null : actionOf(input.selection);
  const criteria = input.flightsDetailCriteria ?? action?.flightsDetailCriteria;
  if (!object(criteria) || typeof criteria.journeyContinuationId !== 'string' || !criteria.journeyContinuationId) invalid('Flight details require a server-returned journeyContinuationId.');
  const result = { context: clone(input.context), flightsDetailCriteria: inputOnly(criteria) };
  if (input.insuranceCriteria !== undefined) result.insuranceCriteria = inputOnly(input.insuranceCriteria);
  if (variant === 'priceSummary') return result;
  if (input.flightsDetailComponentsCriteria !== undefined) result.flightsDetailComponentsCriteria = inputOnly(input.flightsDetailComponentsCriteria);
  if (variant !== 'detail' && input.shoppingContext !== undefined) result.shoppingContext = inputOnly(input.shoppingContext);
  if (variant !== 'journeyInformation') result.queryState = 'LOADED';
  if (variant === 'detail') { result.hideDetailsExpando = input.hideDetailsExpando ?? false; result.includeFdlNode = input.includeFdlNode ?? true; }
  if (variant === 'productCard') { result.hideDetailsExpando = input.hideDetailsExpando ?? false; result.showDetailsLink = input.showDetailsLink ?? false; }
  return result;
}
export function buildFlightDetailRequest(input, { variant = 'detail' } = {}) {
  const variables = buildFlightDetailVariables(input, { variant });
  const operation = FLIGHT_DETAIL_OPERATIONS[variant];
  return { operationName: operation.operationName, variables, extensions: { persistedQuery: { version: 1, sha256Hash: operation.sha256Hash } } };
}

export function buildNextFlightSearchVariables({ context, selection, journeySearchCriteria, baseVariables = {} } = {}) {
  if (!object(context)) invalid('A caller-supplied Expedia context is required.');
  const criteria = journeySearchCriteria ?? actionOf(selection).journeySearchCriteria;
  if (!object(criteria) || !Array.isArray(criteria.journeyCriteria) || !criteria.journeyCriteria.length || !object(criteria.flightsSearchContext) || !TRIPS.has(criteria.flightsSearchContext.tripType)) invalid('The server action does not contain complete next-flight search criteria.');
  const result = { ...inputOnly(baseVariables), context: clone(context), journeyCriteria: inputOnly(criteria.journeyCriteria), flightsSearchContext: inputOnly(criteria.flightsSearchContext), queryState: 'LOADED', includeCarryOverFilter: baseVariables.includeCarryOverFilter ?? false, hideDetailsExpando: baseVariables.hideDetailsExpando ?? false, skipFareSidesheetData: baseVariables.skipFareSidesheetData ?? true };
  for (const key of ['travelerDetails', 'searchPreferences']) if (criteria[key] !== undefined) result[key] = inputOnly(criteria[key]);
  // The response places previous selections beside search context; the input schema
  // expects them inside it (the native JourneySearchCriteriaConverter does the same).
  if (criteria.previousFlightSelections !== undefined) result.flightsSearchContext.previousFlightSelections = inputOnly(criteria.previousFlightSelections);
  // A new selected leg starts its own page; retaining a previous page skips offers.
  delete result.searchPagination;
  return result;
}
export function buildFlightSelectionRequest({ context, selection, baseVariables = {}, variant = 'detail' } = {}) {
  const action = actionOf(selection);
  if (action.type === 'GO_TO_DETAILS') return { kind: 'detail', request: buildFlightDetailRequest({ context, selection: action, shoppingContext: action.shoppingContext ?? baseVariables.shoppingContext }, { variant }) };
  if (action.type === 'GO_TO_SEARCH') {
    const variables = buildNextFlightSearchVariables({ context, selection: action, baseVariables });
    return { kind: 'search', request: { operationName: FLIGHT_OPERATIONS.search.operationName, variables, extensions: { persistedQuery: { version: 1, sha256Hash: FLIGHT_OPERATIONS.search.sha256Hash } } } };
  }
  throw new ExpediaError('UNSUPPORTED_ACTION', 'Expedia returned an unsupported flight selection action.', { actionType: action.type ?? action.__typename ?? null });
}

export function normalizeFlightFareOptions(payload) {
  const data = dataOf(payload);
  const detail = object(data.flightsDetail) ? data.flightsDetail : data;
  const journeys = detail.flightsSelectedJourneyDetails ?? detail.journeys;
  if (!Array.isArray(journeys)) throw new ExpediaError('UNSUPPORTED_RESPONSE', 'Expedia returned no selected-journey fare data.');
  const fares = [];
  journeys.forEach((journey, journeyIndex) => {
    const sections = journey?.fareDetails?.fareSummary?.detailsAndFares?.flightsDetailsAndFares?.sections ?? journey?.detailsAndFares?.flightsDetailsAndFares?.sections;
    if (!Array.isArray(sections)) return;
    for (const section of sections) {
      if (section?.__typename !== 'FlightsFaresInformation') continue;
      if (!Array.isArray(section.fares)) throw new ExpediaError('UNSUPPORTED_RESPONSE', 'Expedia returned malformed fare options.');
      for (const fare of section.fares) {
        if (!object(fare)) throw new ExpediaError('UNSUPPORTED_RESPONSE', 'Expedia returned a malformed fare option.');
        const actions = (fare.action ?? []).map(action => ({
          states: clone(action.states ?? []),
          button: pick(action.action, ['primary', 'accessibility', 'disabled']),
          clientAction: pick(action.action?.clientAction, ['__typename', 'accessibility', 'value', 'jcid', 'flightsBoundNavigationJcid', 'stepIndicatorJcid', 'mipt', 'flightsDetailsStepIndicatorJcid', 'obid']),
        }));
        fares.push({ index: fares.length, journeyIndex, associatedLeg: fare.associatedLeg ?? null, state: fare.state ?? null, heading: clone(fare.heading ?? null), fareDetails: clone(fare.fareDetails ?? []), amenities: clone(fare.amenities ?? []), actions });
      }
    }
  });
  return fares;
}

export function buildFlightFareSelectionVariables(input = {}) {
  let action = input.selectionAction;
  if (action === undefined && object(input.fare)) {
    const candidates = (input.fare.actions ?? []).filter(candidate => (!candidate.states?.length || candidate.states.includes(input.fare.state)) && candidate.button?.disabled !== true);
    action = candidates.find(candidate => candidate.clientAction?.__typename === 'FlightsSelectionAction')?.clientAction;
    if (!action && input.fare.state === 'SELECTED') throw new ExpediaError('FARE_ALREADY_SELECTED', 'This fare is already selected.');
  }
  if (action?.__typename !== 'FlightsSelectionAction' || typeof action.value !== 'string' || !action.value || action.value.length > 65536) invalid('Choose a fare with a valid server-returned FlightsSelectionAction.');
  const base = buildFlightDetailVariables(input);
  // Corroborated with the native FIS request: the opaque action value is an
  // upsell offer token. It is not a JCID or a last-selected-token structure.
  base.flightsDetailCriteria.upsellOfferToken = action.value;
  return base;
}
export function buildFlightFareSelectionRequest(input = {}) {
  let fare = input.fare;
  if (input.offer !== undefined) {
    const options = input.offer.fareOptions ?? normalizeFlightFareOptions(input.offer);
    const index = integer(input.fareIndex ?? 0, 'fareIndex', 0, Math.max(options.length - 1, 0));
    fare = options[index];
    if (!fare) throw new ExpediaError('FARE_UNAVAILABLE', 'This offer has no preloaded fare selection. Load flight details first.');
  }
  const candidates = (fare?.actions ?? []).filter(candidate => (!candidate.states?.length || candidate.states.includes(fare.state)) && candidate.button?.disabled !== true);
  const action = input.selectionAction ?? candidates[0]?.clientAction;
  if (action?.__typename === 'FlightsNavigateToDetails') {
    if (typeof action.jcid !== 'string' || !action.jcid) invalid('The fare action is missing its server journey token.');
    return { ...buildFlightDetailRequest({ context: input.context, flightsDetailCriteria: { journeyContinuationId: action.jcid, ...(action.obid !== undefined ? { originalBookingId: action.obid } : {}) } }), kind: 'detail' };
  }
  if (action?.__typename === 'FlightsBoundNavigation') {
    const token = action.flightsBoundNavigationJcid ?? action.jcid;
    if (typeof token !== 'string' || !token) invalid('The fare action is missing its server journey token.');
    if (action.mipt) throw new ExpediaError('UNSUPPORTED_ACTION', 'Package fare selection requires a multi-item shopping flow.');
    const variables = inputOnly(input.baseVariables);
    if (!object(variables?.context) || !Array.isArray(variables.journeyCriteria) || !object(variables.flightsSearchContext)) invalid('Next-journey fare selection requires the saved search variables.');
    variables.context = clone(input.context ?? variables.context);
    variables.flightsSearchContext.journeysContinuationId = token;
    variables.queryState = 'LOADED';
    variables.skipFareSidesheetData = false;
    delete variables.searchPagination;
    return { operationName: FLIGHT_OPERATIONS.search.operationName, variables, extensions: { persistedQuery: { version: 1, sha256Hash: FLIGHT_OPERATIONS.search.sha256Hash } }, kind: 'search' };
  }
  return { operationName: FLIGHT_DETAIL_OPERATIONS.detail.operationName, variables: buildFlightFareSelectionVariables({ ...input, fare, ...(action ? { selectionAction: action } : {}) }), extensions: { persistedQuery: { version: 1, sha256Hash: FLIGHT_DETAIL_OPERATIONS.detail.sha256Hash } }, kind: 'detail' };
}
