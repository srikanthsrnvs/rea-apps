import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NativeFrameSampler,
  NativeTimingQueue,
  relativeAnimations,
  vehicleBatchPath,
  sphericalInterpolate,
  NativeRoutePlanner,
  edge,
} from '../src/native-motion.mjs';
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
// Deterministic TEST geodesy; explicit fake, never production/native geodesy claim.
const geo = {
  distance: (a, b) => Math.hypot(a.lat - b.lat, a.lon - b.lon),
  heading: () => 90,
  onSegment: () => true,
};
test('native frame sampler interpolates fractional timestamps, uses target heading and freezes', () => {
  const f = new NativeFrameSampler();
  f.replace([{ lat: 0, lon: 0, course: 350, epoch: 1000 }]);
  f.sample(1000);
  f.replace([{ lat: 0, lon: 0.0001, course: 10, epoch: 2000 }]);
  let p = f.sample(1500);
  near(p.lon, 0.00005);
  assert.equal(p.course, 10);
  p = f.sample(1750);
  near(p.lon, 0.000075);
  p = f.sample(3000);
  near(p.lon, 0.0001);
  assert.equal(f.points.length, 0);
  p = f.sample(9000);
  near(p.lon, 0.0001);
  assert.equal(p.epoch, 9000);
});
test('native frame sampler only consumes one past point per tick; preserves list order', () => {
  const f = new NativeFrameSampler();
  f.replace([
    { lat: 0, lon: 1, epoch: 1 },
    { lat: 0, lon: 2, epoch: 2 },
  ]);
  assert.equal(f.sample(100).lon, 1);
  assert.equal(f.points.length, 1);
  assert.equal(f.sample(101).lon, 2);
});
test('delay subtracts wall time, no lower clamp imposed', () => {
  const f = new NativeFrameSampler(500);
  f.replace([{ lat: 0, lon: 0, epoch: 1000 }]);
  f.sample(1500);
  f.replace([{ lat: 0, lon: 0.0001, epoch: 2000 }]);
  near(f.sample(2000).lon, 0.00005);
});
test('reset planner relative positions and normalized .001 gap align car and route', () => {
  const a = { lat: 0, lon: 0 },
    b = { lat: 0, lon: 0.0001 },
    c = { lat: 0, lon: 0.0003 },
    route = [edge(a, b, geo), edge(b, c, geo)];
  const out = relativeAnimations(route, route, 30, true, false, geo);
  assert.equal(out[0].start, 0);
  assert.equal(out[0].duration, 0);
  assert.equal(out[1].start, 0.001);
  near(out[1].duration, 1 / 3 - 0.001);
  near(out[2].start, 1 / 3);
  near(out[2].duration, 2 / 3);
  assert.deepEqual(
    out.filter((x) => x.kind === 'vehicle').map((x) => [x.start, x.duration]),
    out.filter((x) => x.kind === 'polyline').map((x) => [x.start, x.duration]),
  );
});
test('default queue five-second initial duration and strict scheduling', () => {
  const q = new NativeTimingQueue();
  q.enqueue(
    [
      { start: 0, duration: 0, kind: 'vehicle', entity: { lat: 0, lon: 0 } },
      {
        start: 0.001,
        duration: 0.999,
        kind: 'vehicle',
        entity: { lat: 0, lon: 1 },
      },
    ],
    100,
  );
  const first = q.tick(100);
  assert.equal(first.length, 1);
  assert.equal(first[0].duration, 0);
  assert.equal(q.tick(100.005).length, 0);
  const second = q.tick(100.006);
  near(second[0].duration, 4.995);
  near(vehicleBatchPath(second, 100006)[0].epoch, 105001);
});
test('queue moving-mean duration and backlog division are source-derived', () => {
  const q = new NativeTimingQueue();
  q.enqueue([{ start: 0, duration: 1 }], 100);
  q.enqueue([{ start: 0, duration: 1 }], 102);
  q.enqueue([{ start: 0, duration: 1 }], 104);
  q.enqueue([{ start: 0, duration: 1 }], 106);
  near(q.baseDuration(), (5 + 2 + 2 + 2 + 5) / 5 / 2);
});
test('explicit prediction duration bypasses adaptive queue duration', () => {
  const q = new NativeTimingQueue();
  q.enqueue([{ start: 0, duration: 0.25 }], 100, { predictionDuration: 8 });
  near(q.tick(100)[0].duration, 2);
});
test('spherical fallback follows native close-point linear math', () => {
  const p = sphericalInterpolate(
    { lat: 30, lon: -110 },
    { lat: 30.000001, lon: -110.000001 },
    0.25,
  );
  near(p.lat, 30.00000025);
  near(p.lon, -110.00000025);
});
test('geodesy dependencies are mandatory to avoid hidden haversine approximation', () =>
  assert.throws(() => new NativeRoutePlanner({}), /Missing native geodesy/));
import { nativeGeodesy } from '../src/native-geodesy.mjs';
import {
  normalizeNativeRouteObservation,
  mergeOverlappingRoutes,
  overlapEdge,
} from '../src/native-motion.mjs';
test('native route observation retains travelled prefix across shrinking route', () => {
  const p1 = { lat: 33.99, lon: -118.46 },
    p2 = { lat: 33.9901, lon: -118.4601 },
    p3 = { lat: 33.9902, lon: -118.4602 },
    p4 = { lat: 33.9903, lon: -118.4603 };
  const first = normalizeNativeRouteObservation(
      null,
      [p1, p2, p3, p4],
      [],
      nativeGeodesy,
    ),
    second = normalizeNativeRouteObservation(
      first.retainedRoute,
      [p2, p3, p4],
      [{ lat: 0, lon: 0 }],
      nativeGeodesy,
    );
  assert.equal(first.kind, 'route');
  assert.equal(second.kind, 'route');
  assert.equal(second.retainedRoute.length, 3);
  assert.deepEqual(second.retainedRoute[0].start, p1);
  assert.equal(second.vehicle.agent.index, 0);
  near(second.vehicle.agent.fraction, 1);
  // Mapper intentionally uses incoming first route point, not unrelated path location0,0.
  near(second.vehicle.position.lat, p2.lat);
  near(second.vehicle.position.lon, p2.lon);
});
test('native missing-route fallback is last wire point and zero-length route', () => {
  const v = normalizeNativeRouteObservation(
    null,
    [],
    [
      { lat: 1, lon: 2 },
      { lat: 3, lon: 4, course: 14 },
    ],
    nativeGeodesy,
  );
  assert.equal(v.kind, 'path-fallback');
  assert.deepEqual(v.vehicle.position, { lat: 3, lon: 4 });
  assert.equal(v.vehicle.route[0].length, 0);
  assert.equal(v.vehicle.agent.heading, 14);
});
test('overlap predicate retains exact infinity equality but rejectsNaN slope', () => {
  assert.equal(
    overlapEdge(
      { start: { lat: 0, lon: 0 }, end: { lat: 0, lon: 1 } },
      { start: { lat: 0, lon: 0 }, end: { lat: 0, lon: 2 } },
    ),
    true,
  );
  assert.equal(
    overlapEdge(
      { start: { lat: 0, lon: 0 }, end: { lat: 0, lon: 0 } },
      { start: { lat: 0, lon: 0 }, end: { lat: 0, lon: 0 } },
    ),
    false,
  );
});
