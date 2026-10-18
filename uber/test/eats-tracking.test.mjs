import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEatsTracking,
  deliveryChanges,
  selectTrackedOrder,
} from '../src/eats/tracking.mjs';
import { createEatsTrackingReader } from '../src/eats/tracking-service.mjs';
import { runEatsCli } from '../src/eats/cli.mjs';

const workflow = '11111111-1111-4111-8111-111111111111',
  orderId = '22222222-2222-4222-8222-222222222222',
  owner = 'owner';
function native(progress = 3) {
  return {
    uuid: workflow,
    orderUUID: orderId,
    orderInfo: {
      eaterUUID: owner,
      orderPhase: 'ACTIVE',
      storeInfo: { location: { latitude: 38.5, longitude: -120.2 } },
    },
    activeOrderStatus: {
      title: '7:01–7:15 PM',
      titleSummary: { summary: { text: 'Heading your way…' } },
      currentProgress: progress,
      totalProgressSegments: 5,
      animateCurrentProgressSegment: true,
      progressColor: { color: '#05944f' },
    },
    activeOrderOverview: {
      header: { title: 'Test restaurant' },
      summary: { subtitle: 'Order #11111' },
      items: [{ title: 'Pizza', quantity: 1 }],
      total: '$20.00',
    },
    activeOrderFeed: [
      {
        payload: {
          courierPayload: {
            courierInfos: [
              {
                courierUUID: '33333333-3333-4333-8333-333333333333',
                title: 'Test Courier • PLATE',
                description: 'Delivery person',
                courierIconUrl:
                  'https://d1w2poirtb3as9.cloudfront.net/avatar.jpg?Signature=test',
              },
            ],
          },
        },
      },
      {
        payload: {
          deliveryPayload: {
            address: { formattedAddress: 'Test address' },
            deliveryType: { deliveryDescription: 'Meet at my door' },
          },
        },
      },
    ],
    analytics: {
      data: {
        order_status: 'EnrouteToDropoff',
        point_estimate_eta: '1792288677',
        latest_arrival_by: '1792289100',
        secret: 'must not escape',
      },
    },
    activeOrderCommsHub: { contacts: [{ phoneNumber: 'secret' }] },
    featureDisplay: {
      mapEntities: [
        {
          type: 'COURIER',
          location: { latitude: 38.5, longitude: -120.2 },
          marker: {
            spriteSheetUrl: 'https://duyt4h9nfnj50.cloudfront.net/car.png',
            spriteCount: 64,
          },
          routelineLegs: [{ encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }],
        },
        { type: 'EATER', location: { latitude: 43.252, longitude: -126.453 } },
      ],
    },
  };
}
const response = (o) => ({ activeEaterOrdersMobileView: o ? [o] : [] });

test('native Eats map uses server road geometry/artwork and closes the public projection', () => {
  const x = normalizeEatsTracking(native(), { now: 1000 });
  assert.equal(x.kind, 'eats');
  assert.equal(x.delivery.stage, 'on_the_way');
  assert.equal(x.routes[0].points.length, 3);
  assert.equal(
    x.driver.position.epoch,
    null,
    'receipt is not a fabricated GPS timestamp',
  );
  assert.equal(x.vehicleMapIcons.spriteDivisionCount, 64);
  assert.equal(x.delivery.eta.estimatedArrivalEpochSeconds, 1792288677);
  assert.equal(x.delivery.courier.name, 'Test Courier');
  assert.ok(!JSON.stringify(x).includes('must not escape'));
  assert.ok(!JSON.stringify(x).includes('phoneNumber'));
  assert.equal(x.delivery.dropoff.address, 'Test address');
  const multi = native();
  multi.featureDisplay.mapEntities[0].routelineLegs.push({
    encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
  });
  const joined = normalizeEatsTracking(multi);
  assert.equal(joined.routes.length, 1);
  assert.equal(joined.routes[0].points.length, 6);
  assert.ok(joined.routes[0].geometryKey);
  assert.equal(joined.routes[0].encodedPolyline, undefined);
  const invalid = native();
  invalid.featureDisplay.mapEntities[0].location.latitude = 999;
  invalid.featureDisplay.mapEntities[0].routelineLegs[0].encodedPolyline =
    'bad';
  const y = normalizeEatsTracking(invalid);
  assert.equal(y.driver.position, null);
  assert.equal(y.routes.length, 0);
});

