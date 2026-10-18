import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTripMap, normalizeSharedTripMap } from '../src/trip-map.mjs';
import { applyDriverUpdate } from '../src/map-live.mjs';
import { RideEvents } from '../src/ride-events.mjs';
const tripId = '11111111-1111-4111-8111-111111111111';
const now = 1800000000000;
function shared(status = 'EnRoute') {
  return {
    uuid: tripId,
    status,
    tokenState: 'ACTIVE',
    tripStatusText:
      status === 'ClientCanceled'
        ? 'The trip was canceled'
        : 'Meet your driver',
    pickupLocation: { latitude: 34, longitude: -118 },
    destination: { latitude: 34.1, longitude: -118.1 },
    locations: [{ latitude: 34.01, longitude: -118.01, epoch: now - 1000 }],
    driver: {
      uuid: '22222222-2222-4222-8222-222222222222',
      firstName: 'Test driver',
      rating: '4.97',
      pictureUrl: 'https://d1w2poirtb3as9.cloudfront.net/photo.jpg',
      phone: 'SECRET_PHONE',
    },
    vehicle: {
      make: 'Toyota',
      model: 'RAV4',
      color: { name: 'Blue' },
      licensePlate: 'TEST123',
      iconImage: { url: 'https://tb-static.uber.com/car.png' },
    },
    waypoints: [
      { type: 'PICKUP', address: 'Test pickup' },
      { type: 'DESTINATION', address: 'Test destination' },
    ],
    client: { firstName: 'SECRET_RIDER' },
    shareToken: 'SECRET_TOKEN',
    payment: 'SECRET_PAYMENT',
  };
}
test('ride retains selected native status, driver, car and addresses without rider/contact/credentials', () => {
  const scene = normalizeSharedTripMap(shared(), { tripId, now });
  assert.equal(scene.kind, 'ride');
  assert.equal(scene.ride.phase, 'approaching');
  assert.equal(scene.ride.statusTitle, 'Meet your driver');
  assert.equal(scene.ride.driver.rating, 4.97);
  assert.equal(scene.ride.vehicle.licensePlate, 'TEST123');
  assert.equal(scene.ride.destination.address, 'Test destination');
  assert.deepEqual(scene.mapPresentation.waypointKinds, ['pickup']);
  assert.deepEqual(scene.mapPresentation.routeKinds, [
    'provider',
    'provider_recommended',
  ]);
  assert.equal(scene.waypoints.length, 2); // geometry remains available to API consumers.
  assert.ok(!JSON.stringify(scene).includes('SECRET_'));
});
test('ride image URLs are restricted and absent presentation stays absent', () => {
  const raw = shared();
  raw.driver.pictureUrl = 'https://example.com/track';
  raw.vehicle.iconImage.url = 'data:image/svg+xml,bad';
  raw.driver.rating = 'not-a-rating';
  let scene = normalizeSharedTripMap(raw, { tripId, now });
  assert.equal(scene.ride.driver.photoUrl, null);
  assert.equal(scene.ride.driver.rating, null);
  assert.equal(scene.ride.vehicle.imageUrl, null);
  delete raw.driver;
  delete raw.vehicle;
  scene = normalizeSharedTripMap(raw, { tripId, now });
  assert.equal(scene.ride.driver, null);
  assert.equal(scene.ride.vehicle, null);
});
test('IN_PROGRESS fulfillment keeps explicit selected approach status and native push ETA', () => {
  const scene = normalizeTripMap(
    {
      clientStatus: { status: 'Accepted' },
      riderAppOrdersResponse: {
        orders: [
          {
            id: tripId,
            state: 'IN_PROGRESS',
            jobs: { singlePersonalTransport: { transport: { id: tripId } } },
          },
        ],
      },
    },
    { tripId, now },
  );
  assert.equal(scene.status, 'Accepted');
  assert.equal(scene.ride.phase, 'approaching');
  const updated = applyDriverUpdate(
    scene,
    { tripUuid: tripId, etaToPickup: 3 },
    { now },
  );
  assert.equal(updated.eta.pickupMinutes, 3);
  assert.equal(updated.ride.phase, 'approaching');
});
test('completed pickup changes the current leg, but global status cannot classify another selected trip', () => {
  const transport = {
    id: tripId,
    waypoints: [
      {
        transportJobWaypointType: {
          pickupWaypointView: {
            location: { location: { latitude: 34, longitude: -118 } },
            stateInfo: { state: 'COMPLETED' },
          },
        },
      },
    ],
  };
  const raw = {
    clientStatus: { status: 'Accepted' },
    riderAppOrdersResponse: {
      orders: [
        {
          id: tripId,
          state: 'IN_PROGRESS',
          jobs: { singlePersonalTransport: { transport } },
        },
      ],
    },
  };
  const scene = normalizeTripMap(raw, { tripId, now });
  assert.equal(scene.ride.phase, 'riding');
  assert.deepEqual(scene.mapPresentation.waypointKinds, ['via', 'dropoff']);
  raw.riderAppOrdersResponse.orders.push({
    id: '33333333-3333-4333-8333-333333333333',
    state: 'IN_PROGRESS',
    jobs: {
      singlePersonalTransport: {
        transport: { id: '33333333-3333-4333-8333-333333333333' },
      },
    },
  });
  const other = normalizeTripMap(raw, {
    tripId: '33333333-3333-4333-8333-333333333333',
    now,
  });
  assert.equal(other.ride.phase, 'unknown');
});
test('terminal share preserves native cancellation text, clears ETA, car and displayed routes', () => {
  const scene = normalizeSharedTripMap(shared('ClientCanceled'), {
    tripId,
    now,
  });
  assert.equal(scene.ride.phase, 'cancelled');
  assert.equal(scene.ride.statusTitle, 'The trip was canceled');
  assert.equal(scene.driver.position, null);
  assert.equal(scene.eta.pickupDisplay, null);
  assert.deepEqual(scene.mapPresentation.routeKinds, []);
});
test('ride observations deduplicate, bound events, isolate trips and never resurrect terminal state', () => {
  const events = new RideEvents();
  let scene = normalizeSharedTripMap(shared(), { tripId, now });
  let observed = events.observe(scene);
  assert.deepEqual(
    observed.rideEvents.map((event) => event.type),
    [
      'ride.phase_changed',
      'ride.driver_assigned',
      'ride.eta_changed',
      'ride.driver_position',
    ],
  );
  const sequence = observed.eventCursor;
  assert.equal(events.observe(structuredClone(scene)).eventCursor, sequence);
  for (let index = 0; index < 150; index++) {
    scene = applyDriverUpdate(
      scene,
      { tripUuid: tripId, etaToPickup: index },
      { now: now + index },
    );
    observed = events.observe(scene);
  }
  assert.equal(observed.rideEvents.length, 128);
  assert.equal(new Set(observed.rideEvents.map((event) => event.id)).size, 128);
  const terminal = events.observe(
    normalizeSharedTripMap(shared('ClientCanceled'), { tripId, now }),
  );
  assert.equal(events.observe(scene).state, 'ended');
  assert.equal(events.observe(scene).eventCursor, terminal.eventCursor);
  assert.throws(
    () =>
      events.observe({
        ...scene,
        tripId: '33333333-3333-4333-8333-333333333333',
      }),
    /selected trip/,
  );
});

test('native driver visibility flags suppress the corresponding presentation fields', () => {
  const raw = shared();
  raw.driver.driverVisibilitySettings = {
    hideName: true,
    hidePicture: true,
    hideRating: true,
  };
  const scene = normalizeSharedTripMap(raw, { tripId, now });
  assert.equal(scene.ride.driver.name, null);
  assert.equal(scene.ride.driver.photoUrl, null);
  assert.equal(scene.ride.driver.rating, null);
});

test('pickup ETA cannot reappear after the selected pickup waypoint is completed', () => {
  const scene = normalizeSharedTripMap(shared('OnTrip'), { tripId, now });
  scene.status = 'Accepted'; // a stale account-wide phase must not override the selected leg.
  const updated = applyDriverUpdate(
    scene,
    { tripUuid: tripId, etaToPickup: 2 },
    { now },
  );
  assert.equal(updated.eta.pickupMinutes, null);
});
