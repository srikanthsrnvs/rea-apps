import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDriverUpdate, MapLiveProjection } from '../src/map-live.mjs';
const id = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222',
  now = 1700000000000;
const scene = () => ({
  tripId: id,
  state: 'active',
  status: 'EnRoute',
  driver: { path: [], position: null },
  routes: [],
  eta: { pickupDisplay: null },
  warnings: [],
  waypoints: [],
});
const update = () => ({
  tripUuid: id,
  vehiclePathPoints: [
    { latitude: 1, longitude: 2, course: 10, epoch: now - 100 },
  ],
  etaToPickup: 3,
  etaToPickupStringShort: '3 min',
  prediction: [
    { distanceInMeters: 0, timestamp: 0 },
    { distanceInMeters: 20, timestamp: 3 },
  ],
  privatePhone: 'PRIVATE_DATA',
});
test('native push projects actual matching coordinates, minute ETA and server predictions only', () => {
  const result = applyDriverUpdate(scene(), update(), {
    now,
    sequence: '9007199254740993',
  });
  assert.equal(result.driver.position.lat, 1);
  assert.equal(result.driver.streamSequence, '9007199254740993');
  assert.equal(result.eta.pickupMinutes, 3);
  assert.equal(result.eta.pickupDisplay, '3 min');
  assert.equal(result.driver.prediction[1].timestamp, 3);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_DATA'));
});
test('another trip or a terminal snapshot cannot be resurrected by driver pushes', () => {
  const original = scene();
  assert.equal(
    applyDriverUpdate(original, { ...update(), tripUuid: other }, { now }),
    original,
  );
  const ended = { ...original, state: 'ended' };
  assert.equal(applyDriverUpdate(ended, update(), { now }), ended);
});
test('negative native ETA hides annotation; missing ETA never invents a value', () => {
  assert.equal(
    applyDriverUpdate(scene(), { ...update(), etaToPickup: -1 }, { now }).eta
      .pickupDisplay,
    null,
  );
  const missing = update();
  delete missing.etaToPickup;
  delete missing.etaToPickupStringShort;
  assert.equal(
    applyDriverUpdate(scene(), missing, { now }).eta.pickupDisplay,
    null,
  );
});
test('currentRoute first point uses native location with no fabricated GPS epoch', () => {
  const result = applyDriverUpdate(
    scene(),
    { tripUuid: id, currentRoute: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
    { now },
  );
  assert.equal(result.driver.position.lat, 38.5);
  assert.equal(result.driver.position.lon, -120.2);
  assert.equal(result.driver.position.epoch, null);
  assert.equal(result.routes[0].source, 'native_driver_location_push');
});
test('projection orders BigInt sequences, reapplies latest push over fallback and clears on terminal', () => {
  let time = now;
  const projection = new MapLiveProjection(id, { now: () => time });
  projection.snapshot(scene());
  projection.accept(update(), '9007199254740993');
  assert.equal(
    projection.accept({ ...update(), etaToPickup: 2 }, '9007199254740992'),
    null,
  );
  assert.equal(projection.snapshot(scene()).eta.pickupMinutes, 3);
  const ended = projection.snapshot({ ...scene(), state: 'ended' });
  assert.equal(ended.state, 'ended');
  assert.equal(projection.accept(update(), '9007199254740994'), null);
});
test('newer snapshot position wins over an old push while retaining native ETA', () => {
  const projection = new MapLiveProjection(id, { now: () => now });
  projection.snapshot(scene());
  projection.accept(update(), '10');
  const newer = {
    ...scene(),
    driver: { position: { lat: 1, lon: 2.1, epoch: now }, path: [] },
  };
  const projected = projection.snapshot(newer);
  assert.equal(projected.driver.position.lon, 2.1);
  assert.equal(projected.eta.pickupMinutes, 3);
  projection.snapshot({ ...scene(), state: 'ended' });
  assert.equal(projection.snapshot(scene()).state, 'ended');
});
test('invalid prediction list is discarded as a unit rather than altering its timing', () => {
  const result = applyDriverUpdate(
    scene(),
    {
      ...update(),
      prediction: [
        { distanceInMeters: 0, timestamp: 5 },
        { distanceInMeters: 20, timestamp: 2 },
      ],
    },
    { now },
  );
  assert.deepEqual(result.driver.prediction, []);
});
