// Static contracts from Airbnb Android 26.42 (28026652). No network access here.
// Evidence: search-findings.md in the private investigation evidence directory.
export const SEARCH_OPERATIONS = Object.freeze({
  stays: Object.freeze({ operationName: 'StaysSearch', hash: '0f2b6b69de61b5db4ab063321b347ed68529f56eba0b8d847799bda2a57a45ef' }),
  details: Object.freeze({ operationName: 'StaysPdpSectionsQuery', hash: '9a66233b8930b0cf07c49eadd5cca4ab699965a33164f38791c5ee2c3fe8aced' }),
  calendar: Object.freeze({ operationName: 'PdpAvailabilityCalendarQuery', hash: 'e00c2132fc81efb79b6eae87065836360bd03b1051a0cc2c7621ce4d9358023b' }),
});

function fail(message, code = 'INVALID_ARGUMENT', extra = {}) {
  throw Object.assign(new Error(message), { code, ...extra });
}
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function requestOptions(value) {
  if (!plain(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Request options must be an object.');
}
function text(value, name, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || /[\x00-\x1f\x7f]/.test(value)) fail(`${name} must be a ${empty ? '' : 'nonempty '}string without control characters.`);
  return value;
}
function integer(value, fallback, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = value === undefined ? fallback : value;
  if ((typeof n !== 'number' && typeof n !== 'string') || (typeof n === 'string' && !/^\d+$/.test(n)) || !Number.isSafeInteger(Number(n)) || Number(n) < min || Number(n) > max) fail(`${name} must be an integer between ${min} and ${max}.`);
  return Number(n);
}
function bool(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`${name} must be a boolean.`);
  return value;
}
function date(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) fail(`${name} must be a real date in YYYY-MM-DD format.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) fail(`${name} must be a real date in YYYY-MM-DD format.`);
  return value;
}
function dates(checkin, checkout) {
  const start = date(checkin, 'checkin');
  const end = date(checkout, 'checkout');
  if ((start === undefined) !== (end === undefined)) fail('checkin and checkout must be supplied together.');
  if (start !== undefined && end <= start) fail('checkout must be later than checkin.');
  return { start, end };
}
function guests(options) {
  return {
    adults: integer(options.adults, 1, 'adults', 1),
    children: integer(options.children, 0, 'children'),
    infants: integer(options.infants, 0, 'infants'),
    pets: integer(options.pets, 0, 'pets'),
  };
}
function numeric(value, name, min = 0, max = Infinity) {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) fail(`${name} must be a finite number between ${min} and ${max}.`);
  return Number(value);
}
function coordinates(value) {
  if (value === undefined) return undefined;
  if (!plain(value)) fail('bounds must contain neLat, neLng, swLat, and swLng.');
  const result = {};
  for (const [name, camel, max] of [['ne_lat', 'neLat', 90], ['ne_lng', 'neLng', 180], ['sw_lat', 'swLat', 90], ['sw_lng', 'swLng', 180]]) {
    const n = value[camel] ?? value[name];
    if ((typeof n !== 'number' && typeof n !== 'string') || (typeof n === 'string' && !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(n)) || !Number.isFinite(Number(n)) || Number(n) < -max || Number(n) > max) fail(`${camel} must be a finite coordinate between ${-max} and ${max}.`);
    result[name] = Number(n);
  }
  if (result.sw_lat > result.ne_lat) fail('bounds.swLat must not exceed bounds.neLat.');
  // A west longitude greater than east longitude can cross the antimeridian.
  return result;
}
function listingId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('listingId numbers must be safe integers; use a decimal string for larger IDs.');
  if (!['string', 'number', 'bigint'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value))) fail('listingId must be a positive decimal listing ID.');
  return String(value);
}
function globalId(type, id) { return Buffer.from(`${type}:${listingId(id)}`, 'utf8').toString('base64'); }
function strings(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array of strings.`);
  return value.map(item => text(item, name));
}
function filterValues(value, name) {
  return (Array.isArray(value) ? value : [value]).map(item => {
    if (!['string', 'number', 'boolean'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item))) fail(`${name} filter values must be strings, finite numbers, or booleans.`);
    return text(String(item), name, { empty: true });
  });
}