test('native stage ordinals distinguish preparing, pickup travel, meeting and arrival; unknown layouts stay unknown', () => {
  const stages = [
    'order_received',
    'preparing',
    'courier_to_restaurant',
    'on_the_way',
    'time_to_meet_courier',
    'arrived',
  ];
  for (let i = 0; i < 6; i++) {
    const n = native(i);
    delete n.analytics;
    assert.equal(normalizeEatsTracking(n).delivery.stage, stages[i]);
  }
  const n = native(4);
  delete n.analytics;
  n.activeOrderStatus.totalProgressSegments = 9;
  assert.equal(normalizeEatsTracking(n).delivery.stage, 'active');
  n.orderFeedV2 = {
    header: {
      activeOrderStatus: {
        ...n.activeOrderStatus,
        currentProgress: 1,
        totalProgressSegments: 5,
      },
    },
  };
  assert.equal(normalizeEatsTracking(n).delivery.stage, 'preparing');
  assert.equal(
    normalizeEatsTracking(native(5)).state,
    'active',
    'arrival is not delivery completion',
  );
});

test('status/courier hooks ignore signed-photo URL renewal and do not manufacture skipped stages', () => {
  const a = normalizeEatsTracking(native());
  const n = native();
  n.activeOrderFeed[0].payload.courierPayload.courierInfos[0].courierIconUrl +=
    '2';
  const b = normalizeEatsTracking(n);
  assert.deepEqual(deliveryChanges(a, b), []);
  delete n.analytics;
  n.activeOrderStatus.currentProgress = 5;
  const c = normalizeEatsTracking(n);
  const changes = deliveryChanges(b, c);
  assert.ok(changes.some((e) => e.type === 'arrived'));
  assert.ok(
    !changes.some((e) => e.type === 'delivered' || e.type === 'preparing'),
  );
  assert.deepEqual(deliveryChanges(null, c), [
    { type: 'snapshot', stage: 'arrived' },
  ]);
});

test('tracking never switches to another active order and maintains one cursor across either native identity', async () => {
  const state = new Map();
  let orders = [native()],
    history = [];
  const reader = createEatsTrackingReader({
    read: async (key) => state.get(key),
    write: async (k, v) => state.set(k, structuredClone(v)),
    operation: async (fn) =>
      fn({
        session: { userUUID: owner },
        send: async (endpoint) =>
          endpoint.includes('active-orders')
            ? { activeEaterOrdersMobileView: orders }
            : { orders: history },
      }),
    now: () => 1000,
  });
  const a = await reader({ orderId: workflow });
  assert.equal(a.eventCursor, 1);
  const b = await reader({ orderId });
  assert.equal(b.eventCursor, 1);
  assert.equal(b.deliveryEvents[0].id, `${workflow}:1`);
  const other = native();
  other.uuid = '44444444-4444-4444-8444-444444444444';
  other.orderUUID = '55555555-5555-4555-8555-555555555555';
  orders = [other];
  const missing = await reader({ orderId });
  assert.equal(missing.state, 'unavailable');
  assert.equal(missing.tripId, workflow);
  assert.equal(missing.driver.position, null);
  history = [
    {
      uuid: workflow,
      storeName: 'Test restaurant',
      completionStatus: { completionState: 'SUCCESS' },
    },
  ];
  const ended = await reader({ orderId });
  assert.equal(ended.state, 'ended');
  assert.equal(ended.delivery.stage, 'delivered');
  assert.ok(ended.deliveryEvents.some((e) => e.type === 'delivered'));
  orders = [native()];
  const late = await reader({ orderId });
  assert.equal(late.state, 'ended');
});

