import test from 'node:test';
import fs from 'node:fs';
import { nativePathAt } from '../src/native-path-interpolator.mjs';
import assert from 'node:assert/strict';
import {
  routePulseAt,
  cubicBezierAt,
  pulseGradient,
  routeBaseGradient,
} from '../src/route-animation.mjs';

test('migrated native pulse uses its distinct distance and alpha curves on a 2.5s loop', () => {
  const mid = routePulseAt(1250);
  assert.ok(Math.abs(mid.divider - 0.7755613111) < 1e-8);
  const u = 1 - Math.cbrt(0.5),
    colorFade = 3 * u ** 2 - 2 * u ** 3;
  assert.ok(Math.abs(mid.alpha - (178 / 255) * (1 - colorFade)) < 1e-8);
  assert.equal(mid.baseEnd, 1);
  assert.deepEqual(routePulseAt(1250), routePulseAt(3750));
  assert.equal(routePulseAt(0).divider, 0);
  assert.equal(routePulseAt(2500).divider, 0);
});
test('legacy native path reveals over 1s before its linear-alpha repeating pulse', () => {
  assert.equal(routePulseAt(500, 'legacy').alpha, 0);
  assert.equal(routePulseAt(500, 'legacy').baseEnd, 0.7751051187515259);
  assert.equal(routePulseAt(2250, 'legacy').alpha, 127 / 255);
  assert.equal(routePulseAt(1000, 'legacy').divider, 0);
});
test('pulse timing validates inputs and keeps monotone bounded timing curves', () => {
  let prior = 0;
  for (let i = 0; i <= 100; i++) {
    const next = cubicBezierAt(i / 100, [0.4, 0, 0.2, 1]);
    assert.ok(next >= prior && next <= 1);
    prior = next;
  }
  assert.throws(() => routePulseAt(NaN));
  assert.throws(() => routePulseAt(0, 'invented'));
  assert.throws(() => cubicBezierAt(0.5, [-1, 0, 1, 1]));
});
test('line adapter never produces duplicate gradient stops at pulse boundaries', () => {
  for (const divider of [0, 1e-10, 0.5, 1 - 1e-10, 1]) {
    for (const gradient of [
      pulseGradient({ divider, alpha: 0.5 }),
      routeBaseGradient({ baseEnd: divider }),
    ]) {
      const stops = gradient.slice(3).filter((_, index) => index % 2 === 0);
      assert.ok(
        stops.every((stop, index) => !index || stop > stops[index - 1]),
      );
    }
  }
});

test('framework lookup matches all 2002 independent on-device interpolation results', () => {
  const fixtures = JSON.parse(
    fs.readFileSync(
      new URL('./fixtures/android-path-interpolators.json', import.meta.url),
    ),
  );
  const buffer = new DataView(new ArrayBuffer(4));
  for (const [curve, data] of Object.entries(fixtures)) {
    for (let i = 0; i < data.expectedBits.length; i++) {
      buffer.setFloat32(0, nativePathAt(i / data.divisor, curve));
      assert.equal(
        buffer.getUint32(0),
        data.expectedBits[i],
        `${curve} fraction ${i}/${data.divisor}`,
      );
    }
  }
});
