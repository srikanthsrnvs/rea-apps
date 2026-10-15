import test from 'node:test';
import assert from 'node:assert/strict';
import { startMapServer } from '../src/map-server.mjs';
import { watchScenes } from '../src/map-web/live-stream.mjs';
const initial = {
  state: 'active',
  status: 'EnRoute',
  tripId: 'selected',
  pollingIntervalMs: 8000,
  driver: { position: { lat: 1, lon: 2 } },
  routes: [],
  waypoints: [],
  eta: {},
};
async function waitFor(predicate) {
  const until = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('Stream event did not arrive');
    await new Promise((r) => setTimeout(r, 5));
  }
}
test('authenticated SSE delivers native ETA before snapshot cadence and closes on revocation', async () => {
  let deliver,
    allowed = true,
    calls = 0,
    closed = 0;
  const scenes = [];
  const viewer = await startMapServer(
    {},
    {
      getScene: async () => {
        calls++;
        return initial;
      },
      isAuthorized: async () => allowed,
      subscribeToScenes: (listener) => {
        deliver = listener;
        return () => {
          deliver = null;
        };
      },
      onClose: () => closed++,
    },
  );
  const url = new URL(viewer.mapUrl),
    key = new URLSearchParams(url.hash.slice(1)).get('key'),
    abort = new AbortController();
  const events = new URL('./events', url);
  assert.equal((await fetch(events)).status, 401);
  assert.equal(
    (
      await fetch(events, {
        headers: {
          authorization: `Bearer ${key}`,
          origin: 'https://other.example',
        },
      })
    ).status,
    403,
  );
  let unavailable;
  const watching = watchScenes({
    url: events,
    key,
    signal: abort.signal,
    onScene: (scene) => scenes.push(scene),
    onUnavailable: (code) => (unavailable = code),
  }).catch((error) => {
    if (!abort.signal.aborted) throw error;
  });
  try {
    await waitFor(() => scenes.length === 1);
    deliver({ ...initial, eta: { pickupDisplay: '2 min' } });
    await waitFor(() => scenes.at(-1).eta.pickupDisplay === '2 min');
    assert.equal(calls, 1);
    deliver({
      ...initial,
      tripId: 'another',
      eta: { pickupDisplay: 'PRIVATE' },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(scenes.length, 2);
    allowed = false;
    deliver(initial);
    await waitFor(() => unavailable === 410);
    await watching;
  } finally {
    abort.abort();
    await viewer.close();
    await watching;
  }
  assert.equal(closed, 1);
  assert.equal(deliver, null);
});
test('terminal push cannot be overwritten by queued active events and close ends an open stream', async () => {
  let deliver;
  const scenes = [];
  const viewer = await startMapServer(
    {},
    {
      getScene: async () => initial,
      subscribeToScenes: (listener) => {
        deliver = listener;
        return () => {};
      },
    },
  );
  const url = new URL(viewer.mapUrl),
    key = new URLSearchParams(url.hash.slice(1)).get('key'),
    abort = new AbortController();
  let unavailable;
  const watching = watchScenes({
    url: new URL('./events', url),
    key,
    signal: abort.signal,
    onScene: (scene) => scenes.push(scene),
    onUnavailable: (code) => (unavailable = code),
  }).catch((error) => {
    if (!abort.signal.aborted) throw error;
  });
  try {
    await waitFor(() => scenes.length === 1);
    deliver({ ...initial, state: 'ended', status: 'ClientCanceled' });
    deliver(initial);
    await waitFor(() => scenes.length === 2);
    assert.equal(scenes.at(-1).state, 'ended');
    await viewer.close();
    await watching;
    assert.equal(unavailable, 410);
  } finally {
    abort.abort();
    await viewer.close();
    await watching;
  }
});
