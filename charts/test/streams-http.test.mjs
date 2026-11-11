import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { sampleStream } from '../src/streams.mjs';
import { boundedFetch } from '../src/http.mjs';
import { boundedTransport } from '../src/transport.mjs';

test('a synchronous first update can reach the cap before a watcher is returned', async () => {
  let stopped = 0;
  const result = await sampleStream(async handlers => {
    handlers.onData(1); handlers.onData(2); handlers.onData(3);
    return { closed: new Promise(() => {}), stop: async () => { stopped++; } };
  }, { seconds: 1, maxUpdates: 2, signal: new AbortController().signal, transform: x => x });
  assert.deepEqual(result.updates.map(row => row.data), [1, 2]); assert.equal(stopped, 1);
  assert.equal(result.monitoringContinues, false);
});

test('a partial stream error is reported and resources are stopped', async () => {
  let stopped = false;
  const result = await sampleStream(async handlers => {
    handlers.onData(1); handlers.onError(Object.assign(new Error('secret'), { code: 'DISCONNECTED' }));
    return { closed: Promise.resolve(), stop: async () => { stopped = true; } };
  }, { seconds: 1, maxUpdates: 3, signal: new AbortController().signal, transform: x => x });
  assert.equal(result.completedBecause, 'error'); assert.equal(result.streamError.code, 'DISCONNECTED');
  assert.equal(stopped, true); assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('cancellation stops a running subscription', async () => {
  const controller = new AbortController(); let stopped = false;
  const operation = sampleStream(async () => ({ closed: new Promise(() => {}), stop: async () => { stopped = true; } }),
    { seconds: 30, maxUpdates: 50, signal: controller.signal, transform: x => x });
  setImmediate(() => controller.abort(new DOMException('cancelled', 'AbortError')));
  await assert.rejects(operation); assert.equal(stopped, true);
});

test('HTTP body limits apply to actual streamed bytes as well as content length', async () => {
  await assert.rejects(boundedFetch('https://example.com', {}, { maxBytes: 3, fetchImpl: async () => new Response('abcd', { headers: { 'content-length': '4' } }) }), { code: 'RESPONSE_LIMIT' });
  const response = await boundedFetch('https://example.com', {}, { maxBytes: 3, fetchImpl: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(2)); c.enqueue(new Uint8Array(2)); c.close(); } })) });
  await assert.rejects(response.text(), { code: 'RESPONSE_LIMIT' });
  await assert.rejects(boundedFetch('https://example.com', {}, { fetchImpl: async () => new Response('', { status: 429 }) }), { code: 'RATE_LIMITED' });
});

test('the WebSocket transport rejects oversized messages and sends the provider origin', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  let transport;
  try {
    const failure = new Promise(resolve => {
      server.once('connection', (socket, request) => { assert.equal(request.headers.origin, 'https://www.tradingview.com'); socket.send(Buffer.alloc(2 * 1024 * 1024 + 1)); });
      transport = boundedTransport({ url: `ws://127.0.0.1:${server.address().port}`, origin: 'https://www.tradingview.com', headers: {} }, {
        onOpen() {}, onMessage() { assert.fail('oversized payload reached the decoder'); }, onClose() {}, onError: resolve,
      });
    });
    assert.match((await failure).message, /payload|length|size/iu);
  } finally { transport?.terminate(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); }
});
