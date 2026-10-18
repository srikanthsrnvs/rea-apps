import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { encodeBlackbox, decodeBlackbox, serializeBlackboxFields, serializeTrustPayload, decodeTrustPayload, collectLinuxTrust } from '../src/trust.mjs';

// Synthetic fixtures from an independent Java translation of the shipped codec.
// DEFLATE output is noncanonical across runtimes; verify decoded framing/fields.
const fixtures = [
  { name: 'empty', fields: [], encoded: '0740uhSb8ZedxQECAwQ=' },
  { name: 'ASCII', fields: [['BBSC', 'Linux'], ['HOST', 'fixture-host']], encoded: '0740uhSb8Zee5pluYQ67rrUEU7e91WWCvMS2p/BskUUvQKzYdvZUPQdU5gQSfAECAwQ=' },
  { name: 'UTF8', fields: [['π', 'café 🎵'], ['a', 'b']], encoded: '0740uhSb8Zee5qlmz3yVyyDFJoeL+DinI6qSyHfkufoh1gECAwQ=' },
  { name: 'long compressed field', fields: [['repeat', 'x'.repeat(20000)]], encoded: '0740ZOcdyZe91bnohTKgRXQ0j5ivsz+KX+c4nHgNJGNciszG77bfl5zFuVgQfLHYs9b1iSSswJecxfagEQECAwQ=' },
];
for (const fixture of fixtures) test(`Trust codec reads Java fixture: ${fixture.name}`, () => {
  const input = new Map(fixture.fields);
  assert.deepEqual([...decodeBlackbox(fixture.encoded)], [...input]);
  assert.deepEqual([...decodeBlackbox(encodeBlackbox(input, { mask: Buffer.from([1, 2, 3, 4]) }))], [...input]);
});

test('blackbox randomization preserves data, blank values are absent, UTF8 lengths count bytes', () => {
  const fields = { empty: '', missing: null, whitespace: '\t', value: '😀' };
  assert.equal(serializeBlackboxFields(fields), '00010005value0004😀');
  const first = encodeBlackbox(fields), second = encodeBlackbox(fields);
  assert.notEqual(first, second);
  assert.deepEqual([...decodeBlackbox(first)], [['value', '😀']]);
  assert.deepEqual([...decodeBlackbox(second)], [['value', '😀']]);
});

test('blackbox decoder and field lengths are bounded', () => {
  assert.throws(() => encodeBlackbox({ value: 'x'.repeat(65536) }));
  assert.throws(() => encodeBlackbox({ value: 'x' }, { mask: Buffer.alloc(3) }));
  assert.throws(() => decodeBlackbox('invalid'));
  assert.throws(() => decodeBlackbox('0740AAAA'));
});

test('Trust JSON preserves native Gson pretty printing, HTML escaping and null policy', () => {
  const encoded = serializeTrustPayload({ absent: null, array: [null, "<x>&='"], number: 1 });
  assert.equal(Buffer.from(encoded, 'base64').toString(), '{\n  "array": [\n    null,\n    "\\u003cx\\u003e\\u0026\\u003d\\u0027"\n  ],\n  "number": 1\n}');
  assert.deepEqual(decodeTrustPayload(encoded), { array: [null, "<x>&='"], number: 1 });
});

test('Trust collection rejects unsupported operating systems', { skip: process.platform === 'linux' }, async () => {
  await assert.rejects(() => collectLinuxTrust(), { code: 'UNSUPPORTED_PLATFORM' });
});

test('Linux collection uses actual measurements and native local completion semantics', { skip: process.platform !== 'linux' }, async () => {
  const result = await collectLinuxTrust();
  const payload = decodeTrustPayload(result.encoded), dependency = payload.configuredDependencies[0];
  const blackbox = decodeBlackbox(dependency.payload);
  assert.equal(blackbox.get('BBSC'), os.type());
  assert.equal(blackbox.get('HOST'), os.hostname());
  assert.equal(blackbox.get('PHEN'), '0');
  assert.match(blackbox.get('EXCPT'), /unavailable/);
  assert.equal(blackbox.get('APPID'), 'rea-apps.expedia.cli');
  for (const field of ['ROOT', 'AASN', 'ANDROID_ID', 'AFPCL']) assert.equal(blackbox.has(field), false);
  assert.equal(payload.executionContext.fingerprint, undefined);
  assert.equal(payload.executionContext.placementPage, 1);
  assert.equal(payload.executionContext.placement, 'DEFAULT');
  assert.equal(dependency.status, 'COMPLETE');
  assert.equal(payload.status, payload.diagnostics.errors.length ? 'ERROR' : 'COMPLETE');
  assert.equal(result.provenance.networkCalls, 0);
  assert.equal(result.provenance.androidIdentity, false);
  assert.equal(result.provenance.attestation, false);
});