/** The relative REST path is resolved against the Android v2 base by transport. */
export function buildAutocomplete(options = {}) {
  requestOptions(options);
  const query = text(options.query, 'query');
  const language = text(options.language ?? 'en', 'language');
  if (!/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(language)) fail('language must be a language code.');
  const country = text(options.country ?? '', 'country', { empty: true }).toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) fail('country must be an ISO two-letter country code.');
  const params = {
    language, num_results: integer(options.limit, 5, 'limit', 1, 100), country,
    user_input: query,
    options: text(options.options ?? 'hide_nav_results|should_filter_by_vertical_refinement|simple_search', 'options'),
    api_version: text(options.apiVersion ?? '1.0.7', 'apiVersion'), cdn_cache: 1,
  };
  if (options.satoriConfigToken !== undefined) params.satori_config_token = text(options.satoriConfigToken, 'satoriConfigToken');
  if (options.verticalRefinement !== undefined && options.verticalRefinement !== 'for_you') params.vertical_refinement = text(options.verticalRefinement, 'verticalRefinement');
  if (options.region !== undefined) params.region = integer(options.region, undefined, 'region', 1);
  Object.assign(params, coordinates(options.bounds));
  return { path: 'autocompletes', query: params };
}

/** rawParams/filters preserve server-provided autocomplete filter names and values. */
export function buildStaysSearch(options = {}) {
  requestOptions(options);
  const { start, end } = dates(options.checkin, options.checkout);
  const counts = guests(options);
  const bounds = coordinates(options.bounds);
  const limit = integer(options.limit, 16, 'limit', 1, 100);
  let currency = text(options.currency ?? 'USD', 'currency').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail('currency must be a three-letter currency code.');
  const cursor = options.cursor === undefined || options.cursor === null ? null : text(options.cursor, 'cursor');
  const filters = new Map();
  if (options.filters !== undefined) {
    if (!plain(options.filters)) fail('filters must be an object of filter names and values.');
    for (const [key, value] of Object.entries(options.filters)) filters.set(text(key, 'filter name'), filterValues(value, key));
  }
  if (options.rawParams !== undefined) {
    if (!Array.isArray(options.rawParams)) fail('rawParams must be an array.');
    for (const item of options.rawParams) {
      if (!plain(item) || !Array.isArray(item.filterValues)) fail('Each rawParams item needs filterName and filterValues.');
      filters.set(text(item.filterName, 'filterName'), filterValues(item.filterValues, item.filterName));
    }
  }
  const put = (name, value) => filters.set(name, filterValues(value, name));
  if (options.query !== undefined) put('query', text(options.query, 'query'));
  if (options.placeId !== undefined) put('place_id', text(options.placeId, 'placeId'));
  if (start !== undefined) { put('checkin', start); put('checkout', end); }
  for (const [key, value] of Object.entries(counts)) {
    // Explicit options win; server-provided filters survive otherwise.
    if (options[key] !== undefined || !filters.has(key)) put(key, value);
  }
  let minPrice;
  let maxPrice;
  if (options.minPrice !== undefined) { minPrice = numeric(options.minPrice, 'minPrice'); put('price_min', minPrice); }
  if (options.maxPrice !== undefined) { maxPrice = numeric(options.maxPrice, 'maxPrice'); put('price_max', maxPrice); }
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) fail('minPrice must not exceed maxPrice.');
  for (const [key, value] of Object.entries(bounds ?? {})) put(key, value);
  const refinementPaths = strings(options.refinementPaths ?? filters.get('refinement_paths') ?? ['/homes'], 'refinementPaths');
  const defaultFilters = {
    additional_refinements: [], cdn_experiments: ['m3Web'], simple_search_treatment: ['simple_search_only'],
    disable_auto_translation: ['true'], itemsPerGrid: [String(limit)], currency: [currency],
  };
  for (const [key, value] of Object.entries(defaultFilters)) if (!filters.has(key)) filters.set(key, value);
  // Explicit limit/currency replace copied autocomplete settings.
  if (options.limit !== undefined) put('itemsPerGrid', limit);
  if (options.currency !== undefined) put('currency', currency);
  // Copied autocomplete filters are real request inputs too. Validate the final
  // values, after explicit options have overridden them, without constraining
  // unknown server-defined filters.
  const one = name => {
    if (!filters.has(name)) return undefined;
    const values = filters.get(name);
    if (values.length !== 1) fail(`${name} requires exactly one filter value.`);
    return values[0];
  };
  for (const name of ['query', 'place_id']) if (filters.has(name)) text(one(name), name);
  dates(one('checkin'), one('checkout'));
  for (const name of ['adults', 'children', 'infants', 'pets']) if (filters.has(name)) put(name, integer(one(name), undefined, name, name === 'adults' ? 1 : 0));
  const effectiveMin = filters.has('price_min') ? numeric(one('price_min'), 'price_min') : undefined;
  const effectiveMax = filters.has('price_max') ? numeric(one('price_max'), 'price_max') : undefined;
  if (effectiveMin !== undefined && effectiveMax !== undefined && effectiveMin > effectiveMax) fail('minPrice must not exceed maxPrice.');
  const coordinateNames = ['ne_lat', 'ne_lng', 'sw_lat', 'sw_lng'];
  if (coordinateNames.some(name => filters.has(name))) coordinates(Object.fromEntries(coordinateNames.map(name => [name, one(name)])));
  currency = text(one('currency'), 'currency').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail('currency must be a three-letter currency code.');
  put('currency', currency);
  put('itemsPerGrid', integer(one('itemsPerGrid'), undefined, 'itemsPerGrid', 1, 100));
  const searchType = text(options.searchType ?? filters.get('search_type')?.[0] ?? 'SEARCH_QUERY', 'searchType');
  const staysSearchRequest = {
    autosuggestionsOptions: 'simple_search', cursor, metadataOnly: false,
    rawParams: [...filters].map(([filterName, values]) => ({ filterName, filterValues: values })),
    refinementPaths, requestedPageType: 'STAYS_SEARCH', searchType,
    maxMapItems: cursor === null ? 9999 : 0, treatmentFlags: strings(options.treatmentFlags ?? [], 'treatmentFlags'),
  };
  if (options.satoriVersion !== undefined) staysSearchRequest.satoriVersion = text(options.satoriVersion, 'satoriVersion');
  return {
    ...SEARCH_OPERATIONS.stays,
    currency,
    variables: {
      staysSearchRequest, isFlexDestListing: true, isOptimizedPricingQuoteEnabled: true,
      slimPaginationRequest: cursor !== null, skipMapResults: cursor !== null,
      wishlistTenantIntegrationEnabled: bool(options.wishlistTenantIntegrationEnabled, false, 'wishlistTenantIntegrationEnabled'),
      showListingCardMap: bool(options.showListingCardMap, false, 'showListingCardMap'),
      skipUnusedFields: bool(options.skipUnusedFields, false, 'skipUnusedFields'),
    },
  };
}

