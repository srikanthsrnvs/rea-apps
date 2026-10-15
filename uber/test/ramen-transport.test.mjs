import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { once } from 'node:events';
import {
  GrpcFrameDecoder,
  encodeGrpcFrame,
  createRamenTransport,
  RAMEN_PATH,
} from '../src/ramen-transport.mjs';
const encode = (value) => Buffer.from(JSON.stringify(value)),
  decode = (buffer) => JSON.parse(buffer.toString());
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function serverHarness(handler) {
  const server = http2.createServer(),
    sessions = new Set();
  server.on('session', (s) => {
    sessions.add(s);
    s.on('close', () => sessions.delete(s));
    s.on('error', () => {});
  });
  server.on('stream', (s, h) => {
    s.on('error', () => {});
    handler(s, h);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    connect: () => http2.connect(`http://127.0.0.1:${server.address().port}`),
    close: async () => {
      for (const s of sessions) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}
function serverRequests(stream, onRequest) {
  let pending = Buffer.alloc(0);
  stream.on('data', (b) => {
    pending = Buffer.concat([pending, b]);
    while (pending.length >= 5) {
      const n = pending.readUInt32BE(1);
      if (pending.length < 5 + n) break;
      onRequest(decode(pending.subarray(5, 5 + n)));
      pending = pending.subarray(5 + n);
    }
  });
}
const base = {
  getContext: async () => ({
    owner: 'account-generation-1',
    headers: {
      authorization: 'Bearer SECRET_TOKEN',
      'x-uber-device': 'android',
    },
  }),
  assertOwner: async () => true,
  encodeRamenRequest: encode,
  decodeRamenResponse: decode,
  onMessage: async () => {},
  idleTimeoutMs: 500,
  durationMs: 2000,
  writeTimeoutMs: 100,
  maxReconnects: 0,
  reconnectBaseMs: 1,
  reconnectMaxMs: 1,
};
test('incremental framing split at every byte handles empty and multiple frames', () => {
  const d = new GrpcFrameDecoder({ maxFrameBytes: 32 });
  const expected = [Buffer.from('abc'), Buffer.alloc(0), Buffer.from('defg')],
    wire = Buffer.concat(expected.map((x) => encodeGrpcFrame(x)));
  const actual = [];
  for (const byte of wire) actual.push(...d.push(Buffer.from([byte])));
  d.finish();
  assert.deepEqual(actual, expected);
});
test('oversize, compression and partial EOF fail closed', () => {
  const huge = Buffer.alloc(5);
  huge.writeUInt32BE(33, 1);
  assert.throws(() => new GrpcFrameDecoder({ maxFrameBytes: 32 }).push(huge), {
    code: 'INBOUND_FRAME_TOO_LARGE',
  });
  assert.throws(
    () => new GrpcFrameDecoder().push(Buffer.from([1, 0, 0, 0, 0])),
    { code: 'UNSUPPORTED_GRPC_COMPRESSION' },
  );
  const d = new GrpcFrameDecoder();
  d.push(Buffer.from([0, 0]));
  assert.throws(() => d.finish(), { code: 'TRUNCATED_GRPC_FRAME' });
});
test('initial request precedes response; fragmented messages ACK immediately then feature consumption', async () => {
  let resolveAcks;
  const acksReady = new Promise((r) => (resolveAcks = r)),
    requests = [],
    states = [],
    delivered = [];
  const h = await serverHarness((s, headers) => {
    assert.equal(headers[':path'], RAMEN_PATH);
    assert.equal(headers.authorization, 'Bearer SECRET_TOKEN');
    assert.match(headers['x-uber-streamgate-connection-id'], /^[0-9a-f-]{36}$/);
    let sent = false;
    serverRequests(s, (req) => {
      requests.push(req);
      if (!sent) {
        sent = true;
        s.respond({ ':status': 200, 'content-type': 'application/grpc' });
        const frame = encodeGrpcFrame(
          encode({
            kind: 'messages',
            messages: [
              { seq: '9223372036854775806', uuid: 'one', type: 'other' },
              {
                seq: '9223372036854775807',
                uuid: 'two',
                type: 'trip_driver_location_update_v2',
                requestFeatureAck: true,
              },
            ],
          }),
        );
        for (const byte of frame) s.write(Buffer.from([byte]));
      }
      if (req.featureAcks) resolveAcks();
    });
  });
  const transport = createRamenTransport({
    ...base,
    connectSession: h.connect,
    onState: (x) => states.push(x),
    onMessage: async (m) => delivered.push(m.uuid),
  });
  try {
    await acksReady;
    transport.stop();
    const result = await transport.done;
    assert.equal(result.code, 'STOPPED');
    assert.equal(result.lastSeenSeqId, '9223372036854775807');
    assert.deepEqual(delivered, ['two']);
    assert.deepEqual(
      requests.slice(1, 3).map((x) => x.messageAcks[0].messageId),
      ['one', 'two'],
    );
    assert.equal(requests[3].featureAcks[0].messageId, 'two');
    assert.equal(
      JSON.stringify({ result, states }).includes('SECRET_TOKEN'),
      false,
    );
  } finally {
    transport.stop();
    await h.close();
  }
});
test('generation revocation blocks ACK and delivery; no reconnect with another account', async () => {
  let current = true,
    resolveStarted;
  const started = new Promise((r) => (resolveStarted = r));
  let s,
    requests = 0,
    delivered = 0;
  const h = await serverHarness((stream) => {
    s = stream;
    serverRequests(s, () => {
      requests++;
      s.respond({ ':status': 200, 'content-type': 'application/grpc' });
      resolveStarted();
    });
  });
  const t = createRamenTransport({
    ...base,
    connectSession: h.connect,
    assertOwner: async () => current,
    onMessage: async () => delivered++,
  });
  try {
    await started;
    current = false;
    s.write(
      encodeGrpcFrame(
        encode({
          kind: 'messages',
          messages: [
            { seq: '1', uuid: 'id', type: 'trip_driver_location_update_v2' },
          ],
        }),
      ),
    );
    const result = await t.done;
    assert.equal(result.state, 'revoked');
    assert.equal(result.code, 'OWNER_REVOKED');
    assert.equal(requests, 1);
    assert.equal(delivered, 0);
  } finally {
    t.stop();
    await h.close();
  }
});
test('reconnect uses fresh auth context and resumes maximum sequence', async () => {
  let connections = 0,
    contexts = 0,
    resolveMessage;
  const received = new Promise((r) => (resolveMessage = r));
  const initial = [],
    ids = [];
  const h = await serverHarness((s, headers) => {
    connections++;
    ids.push(headers['x-uber-streamgate-connection-id']);
    let first = true;
    serverRequests(s, (r) => {
      if (first) {
        first = false;
        initial.push(r.lastSeenSeqId);
        s.respond({ ':status': 200, 'content-type': 'application/grpc' });
        if (connections === 1) {
          s.write(
            encodeGrpcFrame(
              encode({
                kind: 'messages',
                messages: [
                  {
                    seq: '9',
                    uuid: 'first',
                    type: 'trip_driver_location_update_v2',
                  },
                ],
              }),
            ),
          );
        } else {
          s.write(
            encodeGrpcFrame(
              encode({
                kind: 'messages',
                messages: [
                  {
                    seq: '10',
                    uuid: 'second',
                    type: 'trip_driver_location_update_v2',
                  },
                ],
              }),
            ),
          );
        }
      } else if (connections === 1 && r.messageAcks) {
        s.close();
      }
    });
  });
  const t = createRamenTransport({
    ...base,
    maxReconnects: 2,
    connectSession: h.connect,
    getContext: async () => {
      contexts++;
      return {
        owner: 'same',
        headers: { authorization: 'Bearer SECRET_TOKEN' },
      };
    },
    onMessage: async (m) => {
      if (m.uuid === 'second') resolveMessage();
    },
  });
  try {
    await received;
    t.stop();
    const result = await t.done;
    assert.ok(contexts >= 2);
    assert.deepEqual(initial.slice(0, 2), ['0', '9']);
    assert.notEqual(ids[0], ids[1]);
    assert.equal(result.lastSeenSeqId, '10');
  } finally {
    t.stop();
    await h.close();
  }
});
test('abort closes idle bidirectional connection promptly', async () => {
  let resolveInitial;
  const initial = new Promise((r) => (resolveInitial = r));
  const h = await serverHarness((s) =>
    serverRequests(s, () => {
      s.respond({ ':status': 200, 'content-type': 'application/grpc' });
      resolveInitial();
    }),
  );
  const abort = new AbortController(),
    t = createRamenTransport({
      ...base,
      connectSession: h.connect,
      signal: abort.signal,
    });
  try {
    await initial;
    abort.abort();
    const r = await t.done;
    assert.equal(r.state, 'stopped');
    assert.equal(r.attempts, 1);
  } finally {
    t.stop();
    await h.close();
  }
});
test('partial final frame fails rather than reconnecting stale data', async () => {
  const h = await serverHarness((s) =>
    serverRequests(s, () => {
      s.respond({ ':status': 200, 'content-type': 'application/grpc' });
      s.end(Buffer.from([0, 0, 0]));
    }),
  );
  const t = createRamenTransport({ ...base, connectSession: h.connect });
  try {
    const r = await t.done;
    assert.equal(r.state, 'failed');
    assert.equal(r.code, 'TRUNCATED_GRPC_FRAME');
  } finally {
    t.stop();
    await h.close();
  }
});
test('bounded idle timeout exhausts configured reconnect limit', async () => {
  const h = await serverHarness((s) =>
    serverRequests(s, () =>
      s.respond({ ':status': 200, 'content-type': 'application/grpc' }),
    ),
  );
  const t = createRamenTransport({
    ...base,
    idleTimeoutMs: 25,
    maxReconnects: 1,
    connectSession: h.connect,
  });
  try {
    const r = await t.done;
    assert.equal(r.code, 'HEARTBEAT_TIMEOUT');
    assert.equal(r.attempts, 2);
  } finally {
    t.stop();
    await h.close();
  }
});
import { EventEmitter } from 'node:events';
test('backpressured writes have a bounded deadline and cancel cleanly', async () => {
  class Stream extends EventEmitter {
    write() {
      return false;
    }
    close() {
      this.destroyed = true;
      this.emit('close');
    }
    pause() {}
    resume() {}
  }
  class Session extends EventEmitter {
    request() {
      this.s = new Stream();
      queueMicrotask(() =>
        this.s.emit('response', {
          ':status': 200,
          'content-type': 'application/grpc',
        }),
      );
      return this.s;
    }
    destroy() {
      this.emit('close');
    }
  }
  const t = createRamenTransport({
    ...base,
    writeTimeoutMs: 15,
    connectSession: () => new Session(),
  });
  const r = await t.done;
  assert.equal(r.code, 'WRITE_TIMEOUT');
  assert.equal(r.attempts, 1);
});
test('reconnect cannot switch credentials into a different account generation', async () => {
  let opened = 0,
    contexts = 0;
  const h = await serverHarness((s) => {
    opened++;
    s.respond({ ':status': 503, 'content-type': 'application/grpc' });
    s.end();
  });
  const t = createRamenTransport({
    ...base,
    maxReconnects: 2,
    connectSession: h.connect,
    getContext: async () => ({
      owner: ++contexts === 1 ? 'old' : 'replacement',
      headers: { authorization: 'Bearer SECRET_TOKEN' },
    }),
  });
  try {
    const r = await t.done;
    assert.equal(r.state, 'revoked');
    assert.equal(r.code, 'OWNER_REVOKED');
    assert.equal(opened, 1);
  } finally {
    t.stop();
    await h.close();
  }
});
import {
  encodeRamenRequest as realEncode,
  decodeRamenResponse as realDecode,
  protobufField,
  protobufFields,
  decodeTripDriverPayload,
} from '../src/ramen-codec.mjs';
test('transport interoperates with parent real protobuf codec and ACK schema', async () => {
  const join = (...x) => Buffer.concat(x),
    uuid = '4b54bc92-b8a2-435b-af30-fb2f6b265092';
  let resolveAck;
  const acked = new Promise((r) => (resolveAck = r)),
    seen = [];
  const payload = Buffer.from(
    JSON.stringify({ tripUuid: 'owned-trip', currentRoute: 'native-route' }),
  );
  const msg = join(
    protobufField(1, 0, 19),
    protobufField(2, 2, 'trip_driver_location_update_v2'),
    protobufField(3, 2, protobufField(1, 2, uuid)),
    protobufField(
      5,
      2,
      join(protobufField(1, 0, 2), protobufField(2, 2, payload)),
    ),
    protobufField(7, 0, 1),
  );
  const envelope = protobufField(1, 2, protobufField(1, 2, msg));
  const h = await serverHarness((s) => {
    let pending = Buffer.alloc(0),
      sent = false;
    s.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const n = pending.readUInt32BE(1);
        if (pending.length < 5 + n) break;
        const fields = protobufFields(pending.subarray(5, 5 + n));
        pending = pending.subarray(5 + n);
        if (!sent) {
          sent = true;
          assert.equal(n, 0);
          s.respond({ ':status': 200, 'content-type': 'application/grpc' });
          s.write(encodeGrpcFrame(envelope));
        }
        for (const field of fields)
          if (field.number === 2 || field.number === 3) {
            const ack = protobufFields(field.value),
              wrapped = protobufFields(ack.find((x) => x.number === 1).value);
            assert.equal(
              wrapped.find((x) => x.number === 1).value.toString(),
              uuid,
            );
            if (field.number === 3) resolveAck();
          }
      }
    });
  });
  const t = createRamenTransport({
    ...base,
    connectSession: h.connect,
    encodeRamenRequest: realEncode,
    decodeRamenResponse: realDecode,
    onMessage: async (m) =>
      seen.push(decodeTripDriverPayload(m.contentType, m.payload)),
  });
  try {
    await acked;
    t.stop();
    const r = await t.done;
    assert.equal(r.lastSeenSeqId, '19');
    assert.deepEqual(seen, [
      { tripUuid: 'owned-trip', currentRoute: 'native-route' },
    ]);
  } finally {
    t.stop();
    await h.close();
  }
});
test('cancellation never waits for a hung auth-context callback', async () => {
  let resolveEntered;
  const entered = new Promise((r) => (resolveEntered = r));
  const t = createRamenTransport({
    ...base,
    getContext: () => {
      resolveEntered();
      return new Promise(() => {});
    },
    connectSession: () => assert.fail('must not connect'),
  });
  await entered;
  t.stop();
  const result = await t.done;
  assert.equal(result.code, 'STOPPED');
});
test('cancellation never waits for a hung owner check', async () => {
  let resolveEntered;
  const entered = new Promise((r) => (resolveEntered = r));
  const t = createRamenTransport({
    ...base,
    assertOwner: () => {
      resolveEntered();
      return new Promise(() => {});
    },
    connectSession: () => assert.fail('must not connect'),
  });
  await entered;
  t.stop();
  const result = await t.done;
  assert.equal(result.code, 'STOPPED');
});
test('trailers-only unauthenticated response refreshes context before reconnect', async () => {
  let attempt = 0;
  const reasons = [];
  const h = await serverHarness((s) => {
    attempt++;
    s.respond({
      ':status': 200,
      'content-type': 'application/grpc',
      'grpc-status': '16',
    });
    s.end();
  });
  const t = createRamenTransport({
    ...base,
    maxReconnects: 1,
    connectSession: h.connect,
    getContext: async ({ reason }) => {
      reasons.push(reason);
      return { owner: 'same', headers: { authorization: 'Bearer fixture' } };
    },
  });
  try {
    const r = await t.done;
    assert.equal(r.code, 'GRPC_UNAUTHENTICATED');
    assert.deepEqual(reasons, ['initial', 'GRPC_UNAUTHENTICATED']);
    assert.equal(attempt, 2);
  } finally {
    t.stop();
    await h.close();
  }
});
