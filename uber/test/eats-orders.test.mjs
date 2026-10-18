import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEatsHistory,
  normalizeEatsActiveOrders,
} from '../src/eats/orders.mjs';

test('history retains exact order/item identity, fulfillment and authoritative total', () => {
  const result = normalizeEatsHistory({
    orders: [
      {
        uuid: 'native-order',
        displayId: 'ABCDE',
        storeName: 'Example restaurant',
        store: { uuid: 'store' },
        diningMode: 'PICKUP',
        fulfillmentType: 'PICKUP',
        completionStatus: {
          completionState: 'SUCCESS',
          completionTime: 1700000000000,
        },
        currencyCode: 'USD',
        checkoutInfo: [
          { key: 'eats_fare.subtotal', rawValue: 20 },
          { key: 'eats_fare.total', rawValue: 24.19, value: '$24.19' },
        ],
        items: [
          {
            uuid: 'item',
            shoppingCartItemUuid: 'line',
            sectionUuid: 'section',
            subsectionUuid: 'subsection',
            title: 'Coffee',
            quantity: 2,
            price: 1000,
            isOrderable: false,
            customizationV2s: [
              {
                uuid: 'milk',
                childOptions: { options: [{ uuid: 'whole', quantity: 1 }] },
              },
            ],
          },
        ],
        customerInfo: { phone: 'private' },
        actions: [{ actionType: 'HELP' }],
      },
    ],
    paginationData: { nextCursor: 'opaque/+==' },
  });
  const order = result.orders[0];
  assert.equal(order.orderId, 'native-order');
  assert.equal(order.storeId, 'store');
  assert.equal(order.items[0].itemId, 'item');
  assert.equal(order.items[0].lineId, 'line');
  assert.equal(order.items[0].sectionId, 'section');
  assert.equal(order.items[0].subsectionId, 'subsection');
  assert.equal(order.diningMode, 'PICKUP');
  assert.equal(order.items[0].isOrderable, false);
  assert.deepEqual(order.total, {
    amount: 24.19,
    formatted: '$24.19',
    currency: 'USD',
  });
  assert.equal(order.completionStatus.completionState, 'SUCCESS');
  assert.equal(result.nextCursor, 'opaque/+==');
  assert.equal(order.customerInfo, undefined);
  assert.equal(order.actions, undefined);
});

test('history never invents a total by summing items and preserves native completion state', () => {
  const result = normalizeEatsHistory({
    orders: [
      {
        uuid: 'one',
        items: [{ uuid: 'item', title: 'Meal', price: 1200, quantity: 3 }],
        completionStatus: { completionState: 'NATIVE_FUTURE_STATE' },
      },
      {
        uuid: 'two',
        currencyCode: 'EUR',
        items: [],
        checkoutInfo: [
          { key: 'eats_fare.total', rawValue: 1 },
          { key: 'eats_fare.total', rawValue: 2 },
        ],
      },
    ],
  });
  assert.equal(result.orders[0].total, undefined);
  assert.equal(
    result.orders[0].completionStatus.completionState,
    'NATIVE_FUTURE_STATE',
  );
  assert.equal(result.orders[1].total, undefined);
  assert.equal(result.nextCursor, undefined);
});

test('history selections remain recursive isolated copies and legacy options are not relabeled', () => {
  const response = {
    orders: [
      {
        uuid: 'one',
        items: [
          {
            uuid: 'item',
            customizationsV2: [
              {
                uuid: 'group',
                childOptions: {
                  options: [
                    {
                      uuid: 'option',
                      customizationV2List: [
                        { uuid: 'child', extraConstraint: { retain: true } },
                      ],
                    },
                  ],
                },
              },
            ],
          },
          { uuid: 'legacy', customizations: [{ uuid: 'old', options: [] }] },
        ],
      },
    ],
  };
  const result = normalizeEatsHistory(response);
  assert.deepEqual(
    result.orders[0].items[0].customizationV2s,
    response.orders[0].items[0].customizationsV2,
  );
  result.orders[0].items[0].customizationV2s[0].uuid = 'changed';
  assert.equal(response.orders[0].items[0].customizationsV2[0].uuid, 'group');
  assert.deepEqual(result.orders[0].items[1].customizations, [
    { uuid: 'old', options: [] },
  ]);
  assert.equal(result.orders[0].items[1].customizationV2s, undefined);
  response.orders[0].items[1].customizationV2s = null;
  response.orders[0].items[1].customizationsV2 = null;
  assert.deepEqual(
    normalizeEatsHistory(response).orders[0].items[1].customizations,
    [{ uuid: 'old', options: [] }],
  );
});

test('active orders preserve native identities and status blocks while omitting UI feeds', () => {
  const response = {
    activeEaterOrdersMobileView: [
      {
        uuid: 'native-uuid',
        orderUUID: 'order-id',
        orderInfo: { orderPhase: 'SERVER_PHASE', unknownField: { keep: true } },
        activeOrderStatus: {
          text: 'Restaurant is preparing your order',
          futurePhase: 'unknown',
        },
        activeOrderOverview: { title: 'Example meal', eta: { text: '20 min' } },
        orderPickupDetails: { instructions: 'Front counter' },
        activeOrderFeed: [{ hugeUi: true }],
        analytics: { private: true },
      },
    ],
  };
  const result = normalizeEatsActiveOrders(response);
  assert.equal(result.activeOrderCount, 1);
  assert.equal(result.orders[0].orderId, 'order-id');
  assert.equal(result.orders[0].uuid, 'native-uuid');
  assert.equal(result.orders[0].orderUUID, 'order-id');
  assert.deepEqual(
    result.orders[0].orderInfo,
    response.activeEaterOrdersMobileView[0].orderInfo,
  );
  assert.deepEqual(
    result.orders[0].activeOrderStatus,
    response.activeEaterOrdersMobileView[0].activeOrderStatus,
  );
  assert.equal(result.orders[0].activeOrderFeed, undefined);
  assert.equal(result.orders[0].analytics, undefined);
  assert.equal(
    result.orders[0].state,
    undefined,
    'no inferred state is fabricated',
  );
  result.orders[0].orderInfo.unknownField.keep = false;
  assert.equal(
    response.activeEaterOrdersMobileView[0].orderInfo.unknownField.keep,
    true,
  );
});

test('explicit empty arrays are valid and changed response roots fail visibly', () => {
  assert.deepEqual(
    normalizeEatsActiveOrders({ activeEaterOrdersMobileView: [] }),
    { orders: [], activeOrderCount: 0 },
  );
  assert.deepEqual(
    normalizeEatsHistory({ orders: [], paginationData: { nextCursor: null } }),
    { orders: [], nextCursor: null },
  );
  for (const response of [
    {},
    { activeEaterOrdersMobileView: null },
    { activeEaterOrdersMobileView: [{}] },
  ])
    assert.throws(() => normalizeEatsActiveOrders(response), {
      code: 'EATS_RESPONSE_INVALID',
    });
  for (const response of [
    {},
    { orders: null },
    { orders: [{}] },
    { orders: [], paginationData: { nextCursor: 5 } },
  ])
    assert.throws(() => normalizeEatsHistory(response), {
      code: 'EATS_RESPONSE_INVALID',
    });
});
