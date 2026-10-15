// Uber Android4.651.10003 GeneratedMessageLite + Kotlin Wire adapters.
// Field ledger: docs/map-parity.md; no account records or generated APK code.
const LIMIT = 8 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
export function varint(value) {
  let n = BigInt(value);
  if (n < 0n) n = BigInt.asUintN(64, n);
  if (n > 0xffffffffffffffffn)
    throw new Error('Protobuf integer exceeds 64 bits');
  const bytes = [];
  do {
    const b = Number(n & 127n);
    n >>= 7n;
    bytes.push(b | (n ? 128 : 0));
  } while (n);
  return Buffer.from(bytes);
}
export function protobufField(number, wire, value) {
  if (!Number.isSafeInteger(number) || number < 1 || number > 0x1fffffff)
    throw new Error('Invalid protobuf field');
  const tag = varint(BigInt(number) * 8n + BigInt(wire));
  if (wire === 0) return Buffer.concat([tag, varint(value)]);
  if (wire === 2) {
    const data =
      typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
    return Buffer.concat([tag, varint(data.length), data]);
  }
  if (wire === 1) {
    const data = Buffer.alloc(8);
    data.writeDoubleLE(value);
    return Buffer.concat([tag, data]);
  }
  throw new Error('Unsupported protobuf encoder wire type');
}
function readVarint(data, offset) {
  let value = 0n;
  for (let count = 0; count < 10; count++) {
    if (offset >= data.length) throw new Error('Truncated protobuf varint');
    const b = data[offset++];
    if (count === 9 && b > 1)
      throw new Error('Protobuf varint exceeds 64 bits');
    value |= BigInt(b & 127) << BigInt(count * 7);
    if (!(b & 128)) return [value, offset];
  }
  throw new Error('Invalid protobuf varint');
}
export function protobufFields(input) {
  const data = Buffer.from(input);
  if (data.length > LIMIT) throw new Error('Protobuf message exceeds limit');
  const out = [];
  let offset = 0;
  while (offset < data.length) {
    let tag;
    [tag, offset] = readVarint(data, offset);
    const number = Number(tag >> 3n),
      wire = Number(tag & 7n);
    if (number < 1 || number > 0x1fffffff || out.length >= 10000)
      throw new Error('Invalid or excessive protobuf fields');
    let value, length;
    if (wire === 0) [value, offset] = readVarint(data, offset);
    else {
      if (wire === 2) {
        let n;
        [n, offset] = readVarint(data, offset);
        if (n > BigInt(LIMIT)) throw new Error('Protobuf field exceeds limit');
        length = Number(n);
      } else if (wire === 1) length = 8;
      else if (wire === 5) length = 4;
      else throw new Error('Unsupported protobuf wire type');
      if (offset + length > data.length)
        throw new Error('Truncated protobuf field');
      value = data.subarray(offset, offset + length);
      offset += length;
    }
    out.push({ number, wire, value });
  }
  return out;
}
const field = (fields, number, wire) =>
  fields.findLast((f) => f.number === number && f.wire === wire)?.value;
const text = (value) => (value === undefined ? undefined : utf8.decode(value));
const int = (value) => {
  if (value === undefined) return undefined;
  const number = Number(BigInt.asIntN(64, value));
  if (!Number.isSafeInteger(number))
    throw new Error('Integer exceeds exact numeric range');
  return number;
};
const double = (value) =>
  value === undefined ? undefined : value.readDoubleLE();
const uuidValue = (value) =>
  value === undefined ? undefined : text(field(protobufFields(value), 1, 2));
const message = (...items) => Buffer.concat(items.filter(Boolean));