export function buildListingDetails(options = {}) {
  requestOptions(options);
  const id = listingId(options.listingId);
  const { start, end } = dates(options.checkin, options.checkout);
  const counts = guests(options);
  const variables = {
    id: globalId('StayListing', id), demandStayListingId: globalId('DemandStayListing', id),
    ...counts, numberOfChildren: counts.children, numberOfInfants: counts.infants,
    guestCounts: { numberOfAdults: counts.adults, numberOfChildren: counts.children, numberOfInfants: counts.infants, numberOfPets: counts.pets },
    bookingMigrationEnabled: true, translateUgc: bool(options.translateUgc, true, 'translateUgc'),
    includeGPMediaTourSectionQuery: false, includeGPSleepingArrangementSectionQuery: false,
    includeGPMeetYourHostSectionQuery: false, includeGPReportListingSectionQuery: false,
    includeGPPoliciesSectionQuery: false, includeGPHighlightsSectionQuery: false,
    includeGPHighlightsCompactSectionQuery: false, includeGPEmptyReviewsSectionQuery: false,
    includeEntityGuestFavoriteBannerSectionQuery: false, includeGPHeroSectionQuery: false,
    includeEntityBookItBarSectionQuery: bool(options.includeBookItBar, true, 'includeBookItBar'),
  };
  if (start !== undefined) Object.assign(variables, {
    checkIn: start, checkOut: end, checkInDate: start, checkOutDate: end,
    dateRange: { startDate: start, endDate: end },
  });
  if (options.sectionIds !== undefined) variables.sectionIds = strings(options.sectionIds, 'sectionIds');
  return { ...SEARCH_OPERATIONS.details, variables };
}

