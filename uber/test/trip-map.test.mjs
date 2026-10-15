import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTripMap,
  normalizeSharedTripMap,
  decodePolyline,
  getTripMap,
} from '../src/trip-map.mjs';

// Synthetic fixtures follow retained Trip/VehiclePathPoint and modern MOP serializers.
// They are protocol tests, not a live assigned-driver capture.
const tripId = '11111111-1111-4111-8111-111111111111';
const otherTripId = '22222222-2222-4222-8222-222222222222';
const orderId = '33333333-3333-4333-8333-333333333333';
const waypointId = '44444444-4444-4444-8444-444444444444';
const encoded = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const now = 1800000000000;
const path = [
  {
    latitude: 38.5,
    longitude: -120.2,
    course: 45,
    epoch: now - 2000,
    speed: 2,
  },
  {
    latitude: 38.501,
    longitude: -120.201,
    course: 90,
    epoch: now - 1000,
    speed: 3,
  },
];
function legacy(overrides = {}) {
  const trip = {
    uuid: tripId,
    pickupLocation: {
      latitude: 38.5,
      longitude: -120.2,
      title: 'Fixture pickup',
    },
    destination: { latitude: 40.7, longitude: -120.95 },
    currentRoute: encoded,
    legs: [{ encodedPolyline: encoded, locationEndRef: 'fixture-location' }],
    vehicle: {
      vehiclePath: structuredClone(path),
      licensePlate: 'PRIVATE_PLATE',
    },
    driver: {
      status: 'Accepted',
      phone: 'PRIVATE_PHONE',
      name: 'PRIVATE_NAME',
    },
    eta: 3,
    etaString: '3 min',
    ...overrides,
  };
  return {
    clientStatus: { status: 'Accepted' },
    metadata: { pollingIntervalMs: 8000 },
    fulfillmentStateData: {
      orders: [
        {
          orderId: { uuid: orderId },
          orderPlan: { jobs: [{ legacyTripData: { trip } }] },
        },
      ],
    },
    payment: { card: 'PRIVATE_CARD' },
    token: 'PRIVATE_TOKEN',
  };
}
function modern() {
  return {
    clientStatus: { status: 'Accepted' },
    metadata: { pollingIntervalMs: 4000 },
    riderAppOrdersResponse: {
      orders: [
        {
          id: orderId,
          state: 'IN_PROGRESS',
          jobs: {
            singlePersonalTransport: {
              transport: {
                id: tripId,
                provider: { vehicle: { vehiclePath: structuredClone(path) } },
                waypoints: [
                  {
                    transportJobWaypointType: {
                      pickupWaypointView: {
                        uuid: waypointId,
                        location: {
                          location: { latitude: 38.5, longitude: -120.2 },
                        },
                        stateInfo: { state: 'IN_PROGRESS' },
                      },
                    },
                  },
                  {
                    transportJobWaypointType: {
                      dropoffWaypointView: {
                        location: {
                          location: { latitude: 40.7, longitude: -120.95 },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      ],
      features: {
        [orderId]: {
          mapRoutelineFeature: {
            encodedProviderPolyline: encoded,
            legs: [
              {
                uuid: waypointId,
                entityRef: 'fixture-entity',
                encodedPolyline: encoded,
              },
            ],
            vehicleMapIconUrl: 'https://example.uber.com/car.png',
          },
        },
      },
    },
  };
}

test('bounded polyline decoder returns actual delta geometry', () => {
  assert.deepEqual(decodePolyline(encoded), [
    { lat: 38.5, lon: -120.2 },
    { lat: 40.7, lon: -120.95 },
    { lat: 43.252, lon: -126.453 },
  ]);
  assert.deepEqual(decodePolyline(''), []);
});
test('decoder rejects malformed, unfinished, overflowing and oversized geometry', () => {
  for (const value of [
    '?',
    String.fromCharCode(10),
    '~'.repeat(20),
    '~~~~~~?~~~~~~?',
  ])
    assert.throws(() => decodePolyline(value));
  assert.throws(() => decodePolyline(encoded, { maxPoints: 2 }), {
    code: 'MAP_LIMIT_EXCEEDED',
  });
  assert.throws(() => decodePolyline('a'.repeat(200001)), {
    code: 'INVALID_POLYLINE',
  });
});
test('idle response emits no invented driver, route, or pickup', () => {
  const scene = normalizeTripMap(
    {
      clientStatus: { status: 'Looking' },
      fulfillmentStateData: { orders: [] },
      metadata: { pollingIntervalMs: 8000 },
    },
    { now },
  );
  assert.equal(scene.state, 'idle');
  assert.equal(scene.pollingIntervalMs, 8000);
  assert.equal(scene.driver.position, null);
  assert.deepEqual(scene.waypoints, []);
  assert.deepEqual(scene.routes, []);
});
test('legacy trip projects route and timestamped car path without private data', () => {
  const scene = normalizeTripMap(legacy(), { now });
  assert.equal(scene.state, 'active');
  assert.equal(scene.tripId, tripId);
  assert.equal(scene.fulfillmentOrderId, orderId);
  assert.equal(scene.driver.position.epoch, now - 1000);
  assert.equal(scene.driver.position.course, 90);
  assert.equal(scene.driver.positionAgeMs, 1000);
  assert.equal(scene.driver.path.length, 2);
  assert.equal(scene.routes[0].points.length, 3);
  assert.equal(scene.eta.pickupMinutes, null);
  assert.equal(scene.eta.display, '3 min');
  assert.deepEqual(
    scene.waypoints.map((w) => w.kind),
    ['pickup', 'dropoff'],
  );
  assert.equal(JSON.stringify(scene).includes('PRIVATE_'), false);
});
test('dispatching is explicit and never manufactures an assigned car', () => {
  const raw = legacy({ vehicle: null, driver: null });
  raw.clientStatus.status = 'Dispatching';
  const scene = normalizeTripMap(raw, { now });
  assert.equal(scene.state, 'dispatching');
  assert.equal(scene.driver.position, null);
  assert.ok(scene.warnings.length);
});
test('modern snapshot follows exact transport and mapRoutelineFeature paths', () => {
  const scene = normalizeTripMap(modern(), { now });
  assert.equal(scene.tripId, tripId);
  assert.equal(scene.driver.source, 'transport_provider_vehicle_path');
  assert.equal(scene.driver.position.course, 90);
  assert.equal(scene.routes[0].kind, 'provider');
  assert.equal(scene.vehicleMapIconUrl, 'https://example.uber.com/car.png');
  assert.deepEqual(
    scene.waypoints.map((w) => [w.kind, w.lat, w.lon]),
    [
      ['pickup', 38.5, -120.2],
      ['dropoff', 40.7, -120.95],
    ],
  );
});
test('same modern and legacy trip merges without becoming ambiguous', () => {
  const raw = { ...legacy(), ...modern() };
  const scene = normalizeTripMap(raw, { now });
  assert.equal(scene.tripId, tripId);
  assert.equal(scene.eta.display, '3 min');
  assert.equal(scene.source, 'modern_status');
});
test('single modern order features are scoped directly to that order', () => {
  const raw = modern();
  raw.singleRiderAppOrderResponse = {
    order: raw.riderAppOrdersResponse.orders[0],
    features: raw.riderAppOrdersResponse.features[orderId],
  };
  delete raw.riderAppOrdersResponse;
  assert.equal(
    normalizeTripMap(raw, { now }).vehicleMapIconUrl,
    'https://example.uber.com/car.png',
  );
});
test('multiple simultaneous trips require explicit exact selection', () => {
  const raw = modern();
  raw.riderAppOrdersResponse.orders.push({
    id: '55555555-5555-4555-8555-555555555555',
    state: 'IN_PROGRESS',
    jobs: { singlePersonalTransport: { transport: { id: otherTripId } } },
  });
  assert.throws(() => normalizeTripMap(raw, { now }), {
    code: 'AMBIGUOUS_TRIP',
  });
  assert.equal(
    normalizeTripMap(raw, { tripId: otherTripId, now }).tripId,
    otherTripId,
  );
  assert.throws(
    () =>
      normalizeTripMap(raw, {
        tripId: '66666666-6666-4666-8666-666666666666',
        now,
      }),
    { code: 'TRIP_NOT_FOUND' },
  );
});
test('unsupported active job never silently becomes idle', () => {
  const raw = {
    riderAppOrdersResponse: {
      orders: [{ id: orderId, jobs: { unsupported: {} } }],
    },
  };
  assert.equal(normalizeTripMap(raw, { now }).state, 'unknown');
});
test('malformed coordinate points and invalid polylines are omitted explicitly', () => {
  const raw = legacy({
    currentRoute: '?',
    legs: [],
    vehicle: {
      vehiclePath: [{ latitude: 999, longitude: -120.2, epoch: now }, ...path],
    },
  });
  const scene = normalizeTripMap(raw, { now });
  assert.equal(scene.driver.path.length, 2);
  assert.equal(scene.routes.length, 0);
  assert.equal(scene.warnings.length, 2);
});
test('path preserves source order and selects latest observed timestamp, not future prediction', () => {
  const raw = legacy({
    vehicle: {
      vehiclePath: [path[1], { ...path[0], epoch: now + 10000 }, path[0]],
    },
  });
  const scene = normalizeTripMap(raw, { now });
  assert.equal(scene.driver.path[0].epoch, now - 1000);
  assert.equal(scene.driver.position.epoch, now - 1000);
});
test('untimestamped or all-future paths are not labelled current car position', () => {
  const noEpoch = normalizeTripMap(
    legacy({
      vehicle: { vehiclePath: [{ latitude: 38.5, longitude: -120.2 }] },
    }),
    { now },
  );
  assert.equal(noEpoch.driver.position, null);
  const future = normalizeTripMap(
    legacy({ vehicle: { vehiclePath: [{ ...path[0], epoch: now + 10000 }] } }),
    { now },
  );
  assert.equal(future.driver.position, null);
});
test('terminal client status suppresses a stale live car marker', () => {
  const raw = legacy();
  raw.clientStatus.status = 'ClientCanceled';
  assert.equal(normalizeTripMap(raw, { now }).state, 'ended');
  assert.equal(normalizeTripMap(raw, { now }).driver.position, null);
});
test('plain string URLs cannot inject local or executable marker schemes', () => {
  const raw = modern();
  raw.riderAppOrdersResponse.features[
    orderId
  ].mapRoutelineFeature.vehicleMapIconUrl = 'javascript:bad';
  assert.equal(normalizeTripMap(raw, { now }).vehicleMapIconUrl, null);
});
test('response selection and timestamp validation fail clearly', () => {
  assert.throws(() => normalizeTripMap({ unexpected: true }, { now }), {
    code: 'UNSUPPORTED_MAP_RESPONSE',
  });
  assert.throws(() => normalizeTripMap(legacy(), { tripId: 'short', now }), {
    code: 'INVALID_TRIP_ID',
  });
  assert.throws(() => normalizeTripMap(legacy(), { now: Infinity }), {
    code: 'INVALID_MAP_TIME',
  });
});
test('read wrapper requests only existing status endpoint with no mutation payload', async () => {
  let call;
  const scene = await getTripMap(
    { tripId, now },
    {
      send: async (...args) => {
        call = args;
        return legacy();
      },
    },
  );
  assert.deepEqual(call, ['/rt/riders/me/status', {}, { readOnly: true }]);
  assert.equal(scene.tripId, tripId);
});

test('selected transport job never draws route legs belonging to another job', () => {
  const raw = modern(),
    transport =
      raw.riderAppOrdersResponse.orders[0].jobs.singlePersonalTransport
        .transport;
  const secondWaypoint = '77777777-7777-4777-8777-777777777777';
  raw.riderAppOrdersResponse.orders[0].jobs = {
    multiplePersonalTransport: {
      transportJobs: [
        transport,
        {
          id: otherTripId,
          waypoints: [
            {
              transportJobWaypointType: {
                pickupWaypointView: {
                  uuid: secondWaypoint,
                  location: { location: { latitude: 39, longitude: -121 } },
                },
              },
            },
          ],
        },
      ],
    },
  };
  const feature =
    raw.riderAppOrdersResponse.features[orderId].mapRoutelineFeature;
  delete feature.encodedProviderPolyline;
  feature.legs.push({ uuid: secondWaypoint, encodedPolyline: '??' });
  const scene = normalizeTripMap(raw, { now, tripId });
  assert.deepEqual(
    scene.routes.map((route) => route.waypointUUID),
    [waypointId],
  );
  assert.ok(
    scene.warnings.some((w) => w.includes('outside the selected trip')),
  );
});

test('optional artwork read failure preserves the authenticated trip scene', async () => {
  const scene = await getTripMap(
    { tripId, now },
    {
      send: async () => legacy(),
      loadIcons: async () => {
        throw new Error('fixture corrupt cache');
      },
    },
  );
  assert.equal(scene.driver.position.epoch, now - 1000);
  assert.ok(scene.warnings.some((w) => w.includes('artwork is unavailable')));
});

test('empty modern vehicle path preserves valid legacy snapshot path', () => {
  const raw = { ...legacy(), ...modern() };
  raw.riderAppOrdersResponse.orders[0].jobs.singlePersonalTransport.transport.provider.vehicle.vehiclePath =
    [];
  const scene = normalizeTripMap(raw, { now });
  assert.equal(scene.driver.path.length, 2);
  assert.equal(scene.driver.source, 'legacy_vehicle_path');
});
test('partial single-order representation does not erase modern map features', () => {
  const raw = modern();
  raw.singleRiderAppOrderResponse = {
    order: {
      id: orderId,
      state: 'IN_PROGRESS',
      jobs: { singlePersonalTransport: { transport: { id: tripId } } },
    },
  };
  const scene = normalizeTripMap(raw, { now });
  assert.equal(scene.vehicleMapIconUrl, 'https://example.uber.com/car.png');
  assert.equal(scene.driver.path.length, 2);
  assert.equal(scene.waypoints.length, 2);
});
test('legacy order with unsupported empty jobs is unavailable rather than idle', () => {
  assert.equal(
    normalizeTripMap(
      {
        fulfillmentStateData: {
          orders: [{ orderId: { uuid: orderId }, orderPlan: { jobs: [] } }],
        },
      },
      { now },
    ).state,
    'unknown',
  );
});
test('aggregate route geometry is bounded across separate encoded legs', () => {
  const raw = legacy({
    currentRoute: null,
    legs: [
      { encodedPolyline: '??'.repeat(19000) },
      { encodedPolyline: '??'.repeat(19001) },
      { encodedPolyline: '??'.repeat(19002) },
    ],
  });
  assert.throws(() => normalizeTripMap(raw, { now }), {
    code: 'MAP_LIMIT_EXCEEDED',
  });
});

test('real-booking order-fetch failure is explicit and cannot become idle or missing trip', async () => {
  const raw = {
    clientStatus: { status: 'Dispatching' },
    fulfillmentStateData: { orders: null },
    isAllRiderAppOrdersEnabled: true,
    riderAppOrdersFetchResult: { riderAppOrdersFetchSucceeded: false },
    metadata: { pollingIntervalMs: 60000 },
  };
  for (const payload of [
    raw,
    { ...raw, fulfillmentStateData: { orders: [] } },
  ]) {
    assert.throws(() => normalizeTripMap(payload, { tripId, now }), {
      code: 'MAP_TRIP_FETCH_FAILED',
    });
  }
  let calls = 0;
  await assert.rejects(
    getTripMap(
      { tripId, now },
      {
        send: async () => {
          calls++;
          return raw;
        },
        loadSharedTrip: async () => {
          throw Object.assign(new Error('fixture shared API unavailable'), {
            code: 'MAP_TRIP_FETCH_FAILED',
          });
        },
      },
    ),
    { code: 'MAP_TRIP_FETCH_FAILED' },
  );
  assert.equal(calls, 1); // client-status returns only a phase and cannot repair missing geometry.
});

test('native sharing fallback recovers exact selected ride when account order fetching fails', async () => {
  let selected;
  const shared = {
    uuid: tripId,
    status: 'Accepted',
    tokenState: 'ACTIVE',
    pickupLocation: { latitude: 38.5, longitude: -120.2 },
    destination: { latitude: 40.7, longitude: -120.95 },
    locations: path,
    routeLines: [{ encodedPolyline: encoded }],
    driver: { privateNumber: 'PRIVATE_PHONE' },
    shareToken: 'PRIVATE_TOKEN',
  };
  const scene = await getTripMap(
    { tripId, now },
    {
      send: async () => ({
        clientStatus: { status: 'Accepted' },
        riderAppOrdersFetchResult: { riderAppOrdersFetchSucceeded: false },
      }),
      loadSharedTrip: async (id) => {
        selected = id;
        return shared;
      },
      loadIcons: async () => null,
    },
  );
  assert.equal(selected, tripId);
  assert.equal(scene.source, 'native_trip_share');
  assert.equal(scene.state, 'active');
  assert.equal(scene.waypoints.length, 2);
  assert.equal(scene.driver.position.epoch, now - 1000);
  assert.equal(scene.routes[0].points.length, 3);
  assert.ok(!JSON.stringify(scene).includes('PRIVATE'));
  assert.throws(
    () =>
      normalizeSharedTripMap({ ...shared, uuid: otherTripId }, { tripId, now }),
    { code: 'TRIP_NOT_FOUND' },
  );
  assert.throws(
    () =>
      normalizeSharedTripMap(
        { ...shared, tokenState: 'EXPIRED' },
        { tripId, now },
      ),
    { code: 'MAP_SHARE_REVOKED' },
  );
  const hidden = normalizeSharedTripMap(
    {
      ...shared,
      hideRouteline: true,
      locations: [{ ...path[0], epoch: Math.floor(now / 1000) }],
    },
    { tripId, now },
  );
  assert.equal(hidden.routes.length, 0);
  assert.equal(hidden.driver.position, null);
  const cancelled = normalizeSharedTripMap(
    { ...shared, status: 'ClientCanceled' },
    { tripId, now },
  );
  assert.equal(cancelled.state, 'ended');
  assert.equal(cancelled.driver.position, null);
});