export function encodeRamenRequest({
  lastSeenSeqId = 0,
  messageAcks = [],
  featureAcks = [],
} = {}) {
  if (messageAcks.length > 2048 || featureAcks.length > 2048)
    throw new Error('Too many acknowledgements');
  const seq = BigInt(lastSeenSeqId);
  if (seq < 0n || seq > 0x7fffffffffffffffn)
    throw new Error('Invalid stream sequence');
  const uuid = (id) => protobufField(1, 2, protobufField(1, 2, id));
  return message(
    seq === 0n ? null : protobufField(1, 0, seq),
    ...messageAcks.map((ack) =>
      protobufField(2, 2, uuid(typeof ack === 'string' ? ack : ack.messageId)),
    ),
    ...featureAcks.map((ack) =>
      protobufField(
        3,
        2,
        message(
          uuid(ack.messageId),
          ack.consumptionTimeInMs === undefined
            ? null
            : protobufField(2, 0, ack.consumptionTimeInMs),
          ack.background ? protobufField(3, 0, 1) : null,
          ...(ack.consumerPlugins ?? []).map((plugin) =>
            protobufField(4, 2, plugin),
          ),
        ),
      ),
    ),
  );
}
export function decodeRamenResponse(data) {
  // Last recognized oneof member wins, as in the generated protobuf parser.
  const root = protobufFields(data)
    .filter((f) => f.wire === 2 && f.number >= 1 && f.number <= 4)
    .at(-1);
  if (!root) return { kind: 'unknown' };
  if (root.number === 3)
    return {
      kind: 'heartbeat',
      heartbeat: text(field(protobufFields(root.value), 1, 2)) ?? '',
    };
  if (root.number === 2)
    return {
      kind: 'control',
      reason: Number(field(protobufFields(root.value), 1, 0) ?? 0n),
    };
  if (root.number === 4) return { kind: 'graphql-status' };
  const messages = [];
  for (const entry of protobufFields(root.value)) {
    if (entry.number !== 1 || entry.wire !== 2) continue;
    if (messages.length >= 2048) throw new Error('Too many stream messages');
    const fields = protobufFields(entry.value),
      content = field(fields, 5, 2);
    const body = content === undefined ? [] : protobufFields(content);
    messages.push({
      seq: (field(fields, 1, 0) ?? 0n).toString(),
      type: text(field(fields, 2, 2)),
      uuid: uuidValue(field(fields, 3, 2)),
      contentType: Number(field(body, 1, 0) ?? 0n),
      payload: field(body, 2, 2) ?? Buffer.alloc(0),
      requestFeatureAck: field(fields, 7, 0) === 1n,
    });
  }
  return { kind: 'messages', messages };
}
export function decodeTripDriverPayload(contentType, input) {
  const payload = Buffer.from(input);
  if (payload.length > LIMIT) throw new Error('Driver message exceeds limit');
  if (contentType === 2) {
    const data = JSON.parse(utf8.decode(payload));
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('Invalid JSON driver message');
    return data; // The scene projector below this boundary performs closed validation.
  }
  if (contentType !== 1) throw new Error('Unsupported driver content type');
  const fields = protobufFields(payload),
    out = {};
  out.tripUuid = text(field(fields, 2, 2));
  for (const [tag, name] of [
    [3, 'currentRoute'],
    [5, 'etaToPickupString'],
    [6, 'etaToPickupStringShort'],
    [8, 'encodedCurrentTraffic'],
  ]) {
    const value = text(field(fields, tag, 2));
    if (value !== undefined) out[name] = value;
  }
  const eta = field(fields, 4, 0);
  if (eta !== undefined) out.etaToPickup = Number(BigInt.asIntN(32, eta));
  const detached = field(fields, 10, 0);
  if (detached !== undefined) out.isAgentDetached = detached !== 0n;
  out.vehiclePathPoints = [];
  out.prediction = [];
  for (const f of fields) {
    if (f.wire !== 2 || ![1, 7].includes(f.number)) continue;
    if (out.vehiclePathPoints.length + out.prediction.length >= 4000)
      throw new Error('Driver path exceeds limit');
    const nested = protobufFields(f.value);
    if (f.number === 1) {
      const point = {};
      for (const [tag, name] of [
        [1, 'latitude'],
        [2, 'longitude'],
        [3, 'course'],
        [4, 'epoch'],
        [5, 'speed'],
      ]) {
        const value = double(field(nested, tag, 1));
        if (value !== undefined) point[name] = value;
      }
      out.vehiclePathPoints.push(point);
    } else
      out.prediction.push({
        distanceInMeters: double(field(nested, 1, 1)) ?? 0,
        timestamp: int(field(nested, 2, 0)) ?? 0,
      });
  }
  return out;
}