export function buildCalendar(options = {}) {
  requestOptions(options);
  return {
    ...SEARCH_OPERATIONS.calendar,
    variables: {
      listingId: globalId('DemandStayListing', options.listingId),
      input: {
        month: integer(options.month, undefined, 'month', 1, 12),
        year: integer(options.year, undefined, 'year', 1, 9999),
        count: integer(options.count, 1, 'count', 1, 36),
        returnPropertyLevelCalendarIfApplicable: bool(options.returnPropertyLevelCalendarIfApplicable, false, 'returnPropertyLevelCalendarIfApplicable'),
      },
    },
  };
}

function responseErrors(payload) {
  if (payload?.errors != null && !Array.isArray(payload.errors)) fail('Unsupported GraphQL error response; raw response retained.', 'UNSUPPORTED_RESPONSE', { raw: payload });
  if (Array.isArray(payload?.errors) && payload.errors.length) fail('Airbnb returned GraphQL errors.', 'GRAPHQL_ERROR', { errors: payload.errors, raw: payload });
}
const stringOrNull = value => typeof value === 'string' ? value : null;
const booleanOrNull = value => typeof value === 'boolean' ? value : null;
const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
function localized(value) {
  if (typeof value === 'string') return value;
  if (!plain(value)) return null;
  if (plain(value.content)) return localized(value.content);
  return stringOrNull(value.localizedStringWithTranslationPreference) ?? stringOrNull(value.localizedString)
    ?? stringOrNull(value.text) ?? stringOrNull(value.source);
}
function decimalId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  return (typeof value === 'string' || typeof value === 'number') && /^[1-9]\d*$/.test(String(value)) ? String(value) : null;
}
function stayId(value) {
  if (decimalId(value)) return String(value);
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) return null;
  return decoded.toString('utf8').match(/^(?:DemandStayListing|StayListing):([1-9]\d*)$/)?.[1] ?? null;
}
function priceLine(line) {
  if (!plain(line)) return null;
  if (typeof line.accessibilityLabel === 'string' && line.accessibilityLabel.trim()) return line.accessibilityLabel;
  if (!Array.isArray(line.orderedComponents) && line.concatQualifierLeft === true
    && typeof line.price === 'string' && typeof line.qualifier === 'string') return `${line.qualifier} ${line.price}`;
  const components = Array.isArray(line.orderedComponents) ? line.orderedComponents : [line];
  const result = components.flatMap(component => {
    if (!plain(component)) return [];
    return ['originalPrice', 'discountedPrice', 'price', 'qualifier'].map(key => stringOrNull(component[key])).filter(Boolean);
  }).join(' ');
  return result || null;
}
function displayPrice(price) {
  if (!plain(price)) return null;
  return { primary: priceLine(price.primaryLine), secondary: priceLine(price.secondaryLine), style: stringOrNull(price.displayPriceStyle) };
}

/** Display strings are preserved; a formatted total is never parsed into a nightly rate. */
export function summarizeStay(item, sourceIndex = 0) {
  const listing = item?.demandStayListing;
  const coordinate = listing?.location?.coordinate;
  const content = item?.structuredContent;
  return {
    sourceIndex, type: stringOrNull(item?.__typename), listingId: stayId(listing?.id),
    title: stringOrNull(item?.title), name: localized(listing?.description?.name) ?? stringOrNull(item?.subtitle) ?? localized(item?.nameLocalized),
    location: stringOrNull(listing?.location?.localizedCityName),
    latitude: numberOrNull(coordinate?.latitude), longitude: numberOrNull(coordinate?.longitude),
    rating: stringOrNull(item?.avgRatingLocalized), ratingDescription: stringOrNull(item?.avgRatingA11yLabel),
    price: displayPrice(item?.structuredDisplayPrice),
    details: Array.isArray(content?.primaryLine) ? content.primaryLine.map(part => localized(part?.body) ?? localized(part?.headline)).filter(Boolean) : [],
    imageUrl: stringOrNull(item?.contextualPictures?.[0]?.picture),
  };
}