test('unknown completion states cannot masquerade as delivered', async () => {
  const reader = createEatsTrackingReader({
    read: async () => null,
    write: async () => {},
    operation: async (fn) =>
      fn({
        session: { userUUID: owner },
        send: async (endpoint) =>
          endpoint.includes('active-orders')
            ? response(null)
            : {
                orders: [
                  {
                    uuid: workflow,
                    completionStatus: { completionState: 'NEW_STATE' },
                  },
                ],
              },
      }),
  });
  assert.equal((await reader({ orderId: workflow })).state, 'unavailable');
  assert.throws(
    () =>
      selectTrackedOrder(
        { activeEaterOrdersMobileView: [native(), native()] },
        workflow,
      ),
    /Ambiguous/,
  );
});

test('all native terminal history outcomes stay distinct and cached raw reads keep their envelope', async () => {
  for (const [completionState, stage] of Object.entries({
    SUCCESS: 'delivered',
    EATER_CANCELLED: 'cancelled',
    OPS_CANCELLED: 'cancelled',
    RESTAURANT_CANCELLED: 'cancelled',
    RESTAURANT_UNFULFILLED: 'failed',
    DELIVERY_FAILED: 'failed',
    COULD_NOT_FIND_EATER: 'failed',
  })) {
    const state = new Map();
    const reader = createEatsTrackingReader({
      read: async (k) => state.get(k),
      write: async (k, v) => state.set(k, v),
      operation: async (fn) =>
        fn({
          session: { userUUID: owner },
          send: async (path) =>
            path.includes('active-orders')
              ? response(null)
              : {
                  orders: [
                    { uuid: workflow, completionStatus: { completionState } },
                  ],
                },
        }),
    });
    const a = await reader({ orderId: workflow, raw: true });
    assert.equal(a.scene.delivery.stage, stage);
    assert.equal(a.native, null);
    const b = await reader({ orderId: workflow, raw: true });
    assert.equal(b.scene.state, 'ended');
    assert.equal(b.native, null);
  }
});

test('arrival remains active until history confirms success even if the completed card remains in active orders', async () => {
  const state = new Map();
  let completed = false,
    phase = 'ACTIVE';
  const reader = createEatsTrackingReader({
    read: async (k) => state.get(k),
    write: async (k, v) => state.set(k, v),
    operation: async (fn) =>
      fn({
        session: { userUUID: owner },
        send: async (endpoint) => {
          if (endpoint.includes('active-orders')) {
            const n = native(5);
            n.orderInfo.orderPhase = phase;
            return response(n);
          }
          return {
            orders: completed
              ? [
                  {
                    uuid: workflow,
                    completionStatus: {
                      completionState: 'SUCCESS',
                      completionTime: 1234,
                      privateToken: 'omit',
                    },
                  },
                ]
              : [],
          };
        },
      }),
  });
  const a = await reader({ orderId: workflow });
  assert.equal(a.state, 'active');
  assert.equal(a.delivery.stage, 'arrived');
  completed = true;
  phase = 'COMPLETED';
  const b = await reader({ orderId: workflow });
  assert.equal(b.state, 'ended');
  assert.equal(b.delivery.stage, 'delivered');
  assert.equal(b.driver.position, null);
  assert.equal(b.delivery.eta.display, null);
  assert.equal(b.delivery.completionStatus.privateToken, undefined);
});

test('tracking CLI validates lifecycle flags without accessing an account', async () => {
  const seen = [];
  const deps = {
    execute: async (c, v) => {
      seen.push(v);
      return {};
    },
    print() {},
  };
  await runEatsCli(
    [
      'track',
      '--order-id',
      workflow,
      '--action',
      'stream',
      '--duration',
      '30',
      '--after',
      '2',
    ],
    deps,
  );
  assert.equal(seen[0].after, '2');
  for (const args of [
    ['--action', 'snapshot', '--duration', '30'],
    ['--action', 'serve', '--raw'],
    ['--action', 'stream', '--host', '0.0.0.0'],
    ['--action', 'stream', '--after', '-1'],
    ['--action', 'bad'],
  ])
    await assert.rejects(
      runEatsCli(['track', '--order-id', workflow, ...args], deps),
    );
  assert.equal(seen.length, 1);
});
