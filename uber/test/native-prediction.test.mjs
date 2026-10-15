import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NativeServerPredictionPlanner,
  advanceAgent,
  agentAhead,
  predictionRoutesEqual,
} from '../src/native-prediction.mjs';
import { edge, pointAt } from '../src/native-motion.mjs';
import { nativeGeodesy } from '../src/native-geodesy.mjs';
const a = { lat: 0, lon: 0 },
  b = { lat: 0, lon: 0.001 },
  c = { lat: 0.001, lon: 0.001 };
const route = [edge(a, b, nativeGeodesy), edge(b, c, nativeGeodesy)];
const base = (agent = { index: 0, fraction: 0, heading: 90 }, r = route) => ({
  route: r,
  agent,
  position: pointAt(r, agent),
});
const points = [
  { distanceInMeters: 0, timestamp: 1000 },
  { distanceInMeters: 20, timestamp: 1002 },
  { distanceInMeters: 50, timestamp: 1005 },
];
const planner = () => {
  const p = new NativeServerPredictionPlanner();
  p.observePredictions(points);
  p.observeRouteline(base(), 0);
  return p;
};

test('advance follows route meters through corner, not a geographic straight line', () => {
  const first = route[0].length;
  const p = advanceAgent(route, base().agent, first + route[1].length / 2);
  assert.equal(p.index, 1);
  assert.ok(Math.abs(p.fraction - 0.5) < 1e-12);
  const coordinate = pointAt(route, p);
  assert.ok(Math.abs(coordinate.lon - 0.001) < 1e-12);
  assert.ok(coordinate.lat > 0);
});
test('strict route boundary uses following edge heading', () => {
  const p = advanceAgent(route, base().agent, route[0].length);
  assert.deepEqual(p, { index: 1, fraction: 0, heading: route[1].heading });
});
test('advance begins at actual fractional route position and clamps at terminal endpoint', () => {
  const start = { index: 0, fraction: 0.5, heading: 90 };
  const p = advanceAgent(route, start, route[0].length * 0.25);
  assert.equal(p.fraction, 0.75);
  assert.deepEqual(advanceAgent(route, start, 1e9), {
    index: 1,
    fraction: 1,
    heading: route[1].heading,
  });
});
test('zero or negative distance and empty route retain native current agent', () => {
  const p = base().agent;
  assert.equal(advanceAgent(route, p, 0), p);
  assert.equal(advanceAgent(route, p, -1), p);
  assert.equal(advanceAgent([], p, 20), p);
});
test('zero length edges are skipped when progressing', () => {
  const r = [{ ...route[0], length: 0 }, route[1]];
  assert.equal(advanceAgent(r, base().agent, 10).index, 1);
});
test('agent ordering is strict lexicographic edge and fraction', () => {
  assert.equal(
    agentAhead({ index: 1, fraction: 0 }, { index: 0, fraction: 1 }),
    true,
  );
  assert.equal(
    agentAhead({ index: 0, fraction: 0.5 }, { index: 0, fraction: 0.5 }),
    false,
  );
});
test('does not extrapolate without supplied server predictions', () => {
  const p = new NativeServerPredictionPlanner();
  p.observeRouteline(base(), 0);
  assert.deepEqual(p.advanceTo(90000), []);
});
test('starts at exactly six seconds and uses raw timestamp differences as seconds', () => {
  const p = planner();
  assert.deepEqual(p.advanceTo(5999), []);
  const [one] = p.advanceTo(6000);
  assert.equal(one.atMs, 6000);
  assert.equal(one.durationSeconds, 2);
  assert.equal(one.predictionIndex, 1);
  assert.deepEqual(p.advanceTo(7999), []);
  const [two] = p.advanceTo(8000);
  assert.equal(two.durationSeconds, 3);
  assert.equal(two.predictionIndex, 2);
  assert.ok(Math.abs(two.target.agent.fraction - 50 / route[0].length) < 1e-12);
  assert.deepEqual(p.advanceTo(100000), []);
});
test('each target distance is offset from original actual position, not cumulative', () => {
  const p = planner();
  const out = p.advanceTo(10000);
  assert.equal(out.length, 2);
  assert.ok(
    Math.abs(out[1].target.agent.fraction - 50 / route[0].length) < 1e-12,
  );
});
test('new real observation cancels scheduled predictions and restarts six second debounce', () => {
  const p = planner();
  assert.equal(p.advanceTo(6000).length, 1);
  const next = base({ index: 0, fraction: 0.4, heading: 90 });
  p.observeRouteline(next, 7000);
  assert.deepEqual(p.advanceTo(12999), []);
  const out = p.advanceTo(13000);
  assert.equal(out.length, 1);
  assert.equal(out[0].atMs, 13000);
});
test('read latest predictions at debounce expiry, retain captured list during recursion', () => {
  const p = planner();
  p.observePredictions([
    { distanceInMeters: 0, timestamp: 20 },
    { distanceInMeters: 30, timestamp: 24 },
    { distanceInMeters: 60, timestamp: 25 },
  ]);
  assert.equal(p.advanceTo(6000)[0].durationSeconds, 4);
  p.observePredictions(points);
  assert.deepEqual(p.advanceTo(9999), []);
  const out = p.advanceTo(10000);
  assert.equal(out[0].durationSeconds, 1);
  assert.ok(
    Math.abs(out[0].target.agent.fraction - 60 / route[0].length) < 1e-12,
  );
});
test('same route suppresses a predicted jump backwards after stale real update', () => {
  const p = planner();
  p.advanceTo(6000);
  p.observeRouteline(base(), 6500);
  assert.deepEqual(p.advanceTo(12500), []);
});
test('structurally equal route suppresses backwards even when object identity changes', () => {
  const p = planner();
  p.advanceTo(6000);
  const copied = structuredClone(route);
  assert.equal(predictionRoutesEqual(route, copied), true);
  p.observeRouteline(base(base().agent, copied), 6500);
  assert.deepEqual(p.advanceTo(12500), []);
});
test('changed route permits prediction despite previous route progress', () => {
  const p = planner();
  p.advanceTo(6000);
  const changed = [edge(a, c, nativeGeodesy)];
  p.observeRouteline(base(base().agent, changed), 6500);
  assert.equal(p.advanceTo(12500).length, 1);
});
test('equal or ahead real progress permits new prediction', () => {
  const p = planner();
  const [one] = p.advanceTo(6000);
  p.observeRouteline(one.target, 6500);
  assert.equal(p.advanceTo(12500).length, 1);
});
test('deactivation cancels timers and preserves last prediction for monotonic gate', () => {
  const p = planner();
  const first = p.advanceTo(6000)[0];
  p.setEnabled(false);
  assert.deepEqual(p.advanceTo(9000), []);
  assert.equal(p.lastPrediction, first);
  p.setEnabled(true);
  p.observeRouteline(base(), 10000);
  assert.deepEqual(p.advanceTo(16000), []);
});
test('equal timestamps are immediate next targets, with no invented minimum duration', () => {
  const p = new NativeServerPredictionPlanner();
  p.observePredictions([
    { distanceInMeters: 0, timestamp: 0 },
    { distanceInMeters: 10, timestamp: 0 },
    { distanceInMeters: 20, timestamp: 1 },
  ]);
  p.observeRouteline(base(), 0);
  const out = p.advanceTo(6000);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((x) => x.durationSeconds),
    [0, 1],
  );
});
test('validation rejects unsafe timestamps, decreasing times, and nonfinite distances', () => {
  const p = new NativeServerPredictionPlanner();
  assert.throws(
    () => p.observePredictions([{ distanceInMeters: 1, timestamp: 2 ** 53 }]),
    /exact integer/,
  );
  assert.throws(
    () =>
      p.observePredictions([
        { distanceInMeters: 0, timestamp: 2 },
        { distanceInMeters: 1, timestamp: 1 },
      ]),
    /nondecreasing/,
  );
  assert.throws(
    () => p.observePredictions([{ distanceInMeters: Infinity, timestamp: 1 }]),
    /finite/,
  );
  assert.throws(() => advanceAgent(route, base().agent, NaN), /finite/);
});
test('no epoch-unit heuristic: large origins preserve actual seconds difference', () => {
  const p = new NativeServerPredictionPlanner();
  p.observePredictions([
    { distanceInMeters: 0, timestamp: 1792083600 },
    { distanceInMeters: 10, timestamp: 1792083602 },
  ]);
  p.observeRouteline(base(), 0);
  assert.equal(p.advanceTo(6000)[0].durationSeconds, 2);
});
test('monotonic scheduling clock is explicit', () => {
  const p = planner();
  p.advanceTo(6000);
  assert.throws(() => p.advanceTo(5000), /monotonic/);
});

test('derived heading is excluded from native Edge route equality and backwards gate', () => {
  const p = planner();
  p.advanceTo(6000);
  const changed = structuredClone(route);
  changed[0].heading += 30;
  changed[1].heading = null;
  assert.equal(predictionRoutesEqual(route, changed), true);
  p.observeRouteline(base(base().agent, changed), 6500);
  assert.deepEqual(p.advanceTo(12500), []);
});