export function summarizeListing(data) {
  const listing = data?.demandStayListingData;
  const pdp = listing?.pdpPresentation;
  const navigation = listing?.navigationPdpPresentation;
  const overview = listing?.overviewSectionPdpPresentation?.overview;
  const quality = pdp?.quality ?? listing?.metadataPdpPresentation?.quality;
  const stats = quality?.listingRatingStats?.overallRatingStats;
  const booking = pdp?.bookIt;
  const availability = booking?.availability;
  const rules = pdp?.rules?.groupItems;
  const amenities = pdp?.amenities?.previewAmenitiesGroups;
  const sections = data?.presentation?.stayProductDetailPage?.sections;
  return {
    listingId: stayId(listing?.description?.stayListingId),
    title: localized(pdp?.title) ?? localized(listing?.heroPdpPresentation?.title),
    location: stringOrNull(navigation?.localizedLocation) ?? stringOrNull(listing?.metadataPdpPresentation?.localizedLocation),
    spaceType: stringOrNull(listing?.spaceType), capacity: numberOrNull(listing?.personCapacity),
    overview: Array.isArray(overview?.items) ? overview.items.filter(item => typeof item === 'string') : [],
    rating: numberOrNull(stats?.ratingAverage), reviewCount: typeof stats?.ratingCount === 'string' ? stats.ratingCount : numberOrNull(stats?.ratingCount),
    guestFavorite: booleanOrNull(quality?.isGuestFavorite),
    selectedDates: stringOrNull(booking?.selectedDates), price: displayPrice(booking?.structuredDisplayPrice),
    availability: plain(availability) ? {
      isAvailable: booleanOrNull(availability.isAvailable), canInstantBook: booleanOrNull(availability.canInstantBook),
      reason: stringOrNull(availability.unavailabilityReason), message: localized(availability.unavailabilityMessage),
    } : null,
    availabilityNote: stringOrNull(booking?.availabilityDetailsKicker),
    amenities: Array.isArray(amenities) ? amenities.flatMap(group => Array.isArray(group?.amenities) ? group.amenities.map(amenity => ({ name: localized(amenity?.title), available: booleanOrNull(amenity?.available) })) : []) : [],
    rules: Array.isArray(rules) ? rules.flatMap(group => Array.isArray(group?.items) ? group.items.map(rule => ({ title: localized(rule?.title), description: localized(rule?.description) })) : []) : [],
    cancellationPolicy: Array.isArray(pdp?.cancellationPolicy?.entries) ? pdp.cancellationPolicy.entries.map(entry => ({
      description: stringOrNull(entry?.accessibilityContent), refundType: stringOrNull(entry?.refundType), refundTerm: stringOrNull(entry?.refundTerm),
    })) : [],
    shareUrl: stringOrNull(navigation?.sharingConfig?.shareUrl),
    imageUrl: stringOrNull(navigation?.sharingConfig?.imageUrl),
    sectionCount: Array.isArray(sections?.sectionsV2) ? sections.sectionsV2.length : Array.isArray(sections?.sectionContainer) ? sections.sectionContainer.length : null,
  };
}

function isoDateOrNull(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}
function conditionRanges(ranges) {
  if (!Array.isArray(ranges)) return null;
  const result = [];
  for (const range of ranges) {
    const startDate = isoDateOrNull(range?.startDate), endDate = isoDateOrNull(range?.endDate);
    const value = range?.conditions;
    const conditions = plain(value) ? {
      closedToArrival: booleanOrNull(value.closedToArrival), closedToDeparture: booleanOrNull(value.closedToDeparture),
      startDayOfWeek: numberOrNull(value.startDayOfWeek), endDayOfWeek: numberOrNull(value.endDayOfWeek),
      minNights: numberOrNull(value.minNights), maxNights: numberOrNull(value.maxNights),
    } : null;
    if (conditions) for (const [name, field] of Object.entries(value)) {
      if (name !== '__typename' && !Object.hasOwn(conditions, name)) conditions[name] = field;
    }
    const prior = result.at(-1);
    if (startDate && endDate && startDate <= endDate && prior?.endDate
      && Date.parse(`${startDate}T00:00:00Z`) - Date.parse(`${prior.endDate}T00:00:00Z`) === 86_400_000
      && JSON.stringify(prior.conditions) === JSON.stringify(conditions)) prior.endDate = endDate;
    else result.push({ startDate, endDate, conditions });
  }
  return result;
}

