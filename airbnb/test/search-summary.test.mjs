import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAutocomplete, buildStaysSearch, buildListingDetails, buildCalendar,
  normalizeStaysSearch, normalizeListing, normalizeCalendar, summarizeStay,
} from '../src/search-protocol.mjs';

// Synthetic fixtures use the native response topology corroborated by retained
// anonymous captures. No real listing/account data is shipped in these tests.
const id = '12345678901234567890';
const globalId = type => Buffer.from(`${type}:${id}`).toString('base64');
const ugc = value => ({ content: { localizedStringWithTranslationPreference: value } });

test('stay summaries expose exact listing IDs and display prices while retaining source objects', () => {
  const stay = {
    __typename: 'StaySearchResult', title: 'Home in Example City', subtitle: 'Quiet apartment',
    demandStayListing: { id: globalId('DemandStayListing'), description: { name: ugc('Quiet apartment') },
      location: { localizedCityName: 'Example City', coordinate: { latitude: 30, longitude: -120 } } },
    avgRatingLocalized: '4,95 (123)', avgRatingA11yLabel: 'Rated 4.95',
    structuredDisplayPrice: { primaryLine: { accessibilityLabel: '€400 for 2 nights' }, displayPriceStyle: 'TOTAL_ONLY' },
    structuredContent: { primaryLine: [{ body: '2 beds' }, { body: '1 bath' }] },
    unknownField: { keep: true },
  };
  const payload = { data: { presentation: { staysSearch: { results: {
    searchResults: [stay], paginationInfo: { nextPageCursor: 'opaque+/=' },
  } } } } };
  const result = normalizeStaysSearch(payload);
  assert.equal(result.items[0], stay);
  assert.equal(result.raw, payload);
  assert.equal(result.summary.stays[0].listingId, id);
  assert.equal(result.summary.stays[0].rating, '4,95 (123)');
  assert.equal(result.summary.stays[0].price.primary, '€400 for 2 nights');
  assert.deepEqual(result.summary.stays[0].details, ['2 beds', '1 bath']);
  assert.equal(result.summary.nextCursor, 'opaque+/=');
  assert.ok(!Object.hasOwn(result.summary.stays[0].price, 'nightlyRate'));
});

test('a property ID or unrelated global ID is never promoted to a listing ID', () => {
  assert.equal(summarizeStay({ propertyId: '123', demandStayListing: { id: Buffer.from('User:123').toString('base64') } }).listingId, null);
  assert.equal(summarizeStay({ demandStayListing: { id: 'bad base64' } }).listingId, null);
  assert.equal(summarizeStay({ demandStayListing: { id: globalId('StayListing') } }).listingId, id);
  const fallback = summarizeStay({ structuredDisplayPrice: { primaryLine: { orderedComponents: [
    { originalPrice: '$500' }, { discountedPrice: '$400' }, { qualifier: 'for 2 nights' },
  ] } } });
  assert.equal(fallback.price.primary, '$500 $400 for 2 nights');
  assert.equal(summarizeStay({ structuredDisplayPrice: { primaryLine: {
    accessibilityLabel: '', price: '$400', qualifier: 'From', concatQualifierLeft: true,
  } } }).price.primary, 'From $400');
});

test('listing summary uses native presentation and explicit availability without asserting bookability', () => {
  const data = { demandStayListingData: {
    description: { stayListingId: globalId('DemandStayListing') }, personCapacity: 4, spaceType: 'ENTIRE_HOME',
    navigationPdpPresentation: { localizedLocation: 'Example City', sharingConfig: { shareUrl: 'https://www.airbnb.com/rooms/example', imageUrl: 'https://example.test/image.jpg' } },
    overviewSectionPdpPresentation: { overview: { items: ['4 guests', '2 beds'] } },
    pdpPresentation: {
      title: ugc('Example home'), quality: { isGuestFavorite: true, listingRatingStats: { overallRatingStats: { ratingAverage: 4.9, ratingCount: '9007199254740993' } } },
      bookIt: { selectedDates: 'Jan 1 – 3', availability: { isAvailable: false, canInstantBook: false, unavailabilityReason: 'DATES_UNAVAILABLE' }, structuredDisplayPrice: { primaryLine: { price: '$400', qualifier: 'for 2 nights' } } },
      amenities: { previewAmenitiesGroups: [{ amenities: [{ title: 'Wifi', available: true }] }] },
      rules: { groupItems: [{ items: [{ title: 'No smoking', description: { text: 'Including vaping' } }] }] },
      cancellationPolicy: { entries: [{ accessibilityContent: 'Server cancellation text', refundType: 'No refund', refundTerm: 'Server refund term' }] },
    }, unknown: 'preserve',
  } };
  const result = normalizeListing({ data });
  assert.equal(result.data, data);
  assert.equal(result.summary.listingId, id);
  assert.equal(result.summary.title, 'Example home');
  assert.equal(result.summary.reviewCount, '9007199254740993');
  assert.equal(result.summary.price.primary, '$400 for 2 nights');
  assert.equal(result.summary.availability.isAvailable, false);
  assert.equal(result.summary.availability.canInstantBook, false);
  assert.ok(!Object.hasOwn(result.summary, 'bookable'));
  assert.deepEqual(result.summary.amenities, [{ name: 'Wifi', available: true }]);
  assert.deepEqual(result.summary.rules, [{ title: 'No smoking', description: 'Including vaping' }]);
});

