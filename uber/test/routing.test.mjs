import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRouteline, routelineRequest } from '../src/routing.mjs';
import { enrichTripRoutes } from '../src/trip-map.mjs';

test('road routing uses the native read-only driving DTO and excludes unrelated response fields', async () => {
  let call;
  const result = await fetchRouteline('0,0', '1,2', {
    send: async (...args) => {
      call = args;
      return { encodedPolyline: '??_ibE_seK', private: 'PRIVATE' };
    },
  });
  assert.deepEqual(call, [
    '/rt/routing/fetch-routelines',
    {
      origin: { latitude: 0, longitude: 0 },
      destination: { latitude: 1, longitude: 2 },
      type: 'DRIVING',
    },
    { readOnly: true },
  ]);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.throws(() => routelineRequest('91,0', '0,0'));
  await assert.rejects(
    fetchRouteline('0,0', '1,2', { send: async () => ({}) }),
  );
});
const fixture = () => ({
  state: 'active',
  status: 'EnRoute',
  routes: [],
  warnings: [],
  driver: { position: { lat: 0, lon: 0 } },
  waypoints: [
    { kind: 'pickup', lat: 1, lon: 2 },
    { kind: 'dropoff', lat: 2, lon: 4 },
  ],
});
test('missing ride geometry gets separate Uber road recommendations for approach and destination', async () => {
  const calls = [];
  const scene = await enrichTripRoutes(fixture(), {
    loadRoute: async (from, to) => {
      calls.push([from, to]);
      return {
        encodedPolyline: calls.length === 1 ? '??_ibE_seK' : '_ibE_seK_ibE_seK',
      };
    },
  });
  assert.deepEqual(calls, [
    ['0,0', '1,2'],
    ['1,2', '2,4'],
  ]);
  assert.deepEqual(
    scene.routes.map((route) => route.kind),
    ['provider_recommended', 'trip_recommended'],
  );
  assert.ok(
    scene.routes.every(
      (route) =>
        route.source === 'uber_routing_recommendation' &&
        route.points.length === 2,
    ),
  );
  assert.ok(scene.warnings.some((w) => w.includes('driver-selected')));
});
test('routing respects hidden routes, terminal rides, existing native geometry and unsupported vias', async () => {
  for (const scene of [
    { ...fixture(), routeDisplayAllowed: false },
    { ...fixture(), state: 'ended' },
    { ...fixture(), routes: [{ kind: 'native' }] },
    {
      ...fixture(),
      waypoints: [...fixture().waypoints, { kind: 'via', lat: 3, lon: 4 }],
    },
  ]) {
    assert.equal(
      await enrichTripRoutes(scene, {
        loadRoute: () => {
          throw Error('must not fetch');
        },
      }),
      scene,
    );
  }
});
test('an invalid or mismatched road route never replaces valid driver coordinates', async () => {
  const scene = fixture(),
    result = await enrichTripRoutes(scene, {
      loadRoute: async () => ({ encodedPolyline: '??_p~iF~ps|U' }),
    });
  assert.deepEqual(result.routes, []);
  assert.deepEqual(result.driver.position, { lat: 0, lon: 0 });
  assert.ok(result.warnings.length);
});