/** Daily flags and restrictions do not establish that an entire stay is bookable. */
export function summarizeCalendar(calendar) {
  return {
    firstBookableDay: isoDateOrNull(calendar?.metadata?.firstBookableDay),
    constantMinNights: numberOrNull(calendar?.metadata?.constantMinNights),
    months: calendar.calendarMonths.map(month => ({
      listingId: decimalId(month?.listingId), month: numberOrNull(month?.month), year: numberOrNull(month?.year),
      days: Array.isArray(month?.days) ? month.days.map(day => ({
        date: isoDateOrNull(day?.date), available: booleanOrNull(day?.available),
        availableForCheckin: booleanOrNull(day?.availableForCheckin), availableForCheckout: booleanOrNull(day?.availableForCheckout),
        bookable: booleanOrNull(day?.bookable), minNights: numberOrNull(day?.minNights), maxNights: numberOrNull(day?.maxNights),
      })) : null,
      restrictions: conditionRanges(month?.conditionRanges),
    })),
  };
}
export function normalizeAutocomplete(payload) {
  responseErrors(payload);
  if (payload?.errorCode && payload.errorCode !== 0) fail('Airbnb returned an autocomplete error.', 'API_ERROR', { raw: payload });
  if (!plain(payload) || !Array.isArray(payload.autocomplete_terms)) fail('Unsupported autocomplete response; raw response retained.', 'UNSUPPORTED_RESPONSE', { raw: payload });
  return { items: payload.autocomplete_terms, metadata: payload.metadata ?? null, raw: payload,
    summary: { count: payload.autocomplete_terms.length, places: payload.autocomplete_terms.map((item, sourceIndex) => ({
      sourceIndex, id: stringOrNull(item?.id), name: stringOrNull(item?.display_name), subtitle: stringOrNull(item?.sub_title), searchParams: item?.explore_search_params ?? null,
    })) },
  };
}
export function normalizeStaysSearch(payload) {
  responseErrors(payload);
  const result = (payload?.data ?? payload)?.presentation?.staysSearch?.results;
  if (!plain(result) || !Array.isArray(result.searchResults)) fail('Unsupported stays search response; raw response retained.', 'UNSUPPORTED_RESPONSE', { raw: payload });
  const pagination = result.paginationInfo;
  if (pagination != null && !plain(pagination)) fail('Unsupported search pagination; raw response retained.', 'UNSUPPORTED_RESPONSE', { raw: payload });
  for (const key of ['nextPageCursor', 'previousPageCursor']) if (pagination?.[key] != null && typeof pagination[key] !== 'string') fail('Unsupported search cursor; raw response retained.', 'UNSUPPORTED_RESPONSE', { raw: payload });
  const nextCursor = pagination?.nextPageCursor ?? null, previousCursor = pagination?.previousPageCursor ?? null;
  return { items: result.searchResults, nextCursor, previousCursor, result, raw: payload,
    summary: { count: result.searchResults.length, stays: result.searchResults.map(summarizeStay), nextCursor, previousCursor },
  };
}

export function normalizeListing(payload) {
  responseErrors(payload);
  const data = payload?.data ?? payload;
  const listing = data?.demandStayListingData, page = data?.presentation?.stayProductDetailPage;
  const populated = value => plain(value) && Object.keys(value).some(key => key !== '__typename' && value[key] != null);
  if (!populated(listing) && !populated(page)) fail('The listing was not found or returned no details.', 'LISTING_NOT_FOUND', { raw: payload });
  const summary = summarizeListing(data);
  const sectionData = page?.sections;
  const hasSections = ['sectionsV2', 'sectionContainer', 'screens', 'screensV2'].some(name => Array.isArray(sectionData?.[name]) && sectionData[name].length > 0);
  if (!hasSections && !summary.listingId && !summary.title && !summary.location && summary.capacity == null
    && !summary.overview.length && !summary.price?.primary && summary.availability?.isAvailable == null) fail('Unsupported listing details; raw response retained.', 'UNSUPPORTED_RESPONSE', { raw: payload });
  return { data, raw: payload, summary };
}
export function normalizeCalendar(payload) {
  responseErrors(payload);
  const calendar = (payload?.data ?? payload)?.node?.pdpAvailabilityCalendar;
  if (!plain(calendar)) fail('The listing returned no availability calendar.', 'CALENDAR_NOT_FOUND', { raw: payload });
  if (!Array.isArray(calendar.calendarMonths) || calendar.calendarMonths.some(month => !plain(month) || (month.days != null && !Array.isArray(month.days)))) fail('Unsupported availability calendar; raw response retained.', 'UNSUPPORTED_RESPONSE', { raw: payload });
  return { calendar, raw: payload, summary: summarizeCalendar(calendar) };
}