test('legacy section data remains readable even when a modern listing summary is unavailable', () => {
  const payload = { data: { presentation: { stayProductDetailPage: { sections: { sectionsV2: [{ sectionId: 'TITLE' }] } } } } };
  const result = normalizeListing(payload);
  assert.equal(result.data, payload.data);
  assert.equal(result.summary.title, null);
  assert.equal(result.summary.sectionCount, 1);
});

test('calendar summaries preserve false versus unknown flags and per-stay restrictions', () => {
  const conditions = { closedToArrival: false, closedToDeparture: false, minNights: 2, maxNights: 30 };
  const calendar = { calendarMonths: [{ listingId: id, year: 2027, month: 1,
    days: [
      { date: '2027-01-01', available: true, availableForCheckin: false, availableForCheckout: true, bookable: null, minNights: 2, maxNights: 30 },
      { date: '2027-01-02', available: false, availableForCheckin: false, availableForCheckout: false },
      { date: '2027-01-03', available: null },
    ], conditionRanges: [
      { startDate: '2027-01-01', endDate: '2027-01-01', conditions },
      { startDate: '2027-01-02', endDate: '2027-01-02', conditions },
      { startDate: '2027-01-04', endDate: '2027-01-04', conditions },
    ], unknownMonth: true,
  }], metadata: { firstBookableDay: '2027-01-01', constantMinNights: null } };
  const before = structuredClone(calendar);
  const result = normalizeCalendar({ data: { node: { pdpAvailabilityCalendar: calendar } } });
  assert.equal(result.calendar, calendar);
  const month = result.summary.months[0];
  assert.equal(month.listingId, id);
  assert.equal(month.days[0].available, true);
  assert.equal(month.days[0].availableForCheckin, false);
  assert.equal(month.days[0].bookable, null);
  assert.equal(month.days[1].available, false);
  assert.equal(month.days[2].available, null);
  assert.equal(month.restrictions.length, 2);
  assert.equal(month.restrictions[0].endDate, '2027-01-02');
  assert.equal(month.restrictions[1].startDate, '2027-01-04');
  assert.deepEqual(calendar, before);
});

test('empty and unsupported target shapes cannot become invented successful data', () => {
  for (const payload of [{ data: null }, { data: { demandStayListingData: {} } }]) assert.throws(
    () => normalizeListing(payload), error => error.code === 'LISTING_NOT_FOUND' && error.raw === payload,
  );
  assert.throws(() => normalizeCalendar({ data: { node: { pdpAvailabilityCalendar: {} } } }), { code: 'UNSUPPORTED_RESPONSE' });
  assert.throws(() => normalizeListing({ data: { presentation: { stayProductDetailPage: { sections: {} } } } }), { code: 'UNSUPPORTED_RESPONSE' });
  const calendar = { calendarMonths: [] };
  assert.deepEqual(normalizeCalendar({ data: { node: { pdpAvailabilityCalendar: calendar } } }).summary.months, []);
  const malformed = { errors: { message: 'Bad response' }, data: { demandStayListingData: { title: 'partial' } } };
  assert.throws(() => normalizeListing(malformed), error => error.code === 'UNSUPPORTED_RESPONSE' && error.raw === malformed);
});

test('future calendar conditions survive summaries and prevent unsafe range coalescing', () => {
  const calendar = { calendarMonths: [{ month: 1, year: 2027, days: [], conditionRanges: [
    { startDate: '2027-01-01', endDate: '2027-01-01', conditions: { minNights: 2, newRestriction: 'A' } },
    { startDate: '2027-01-02', endDate: '2027-01-02', conditions: { minNights: 2, newRestriction: 'B' } },
  ] }] };
  const result = normalizeCalendar({ data: { node: { pdpAvailabilityCalendar: calendar } } });
  assert.equal(result.summary.months[0].restrictions.length, 2);
  assert.equal(result.summary.months[0].restrictions[0].conditions.newRestriction, 'A');
});

test('copied filters receive the same validation as explicit options and cannot contradict currency', () => {
  for (const filters of [
    { adults: ['0'] }, { children: ['-1'] }, { checkin: ['2027-02-29'], checkout: ['2027-03-01'] },
    { checkin: ['2027-01-01'] }, { price_min: ['20'], price_max: ['10'] },
    { query: ['one', 'two'] }, { ne_lat: ['50'] }, { currency: ['not-a-currency'] }, { itemsPerGrid: ['0'] },
  ]) assert.throws(() => buildStaysSearch({ filters }), { code: 'INVALID_ARGUMENT' });
  const request = buildStaysSearch({ filters: { currency: ['eur'], adults: ['2'] } });
  assert.equal(request.currency, 'EUR');
  assert.deepEqual(request.variables.staysSearchRequest.rawParams.find(item => item.filterName === 'currency').filterValues, ['EUR']);
  assert.equal(buildStaysSearch({ filters: { currency: ['EUR'] }, currency: 'USD' }).currency, 'USD');
  for (const build of [buildAutocomplete, buildStaysSearch, buildListingDetails, buildCalendar]) {
    assert.throws(() => build(null), { code: 'INVALID_ARGUMENT' });
    assert.throws(() => build([]), { code: 'INVALID_ARGUMENT' });
  }
});
