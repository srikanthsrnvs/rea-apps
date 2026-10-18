import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runEatsTracking } from '../src/eats/tracking-cli.mjs';
import { startMapServer } from '../src/map-server.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const scene = {
  kind: 'eats',
  state: 'ended',
  tripId: id,
  waypoints: [{ lat: 34, lon: -118, kind: 'dropoff' }],
  delivery: { stage: 'delivered' },
  eventCursor: 3,
  deliveryEvents: [
    { id: `${id}:2`, sequence: 2, type: 'arrived' },
    { id: `${id}:3`, sequence: 3, type: 'delivered' },
  ],
};
const sink = () =>
  Object.assign(new EventEmitter(), {
    lines: [],
    write(line) {
      this.lines.push(JSON.parse(line));
      return true;
    },
  });

test('NDJSON rechecks owner after an in-flight read and never publishes revoked scenes', async () => {
  let authorized = true;
  const output = sink(),
    signals = new EventEmitter();
  await assert.rejects(
    runEatsTracking(
      { 'order-id': id, action: 'stream', duration: '10' },
      {
        output,
        signals,
        guard: async () => async () => authorized,
        read: async () => {
          authorized = false;
          return scene;
        },
      },
    ),
    /session changed/,
  );
  assert.deepEqual(output.lines, []);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(output.listenerCount('error'), 0);
});

test('NDJSON resumes delivery events, returns terminal scene and releases listeners', async () => {
  const output = sink(),
    signals = new EventEmitter();
  await runEatsTracking(
    { 'order-id': id, action: 'stream', after: '2', duration: '10' },
    {
      output,
      signals,
      guard: async () => async () => true,
      read: async () => scene,
    },
  );
  assert.deepEqual(
    output.lines.filter((e) => e.event === 'delivery').map((e) => e.type),
    ['delivered'],
  );
  assert.equal(output.lines.at(-1).event, 'scene');
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  const future = sink();
  await assert.rejects(
    runEatsTracking(
      { 'order-id': id, action: 'stream', after: '9', duration: '10' },
      {
        output: future,
        signals,
        guard: async () => async () => true,
        read: async () => scene,
      },
    ),
    /cursor is ahead/,
  );
  assert.deepEqual(future.lines, []);
});

test('expiring delivery SSE resumes exact-order event ids and rejects foreign/future cursors', async (t) => {
  const viewer = await startMapServer(
    { durationSeconds: 30, frameOrigins: ['https://client.example'] },
    {
      getScene: async () => scene,
      fidelity: { updates: 'native_eats_polling' },
    },
  );
  t.after(() => viewer.close());
  const u = new URL(viewer.mapUrl),
    key = new URLSearchParams(u.hash.slice(1)).get('key');
  const headers = { authorization: `Bearer ${key}` };
  const read = await fetch(new URL('state', u), { headers });
  assert.deepEqual((await read.json()).viewer.frameOrigins, [
    'https://client.example',
  ]);
  const url = new URL('events', u);
  assert.equal(
    (
      await fetch(url, {
        headers: {
          ...headers,
          'last-event-id': `22222222-2222-4222-8222-222222222222:2`,
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetch(url, { headers: { ...headers, 'last-event-id': `${id}:9` } }))
      .status,
    409,
  );
  const controller = new AbortController();
  const stream = await fetch(url, {
    headers: { ...headers, 'last-event-id': `${id}:2` },
    signal: controller.signal,
  });
  const reader = stream.body.getReader();
  const value = await reader.read();
  const raw = new TextDecoder().decode(value.value);
  assert.match(raw, /event: delivery\ndata: .*"type":"delivered"/);
  assert.ok(!raw.includes(`event: delivery\ndata: {"id":"${id}:2"`));
  controller.abort();
  await reader.cancel().catch(() => {});
});

test('a revoked initial map read cannot advertise a viewer lease', async () => {
  let authorized = true;
  await assert.rejects(
    startMapServer(
      {},
      {
        isAuthorized: async () => authorized,
        getScene: async () => {
          authorized = false;
          return scene;
        },
      },
    ),
    /no longer available/,
  );
});
