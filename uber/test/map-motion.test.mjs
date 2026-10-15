import test from 'node:test';
import assert from 'node:assert/strict';
import { MapMotion, trimRouteAt } from '../src/map-motion.mjs';

const a = { lat: 0, lon: 0 },
  b = { lat: 0, lon: 0.0005 },
  c = { lat: 0.0005, lon: 0.0005 };
function scene(position, points, epoch = 1, extra = {}) {
  return {
    tripId: 'test',
    status: 'EnRoute',
    state: 'active',
    driver: { position: { ...position, epoch, course: 90 } },
    routes: points
      ? [
          {
            kind: 'provider',
            points,
            encodedPolyline: JSON.stringify(points),
            ...extra,
          },
        ]
      : [],
  };
}

test('observations without route geometry interpolate then freeze', () => {
  const fallback = new MapMotion();
  fallback.update(scene(a), 100000);
  for (let t = 100000; t < 108000; t += 16) fallback.frame(t);
  fallback.update(scene(b, null, 2), 108000);
  const samples = [];
  for (let t = 108000; t < 114000; t += 16) samples.push(fallback.frame(t));
  assert.ok(samples.some((p) => p.lon > 0 && p.lon < b.lon));
  assert.ok(Math.abs(samples.at(-1).lon - b.lon) < 1e-9);
  const last = fallback.frame(200000);
  assert.ok(Math.abs(last.lon - b.lon) < 1e-9);
});

test('road animation follows an overlapping L-shaped route, not a straight chord', () => {
  const d = { lat: 0.001, lon: 0.0005 };
  const motion = new MapMotion();
  motion.update(scene(a, [a, b, c, d]), 100000);
  for (let t = 100000; t < 108000; t += 16) motion.frame(t);
  motion.update(scene(c, [c, d], 2), 108000);
  assert.equal(motion.mode, 'route');
  assert.deepEqual(motion.routePoints(motion.route), [a, b, c, d]);
  const samples = [];
  for (let t = 108000; t < 114000; t += 16) samples.push(motion.frame(t));
  assert.ok(
    samples.some((p) => p.lon > 0 && p.lon < 0.0004 && Math.abs(p.lat) < 1e-9),
  );
  assert.ok(
    samples.some(
      (p) =>
        p.lat > 0.0001 && p.lat < 0.0004 && Math.abs(p.lon - 0.0005) < 0.000003,
    ),
  );
});

test('recommendation origin far from driver cannot substitute a fabricated position', () => {
  const motion = new MapMotion();
  motion.update(
    scene(a, [b, c], 1, { source: 'uber_routing_recommendation' }),
    100000,
  );
  assert.equal(motion.retainedRoute, null);
  assert.deepEqual({ lat: motion.position.lat, lon: motion.position.lon }, a);
});

test('duplicate snapshots do not restart motion; terminal scene clears it immediately', () => {
  const motion = new MapMotion(),
    snapshot = scene(a, [a, b, c]);
  motion.update(snapshot, 100000);
  const pending = motion.queue.pending.length;
  motion.update(snapshot, 100001);
  assert.equal(motion.queue.pending.length, pending);
  motion.update({ ...snapshot, state: 'ended' }, 100002);
  assert.equal(motion.frame(100003), null);
});

test('remaining geometry clips at animated nearest projection, preserving road bends', () => {
  const clipped = trimRouteAt([a, b, c], { lat: 0.00001, lon: 0.00025 });
  assert.deepEqual(clipped, [{ lat: 0, lon: 0.00025 }, b, c]);
});
test('server predictions bridge native six-second silence and stop on a real observation', () => {
  const motion = new MapMotion();
  const first = scene(a, [a, b, c]);
  first.driver.prediction = [
    { distanceInMeters: 0, timestamp: 0 },
    { distanceInMeters: 30, timestamp: 3 },
    { distanceInMeters: 50, timestamp: 6 },
  ];
  motion.update(first, 100000);
  for (let t = 100000; t < 106000; t += 16) motion.frame(t);
  assert.equal(motion.lastPrediction, null);
  const samples = [];
  for (let t = 106000; t < 108000; t += 16) samples.push(motion.frame(t));
  assert.ok(samples.some((p) => p.lon > 0.00005 && p.lon < 0.00027));
  assert.equal(motion.lastPrediction.durationSeconds, 3);
  const behind = scene(a, [a, b, c], 2);
  behind.driver.prediction = first.driver.prediction;
  motion.update(behind, 108000); // resets debounce, cannot rewind past predicted target
  const queued = motion.queue.pending.length;
  assert.equal(motion.predictions.active, null);
  motion.frame(109500);
  assert.equal(motion.queue.pending.length <= queued, true);
  motion.update({ ...behind, state: 'ended' }, 110000);
  assert.equal(motion.frame(110001), null);
});
