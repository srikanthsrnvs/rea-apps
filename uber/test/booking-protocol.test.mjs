import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  legacyBookingRequest,
  selfParticipantSpecs,
  normalizeBookingResult,
} from '../src/booking-protocol.mjs';

const fixture = () => ({
  from: '1,2',
  to: '3,4',
  via: ['2,3'],
  vehicleViewId: 125,
  paymentProfileId: randomUUID(),
  jobId: randomUUID(),
  userProfile: { id: randomUUID(), type: 'PERSONAL' },
  variant: {
    vehicleViewId: 125,
    pricingInfo: {
      fareInfo: {
        upfrontFare: {
          vehicleViewId: 125,
          fare: '12.30',
          currencyCode: 'USD',
          uuid: randomUUID(),
          originLat: 1,
          originLng: 2,
          destinationLat: 3,
          destinationLng: 4,
          signature: {
            signature: 'synthetic-signature',
            expiresAt: 2000000000,
          },
        },
      },
    },
  },
});

test('booking carries the exact signed fare, explicit card and native location wrappers', () => {
  const input = fixture(),
    body = legacyBookingRequest(input);
  assert.deepEqual(
    body.upfrontFare,
    input.variant.pricingInfo.fareInfo.upfrontFare,
  );
  assert.notEqual(
    body.upfrontFare,
    input.variant.pricingInfo.fareInfo.upfrontFare,
  );
  assert.equal(body.paymentProfileUUID, input.paymentProfileId);
  assert.equal(body.jobUUID, input.jobId);
  assert.equal(body.profileType, 'Personal');
  assert.deepEqual(body.requestPickupLocation, {
    locationSource: 'Manual',
    rendezvousLocation: { latitude: 1, longitude: 2 },
    targetLocation: { latitude: 1, longitude: 2 },
  });
  assert.deepEqual(body.requestViaLocations[0].targetLocation, {
    latitude: 2,
    longitude: 3,
  });
  for (const key of [
    'timestamp',
    'transactionId',
    'paymentProfileId',
    'fareUuid',
    'doTrustedBypass',
    'doArrearsBypass',
  ])
    assert.equal(Object.hasOwn(body, key), false);
});

test('booking refuses unsigned or mismatched fare and invalid identifiers/route', () => {
  const a = fixture();
  delete a.variant.pricingInfo.fareInfo.upfrontFare.signature;
  assert.throws(() => legacyBookingRequest(a), /signed/);
  const b = fixture();
  b.vehicleViewId = 126;
  assert.throws(() => legacyBookingRequest(b), /vehicle/);
  assert.throws(
    () => legacyBookingRequest({ ...fixture(), paymentProfileId: 'card' }),
    /UUID/,
  );
  assert.throws(
    () => legacyBookingRequest({ ...fixture(), from: '91,2' }),
    /range/,
  );
  assert.throws(
    () =>
      legacyBookingRequest({
        ...fixture(),
        userProfile: { id: randomUUID(), type: 'BUSINESS' },
      }),
    /Personal/,
  );
});

test('participants use actual user/profile identities and native role discriminators', () => {
  const f = fixture(),
    riderId = randomUUID(),
    body = selfParticipantSpecs({
      riderId,
      paymentProfileId: f.paymentProfileId,
      userProfile: f.userProfile,
    });
  assert.deepEqual(body[0].participantID, { type: 'userID', userID: riderId });
  assert.deepEqual(body[0].roles[0].payer, {
    paymentProfile: { id: f.paymentProfileId },
    userProfile: f.userProfile,
  });
  assert.deepEqual(body[0].roles[1], { type: 'consumer', consumer: {} });
  assert.throws(
    () => selfParticipantSpecs({ riderId, paymentProfileId: 'invalid' }),
    /UUID/,
  );
});

test('legacy result requires a concrete trip ID and preserves pending payment status', () => {
  const tripId = randomUUID(),
    orderId = randomUUID();
  assert.deepEqual(
    normalizeBookingResult({
      trip: {
        uuid: tripId,
        fulfillmentOrderId: { uuid: orderId },
        isPendingPaymentConfirmation: true,
      },
    }),
    {
      tripId,
      orderId,
      fulfillmentOrderId: orderId,
      currentState: null,
      requiresCheckout: true,
    },
  );
  for (const body of [
    {},
    { checkoutActionParameters: {} },
    { trip: { uuid: 'malformed' } },
    { draftOrderUUID: randomUUID() },
  ])
    assert.throws(() => normalizeBookingResult(body), /trip ID/);
});

test('modern single transport result extracts server state and rejects conflicting IDs', () => {
  const tripId = randomUUID(),
    orderId = randomUUID(),
    body = {
      singleRiderAppOrderResponse: {
        order: {
          id: orderId,
          state: 'REQUESTED',
          jobs: { singlePersonalTransport: { transport: { id: tripId } } },
        },
      },
    };
  assert.deepEqual(normalizeBookingResult(body), {
    tripId,
    orderId,
    fulfillmentOrderId: orderId,
    currentState: 'REQUESTED',
    requiresCheckout: false,
  });
  assert.throws(
    () => normalizeBookingResult({ ...body, trip: { uuid: randomUUID() } }),
    /conflicting/,
  );
});
