import test from 'node:test';
import assert from 'node:assert/strict';
import {
  protobufField as f,
  varint,
  protobufFields,
  encodeRamenRequest,
  decodeRamenResponse,
  decodeTripDriverPayload,
} from '../src/ramen-codec.mjs';
const msg = (...xs) => Buffer.concat(xs),
  text = (x) => Buffer.from(x);
test('native proto3 zero cursor is empty and nested UUID receipt ACK uses exact field tags', () => {
  assert.equal(encodeRamenRequest().toString('hex'), '');
  assert.equal(
    encodeRamenRequest({ lastSeenSeqId: 300 }).toString('hex'),
    '08ac02',
  );
  assert.equal(
    encodeRamenRequest({ messageAcks: [{ messageId: 'id' }] }).toString('hex'),
    '12060a040a026964',
  );
  const fields = protobufFields(
    encodeRamenRequest({
      lastSeenSeqId: '9007199254740993',
      featureAcks: [
        { messageId: 'id', consumptionTimeInMs: 10, consumerPlugins: ['map'] },
      ],
    }),
  );
  assert.equal(fields[0].value, 9007199254740993n);
  assert.equal(fields[1].number, 3);
});
test('captured native idle heartbeat decodes without invented echo or subscription', () =>
  assert.deepEqual(decodeRamenResponse(Buffer.from('1a030a013a', 'hex')), {
    kind: 'heartbeat',
    heartbeat: ':',
  }));
test('Ramen envelopes preserve 64-bit cursors, topic, UUID, content type and payload', () => {
  const content = msg(f(1, 0, 2), f(2, 2, '{"tripUuid":"fixture"}'));
  const item = msg(
    f(1, 0, 9007199254740993n),
    f(2, 2, 'trip_driver_location_update_v2'),
    f(3, 2, f(1, 2, 'fixture-msg')),
    f(5, 2, content),
    f(7, 0, 1),
  );
  const d = decodeRamenResponse(f(1, 2, f(1, 2, item)));
  assert.equal(d.messages[0].seq, '9007199254740993');
  assert.equal(d.messages[0].uuid, 'fixture-msg');
  assert.equal(d.messages[0].contentType, 2);
  assert.equal(d.messages[0].requestFeatureAck, true);
  assert.equal(
    decodeTripDriverPayload(2, d.messages[0].payload).tripUuid,
    'fixture',
  );
  assert.equal(
    decodeRamenResponse(
      msg(f(1, 2, f(1, 2, item)), Buffer.from('1a030a013a', 'hex')),
    ).kind,
    'heartbeat',
  );
});
test('binary driver DTO reads DOUBLE epoch, minute ETA, seconds predictions and optional strings', () => {
  const point = msg(
    f(1, 1, 1.2),
    f(2, 1, 2.3),
    f(3, 1, 90),
    f(4, 1, 1700000000123),
  );
  const d = decodeTripDriverPayload(
    1,
    msg(
      f(1, 2, point),
      f(2, 2, 'fixture'),
      f(3, 2, 'encoded'),
      f(4, 0, 3),
      f(6, 2, '3 min'),
      f(7, 2, msg(f(1, 1, 12.5), f(2, 0, 7))),
      f(10, 0, 1),
    ),
  );
  assert.equal(d.vehiclePathPoints[0].epoch, 1700000000123);
  assert.equal(d.etaToPickup, 3);
  assert.equal(d.etaToPickupStringShort, '3 min');
  assert.deepEqual(d.prediction, [{ distanceInMeters: 12.5, timestamp: 7 }]);
  assert.equal(d.isAgentDetached, true);
  assert.equal(decodeTripDriverPayload(1, f(4, 0, -1)).etaToPickup, -1);
});
test('protobuf parsing bounds lengths, varints, tags and malformed UTF8', () => {
  for (const b of [
    Buffer.from([0]),
    Buffer.from([0x0b]),
    Buffer.from([0x12, 3, 0]),
    Buffer.from([8, ...Array(10).fill(255)]),
  ])
    assert.throws(() => protobufFields(b));
  assert.throws(() => varint(1n << 64n));
  assert.throws(() => decodeTripDriverPayload(9, text('{}')));
  assert.throws(() => decodeTripDriverPayload(2, Buffer.from([255])));
  assert.throws(() => decodeTripDriverPayload(2, text('[]')));
});
