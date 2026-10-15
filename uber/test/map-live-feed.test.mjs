import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveMapFeed } from '../src/map-live-feed.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const scene = () => ({
  tripId: id,
  state: 'active',
  status: 'EnRoute',
  driver: { path: [], position: { lat: 1, lon: 2, epoch: 1700000000000 } },
  routes: [],
  eta: {},
  waypoints: [],
});
function harness() {
  let options,
    allowed = true,
    snapshot = scene(),
    stops = 0,
    refreshed = 0;
  const events = [];
  const feed = createLiveMapFeed(
    {
      tripId: id,
      getSnapshot: async () => snapshot,
      isAuthorized: async () => allowed,
    },
    {
      startTransport: (opts) => {
        options = opts;
        return { stop: () => stops++, done: Promise.resolve() };
      },
      getContext: async () => ({ owner: 'owned', headers: {} }),
      refreshSession: async () => refreshed++,
      now: () => 1700000000100,
    },
  );
  feed.subscribe((value) => events.push(value));
  return {
    feed,
    events,
    get options() {
      return options;
    },
    set allowed(v) {
      allowed = v;
    },
    set snapshot(v) {
      snapshot = v;
    },
    get stops() {
      return stops;
    },
    get refreshed() {
      return refreshed;
    },
  };
}
const message = (trip = id) => ({
  seq: '10',
  contentType: 2,
  payload: Buffer.from(
    JSON.stringify({
      tripUuid: trip,
      etaToPickup: 2,
      vehiclePathPoints: [
        { latitude: 1, longitude: 2.001, epoch: 1700000000050 },
      ],
    }),
  ),
});
test('native delivery updates ETA immediately, isolates selected trip, and terminal status stops stream', async () => {
  const h = harness(),
    signal = new AbortController().signal;
  await h.feed.read();
  assert.ok(h.options);
  await h.options.onMessage(message(), { signal });
  assert.equal(h.events.at(-1).eta.pickupMinutes, 2);
  const count = h.events.length;
  await h.options.onMessage(message('22222222-2222-4222-8222-222222222222'), {
    signal,
  });
  assert.equal(h.events.length, count);
  h.snapshot = { ...scene(), state: 'ended', status: 'ClientCanceled' };
  assert.equal((await h.feed.read()).state, 'ended');
  assert.equal(h.stops, 1);
  await h.options.onMessage({ ...message(), seq: '11' }, { signal });
  assert.equal(h.events.length, count);
  h.feed.close();
});
test('ownership and aborted delivery are checked again after asynchronous decode boundary', async () => {
  const h = harness();
  await h.feed.read();
  h.allowed = false;
  await h.options.onMessage(message(), {
    signal: new AbortController().signal,
  });
  assert.equal(h.events.length, 0);
  await assert.rejects(h.feed.read(), /session changed/);
  h.allowed = true;
  const abort = new AbortController();
  abort.abort();
  await h.options.onMessage(message(), { signal: abort.signal });
  assert.equal(h.events.length, 0);
  h.feed.close();
});
test('server refresh reconnect does not refresh OAuth; unauthenticated reconnect does', async () => {
  const h = harness();
  await h.feed.read();
  const signal = new AbortController().signal;
  await h.options.getContext({ reason: 'SERVER_REFRESH', signal });
  assert.equal(h.refreshed, 0);
  await h.options.getContext({ reason: 'GRPC_UNAUTHENTICATED', signal });
  assert.equal(h.refreshed, 1);
  h.allowed = false;
  await assert.rejects(
    h.options.getContext({ reason: 'GRPC_UNAUTHENTICATED', signal }),
  );
  assert.equal(h.refreshed, 1);
  h.feed.close();
});
