import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { runMapStream } from '../src/map-stream-cli.mjs';
const active = { state: 'active', tripId: 'fixture' };
function harness() {
  const signals = new EventEmitter();
  let closed = false;
  const feed = {
    read: async () => active,
    subscribe: () => () => {},
    close: () => (closed = true),
  };
  return {
    signals,
    feed,
    get closed() {
      return closed;
    },
    createGuard: async () => async () => true,
    createFeed: async () => feed,
  };
}
test('duration stops a backpressured initial NDJSON write and releases listeners', async () => {
  const h = harness(),
    output = new Writable({ highWaterMark: 1, write() {} });
  await runMapStream(
    { tripId: 'fixture', duration: 10 },
    {
      ...h,
      output,
      setDeadline: (stop, ms) => {
        assert.equal(ms, 10000);
        return setTimeout(stop, 10);
      },
    },
  );
  assert.equal(h.closed, true);
  assert.equal(h.signals.listenerCount('SIGINT'), 0);
  assert.equal(h.signals.listenerCount('SIGTERM'), 0);
  assert.equal(output.listenerCount('drain'), 0);
  assert.equal(output.listenerCount('error'), 0);
  output.destroy();
});
test('a terminal first scene exits without opening a continuing stream', async () => {
  const h = harness(),
    lines = [];
  h.feed.read = async () => ({ state: 'ended', status: 'ClientCanceled' });
  const output = new Writable({
    write(chunk, encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  await runMapStream({ tripId: 'fixture' }, { ...h, output });
  assert.equal(JSON.parse(lines.join('')).scene.state, 'ended');
  assert.equal(h.closed, true);
  assert.equal(h.signals.listenerCount('SIGINT'), 0);
  output.destroy();
});
test('a signal during feed creation closes the late-created feed', async () => {
  const h = harness(),
    output = new Writable({
      write(chunk, encoding, done) {
        done();
      },
    });
  await runMapStream(
    { tripId: 'fixture' },
    {
      ...h,
      output,
      createFeed: async () => {
        h.signals.emit('SIGTERM');
        return h.feed;
      },
    },
  );
  assert.equal(h.closed, true);
  assert.equal(output.listenerCount('error'), 0);
  output.destroy();
});
