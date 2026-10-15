import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectBookingProduct,
  validateSignedFare,
} from '../src/booking-selection.mjs';
const fare = { variantId: 'variant' };
const product = {
  name: 'UberX',
  vehicleViewId: 125,
  availability: 'AVAILABLE',
  reservationOnly: false,
  fare,
  fareVariants: [fare],
};
test('car selection refuses ambiguity, unavailable cars and unspecified fare variants', () => {
  assert.equal(
    selectBookingProduct({ products: [product] }, { product: 'uberx' }).product
      .vehicleViewId,
    125,
  );
  assert.throws(
    () =>
      selectBookingProduct(
        { products: [product, product] },
        { product: 'UberX' },
      ),
    /ambiguous/,
  );
  assert.throws(
    () =>
      selectBookingProduct(
        { products: [{ ...product, availability: 'UNAVAILABLE' }] },
        { vehicleViewId: 125 },
      ),
    /not available/,
  );
  assert.throws(
    () =>
      selectBookingProduct(
        { products: [{ ...product, fare: null }] },
        { vehicleViewId: 125 },
      ),
    /Fare selection/,
  );
  assert.equal(
    selectBookingProduct(
      { products: [{ ...product, fare: null }] },
      { vehicleViewId: 125, variantId: 'variant' },
    ).fare.variantId,
    'variant',
  );
});
test('signed price must match the car, exact itinerary and unexpired server signature', () => {
  const upfront = {
    fare: '31.94',
    currencyCode: 'USD',
    vehicleViewId: 125,
    originLat: 33,
    originLng: -118,
    destinationLat: 34,
    destinationLng: -119,
    viaLocations: [{ latitude: 33.5, longitude: -118.5 }],
    signature: { signature: 'server-signed', expiresAt: 200 },
  };
  const variant = { pricingInfo: { fareInfo: { upfrontFare: upfront } } };
  const route = {
    from: '33,-118',
    to: '34,-119',
    via: ['33.5,-118.5'],
    vehicleViewId: 125,
    now: 100000,
  };
  assert.equal(validateSignedFare(variant, route).amount, '31.94');
  assert.throws(
    () => validateSignedFare(variant, { ...route, vehicleViewId: 126 }),
    /selected car/,
  );
  assert.throws(
    () => validateSignedFare(variant, { ...route, to: '35,-119' }),
    /requested route/,
  );
  assert.throws(
    () => validateSignedFare(variant, { ...route, via: [] }),
    /intermediate/,
  );
  assert.throws(
    () => validateSignedFare(variant, { ...route, now: 199000 }),
    /expiry/,
  );
  assert.throws(
    () =>
      validateSignedFare(
        {
          pricingInfo: {
            fareInfo: {
              upfrontFare: { ...upfront, signature: { expiresAt: 200 } },
            },
          },
        },
        route,
      ),
    /signature/,
  );
});
