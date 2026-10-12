import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuotes, legacyFareRequest } from '../src/quotes.mjs';

function fixture() {
  return { response: { fullResponse: {
    shoppingOrders: [{
      id: 'order-example',
      presentation: { displayName: 'Example Ride', detailedDescription: 'A test product' },
      eligibility: { availability: 'UNAVAILABLE' },
      jobs: { type: 'singleTransport', singleTransport: { transportJob: { productContext: {
        productTypeID: 'product-example',
        presentation: { productDisplayName: 'Fallback name', detailedProductDescription: 'Fallback description' },
        properties: { maxPassengerSeats: 4, isSchedulable: false, isReservationOnly: true },
        legacy: { vehicleViewID: 42 },
      } } } },
    }],
    features: {
      orderSelection: { orderGroups: [{ titleText: 'Example group', shoppingOrderIDs: ['order-example'] }] },
      configurations: { configurations: { 'order-example': { focusView: { value: { data: {
        faresList: { options: [{ title: { value: { styledString: { sourceString: {
          value: { conditional: { trueBinding: { value: { element: {
            typeIdentifier: 'example.binding', elementData: 'Unresolved fare expression',
          } } } } },
        } } } } }] },
      } } } } } },
    },
  } } };
}

test('summarizes products while preserving unavailable state and avoiding invented fares', () => {
  const input = fixture();
  const original = structuredClone(input);
  const result = normalizeQuotes(input);
  assert.deepEqual(result.products, [{
    orderId: 'order-example', productId: 'product-example', vehicleViewId: 42, name: 'Example Ride',
    description: 'A test product', availability: 'UNAVAILABLE', passengerCapacity: 4,
    schedulable: false, reservationOnly: true, groups: ['Example group'], fare: null, fareVariants: [], pickupEta: null,
  }]);
  assert.equal(result.productCount, 1);
  assert.match(result.warnings[0], /Fare amounts require a separate fare-estimate/);
  assert.deepEqual(input, original);
});

test('accepts captured and unwrapped responses and falls back to product presentation', () => {
  const input = fixture();
  delete input.response.fullResponse.shoppingOrders[0].presentation;
  const expected = normalizeQuotes(input);
  assert.equal(expected.products[0].name, 'Fallback name');
  assert.deepEqual(normalizeQuotes({ status: 200, body: input }), expected);
  assert.deepEqual(normalizeQuotes(input.response.fullResponse), expected);
});

test('keeps unknown fields null, zero capacity intact, and group memberships unique', () => {
  const input = fixture().response.fullResponse;
  input.shoppingOrders.push({ id: 'unknown-order', jobs: { type: 'unrecognizedVariant' } }, null);
  const properties = input.shoppingOrders[0].jobs.singleTransport.transportJob.productContext.properties;
  properties.maxPassengerSeats = 0;
  input.features.orderSelection.orderGroups.push({ titleText: 'Example group', shoppingOrderIDs: ['order-example'] });
  const result = normalizeQuotes(input);
  assert.equal(result.productCount, 2);
  assert.equal(result.products[0].passengerCapacity, 0);
  assert.deepEqual(result.products[0].groups, ['Example group']);
  assert.equal(result.products[1].availability, null);
  assert.equal(result.products[1].name, null);
  assert.equal(result.products[1].passengerCapacity, null);
  assert.match(result.warnings.at(-1), /Skipped 1 malformed/);
});

function fareFixture() {
  return { packageVariants: [
    { vehicleViewId: 42, productUuid: 'product-example', isDefault: true, pricingInfo: {
      packageVariantUuid: 'variant-default', primaryFare: '$12.30', finalPrice: { defaultText: '$12.30' },
      fareInfo: { upfrontFare: { fare: '12.30', currencyCode: 'USD', vehicleViewId: 42, signature: {
        expiresAt: 2000000000, signature: 'private-signature-not-for-summary',
      } }, metadata: { formattedFare: '$12.30' } },
    }, featureSet: [{ featureData: { etd: { estimatedTripTime: 600, etdDisplayString: '10 minutes' } } }] },
    { vehicleViewId: 42, productUuid: 'product-example', isDefault: false, pricingInfo: {
      packageVariantUuid: 'variant-alternate', fareInfo: { upfrontFare: { fare: '10.00', currencyCode: 'USD' } },
    } },
    { vehicleViewId: 99, productUuid: 'unmatched-product', isDefault: true, pricingInfo: {
      fareInfo: { upfrontFare: { fare: '25.00', currencyCode: 'USD' } },
    } },
  ] };
}

test('preserves exact decimal price strings, default and alternate variants, and unmatched fares', () => {
  const fares = fareFixture();
  const result = normalizeQuotes(fixture(), fares);
  assert.equal(result.fareVariantCount, 3);
  assert.equal(result.pricedVariantCount, 3);
  assert.equal(result.products[0].fare.amount, '12.30');
  assert.equal(result.products[0].fare.expiresAt, 2000000000);
  assert.deepEqual(result.products[0].fareVariants.map(value => value.amount), ['12.30', '10.00']);
  assert.deepEqual(result.products[0].fare.tripTime, { estimatedTripTime: 600, display: '10 minutes' });
  assert.equal(result.products[0].pickupEta, null);
  assert.equal(result.unmatchedFareVariants[0].vehicleViewId, 99);
  assert.ok(!JSON.stringify(result).includes('private-signature-not-for-summary'));
  assert.deepEqual(normalizeQuotes(fixture(), { body: fares }), result);
});

test('does not pick an ambiguous fare and reports missing or unmatched prices honestly', () => {
  const fares = fareFixture();
  fares.packageVariants[0].isDefault = false;
  const result = normalizeQuotes(fixture(), fares);
  assert.equal(result.products[0].fare, null);
  assert.equal(result.products[0].fareVariants.length, 2);
  const missing = normalizeQuotes(fixture(), { packageVariants: [{ vehicleViewId: 42 }] });
  assert.equal(missing.products[0].fare.amount, null);
  assert.equal(missing.pricedVariantCount, 0);
  assert.match(missing.warnings.join(' '), /no matching fare with a price/);
  assert.throws(() => normalizeQuotes(fixture(), {}), /Unrecognized fare response/);
});

test('legacy request keeps intermediate locations in order and reuses coordinate validation', () => {
  assert.deepEqual(legacyFareRequest('10,20', '11,21', ['10.25,20.25', '10.5,20.5'], [42, 42, 99]), {
    pickupLocation: { latitude: 10, longitude: 20 },
    destination: { latitude: 11, longitude: 21 },
    viaLocations: [{ latitude: 10.25, longitude: 20.25 }, { latitude: 10.5, longitude: 20.5 }],
    vehicleViewIds: [42, 99],
  });
  assert.ok(!('viaLocations' in legacyFareRequest('10,20', '11,21')));
  for (const coordinates of ['91,0', '0,181', '1,', '1,2,3']) {
    assert.throws(() => legacyFareRequest(coordinates, '10,20'));
    assert.throws(() => legacyFareRequest('10,20', '11,21', [coordinates]));
  }
  for (const ids of [[-1], ['42'], [1.5], null]) assert.throws(() => legacyFareRequest('10,20', '11,21', [], ids));
});

test('distinguishes an empty catalog from a schema mismatch or unsupported delta response', () => {
  assert.equal(normalizeQuotes({ shoppingOrders: [] }).productCount, 0);
  for (const value of [null, {}, { response: { deltaResponse: {} } }, { shoppingOrders: {} }]) {
    assert.throws(() => normalizeQuotes(value), /Unrecognized shopping response/);
  }
});
