import test from 'node:test';
import assert from 'node:assert/strict';
import { cancellationInfoRequest, riderCancelRequest, normalizeCancellationInfo, normalizeTripStatus } from '../src/cancellation-protocol.mjs';

test('cancellation builders omit optional fields and preserve server reason strings', () => {
  assert.deepEqual(cancellationInfoRequest(), {});
  assert.deepEqual(cancellationInfoRequest({ reasonId: 'reason-example' }), { reasonId: 'reason-example' });
  assert.deepEqual(riderCancelRequest(), {});
  assert.deepEqual(riderCancelRequest({ reason: 'reason-example', refundStrategy: 'ORIGINAL_PAYMENT_METHOD', fulfillmentOrderId: 'order-example', comment: 'Example comment' }), {
    reason: 'reason-example', refundStrategy: 'ORIGINAL_PAYMENT_METHOD', fulfillmentOrderId: { uuid: 'order-example' }, cancellationInput: { comment: 'Example comment' },
  });
  assert.throws(() => riderCancelRequest({ refundStrategy: 'UNKNOWN' }), /refund/);
  assert.throws(() => riderCancelRequest({ reason: '' }), /nonempty/);
  assert.throws(() => riderCancelRequest({ comment: 1 }), /nonempty/);
});

test('tracking keeps fulfillment order IDs separate from legacy-compatible trip IDs', () => {
  const order = { id: 'order-example', state: 'IN_PROGRESS', jobs: { singlePersonalTransport: { transport: { id: 'trip-example' } } } };
  const summary = normalizeTripStatus({ clientStatus: { status: 'on_trip' }, riderAppOrdersResponse: { orders: [order] }, singleRiderAppOrderResponse: { order }, fulfillmentStateData: { orders: [{ orderId: { uuid: 'order-example' } }] } });
  assert.equal(summary.activeOrderCount, 1);
  assert.deepEqual(summary.orders[0].cancellation, { tripId: 'trip-example', fulfillmentOrderId: 'order-example' });
  assert.deepEqual(normalizeTripStatus({ fulfillmentStateData: { orders: [] } }).orders, []);
  assert.equal(normalizeTripStatus({ fulfillmentStateData: { orders: [{ orderId: { uuid: 'legacy-example' } }] } }).orders[0].tripId, null);
  assert.equal(normalizeTripStatus({ fulfillmentStateData: { orders: [{ orderId: { uuid: 'legacy-example' }, orderPlan: { jobs: [{ legacyTripData: { trip: { uuid: 'legacy-trip' } } }] } }] } }).orders[0].tripId, 'legacy-trip');
  assert.equal(normalizeTripStatus({ response: { order } }).orders[0].tripId, 'trip-example');
  assert.throws(() => normalizeTripStatus({}), /Unrecognized/);
});

test('multiple-job tracking honors the explicit backwards-compatible primary job', () => {
  const summary = normalizeTripStatus({ riderAppOrdersResponse: { orders: [{ id: 'multi-example', jobs: { multiplePersonalTransport: {
    transportJobs: [{ id: 'trip-a' }, { id: 'trip-b' }], backwardsCompatibleSinglePersonalTransportJobID: 'trip-b',
  } } }] } });
  assert.equal(summary.orders[0].tripId, 'trip-b');
  assert.deepEqual(summary.orders[0].tripIds, ['trip-a', 'trip-b']);
});

test('preview distinguishes charged, waived, and unknown fees without guessing amounts', () => {
  assert.equal(normalizeCancellationInfo({ chargeFee: true, messages: ['Example fee notice'] }).chargeFee, true);
  assert.equal(normalizeCancellationInfo({ chargeFee: false }).chargeFee, false);
  const unknown = normalizeCancellationInfo({ title: 'Example', messages: ['Read details', null], refundSpec: { eligibleRefundOptions: [{ refundStrategy: 'UBER_CASH', title: 'Cash', body: 'Example' }] } });
  assert.equal(unknown.chargeFee, null);
  assert.deepEqual(unknown.messages, ['Read details']);
  assert.equal(unknown.refundOptions[0].refundStrategy, 'UBER_CASH');
  assert.equal(unknown.warnings.length, 1);
  assert.throws(() => normalizeCancellationInfo({}), /Unrecognized/);
});
