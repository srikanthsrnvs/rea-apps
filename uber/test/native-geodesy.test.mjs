import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  androidDistanceAndBearing,
  onRhumbSegment,
  nativeGeodesy,
} from '../src/native-geodesy.mjs';

test('Android Java reference distance/bearing float bits match global edge fixtures', () => {
  const fixtures = JSON.parse(
    fs.readFileSync(
      new URL('./fixtures/android-geodesy.json', import.meta.url),
    ),
  );
  const bits = (x) => {
    const v = new DataView(new ArrayBuffer(4));
    v.setFloat32(0, x);
    return v.getInt32(0);
  };
  for (const { coordinates, bits: expected } of fixtures) {
    const r = androidDistanceAndBearing(...coordinates);
    assert.deepEqual(
      [r.distance, r.initialBearing, r.finalBearing].map(bits),
      expected,
    );
  }
});

test('native rhumb matching crosses antimeridian and uses strict tolerance', () => {
  assert.equal(
    onRhumbSegment(
      { lat: 0, lon: 180 },
      { lat: 0, lon: 179 },
      { lat: 0, lon: -179 },
      0.1,
    ),
    true,
  );
  assert.equal(
    onRhumbSegment(
      { lat: 0.00001, lon: 0.005 },
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0.01 },
      0.1,
    ),
    false,
  );
  assert.equal(
    nativeGeodesy.heading({ lat: 0, lon: 0 }, { lat: 0, lon: -1 }),
    270,
  );
});
