// Optional networked visual smoke test. CLI runtime has no browser dependency.
// PLAYWRIGHT_MODULE must resolve to an installed Playwright ESM entry point.
import assert from 'node:assert/strict';
import { startMapServer } from '../src/map-server.mjs';

if (!process.env.PLAYWRIGHT_MODULE)
  throw new Error(
    'Set PLAYWRIGHT_MODULE to an installed Playwright module path',
  );
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const a = { lat: 37.7749, lon: -122.4194 };
const b = { lat: 37.7749, lon: -122.4189 };
const c = { lat: 37.7754, lon: -122.4189 };
const d = { lat: 37.7759, lon: -122.4189 };
let next = false,
  publish;
const scene = () => ({
  state: 'replay',
  status: 'Synthetic browser test',
  tripId: 'synthetic',
  pollingIntervalMs: 8000,
  driver: { position: { ...(next ? c : a), epoch: next ? 2 : 1, course: 90 } },
  routes: [
    {
      kind: 'provider',
      points: next ? [c, d] : [a, b, c, d],
      encodedPolyline: next ? 'fixture-second' : 'fixture-first',
    },
  ],
  waypoints: [{ ...d, kind: 'pickup' }],
  eta: { pickupDisplay: next ? '2 min' : '1 min' },
});
const viewer = await startMapServer(
  { durationSeconds: 120 },
  {
    getScene: async () => scene(),
    subscribeToScenes: (listener) => {
      publish = listener;
      return () => {
        publish = null;
      };
    },
  },
);
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 700, height: 700 },
    colorScheme: 'dark',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
  // Test-only instrumentation captures renderer validation errors as well as JS
  // exceptions. A silently rejected layer must fail this smoke test.
  await page.route('**/viewer.mjs', async (route) => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace(
        "map.on('load', () => {",
        "map.on('load', () => { window.testMap = map;",
      )
      .replace(
        "map.on('error', () => {",
        "map.on('error', event => { (window.testErrors ??= []).push(event.error?.message);",
      );
    await route.fulfill({ response, body });
  });
  await page.goto(viewer.mapUrl);
  await page.waitForSelector('.driver');
  await page.waitForFunction(() =>
    window.testMap?.getLayer('ride-route-pulse'),
  );
  await page.evaluate(() => {
    const map = window.testMap,
      source = map.getSource('ride-routes');
    const paint = map.setPaintProperty.bind(map),
      setData = source.setData.bind(source);
    window.proof = {
      node: document.querySelector('.driver'),
      pulse: [],
      starts: [],
    };
    map.setPaintProperty = (id, name, value, ...rest) => {
      if (id === 'ride-route-pulse' && name === 'line-gradient')
        window.proof.pulse.push(JSON.stringify(value));
      return paint(id, name, value, ...rest);
    };
    source.setData = (data, ...rest) => {
      window.proof.starts.push(
        JSON.stringify(data.features[0]?.geometry.coordinates[0]),
      );
      return setData(data, ...rest);
    };
  });
  await page.waitForFunction(() =>
    document.fonts.check('500 16px \"Uber Move Text\"'),
  );
  assert.equal(
    await page.locator('.waypoint-callout-body').textContent(),
    '1 min',
  );
  next = true;
  const sentAt = Date.now();
  publish(scene());
  await page.waitForFunction(
    () =>
      document.querySelector('.waypoint-callout-body')?.textContent === '2 min',
    { timeout: 2000 },
  );
  const etaDeliveryMs = Date.now() - sentAt;
  await page.waitForTimeout(7000);
  const result = await page.evaluate(() => ({
    markerReused: window.proof.node === document.querySelector('.driver'),
    pulseFrames: new Set(window.proof.pulse).size,
    trimmedPositions: new Set(window.proof.starts).size,
    errors: window.testErrors ?? [],
  }));
  assert.equal(result.markerReused, true);
  assert.ok(result.pulseFrames > 20);
  assert.ok(result.trimmedPositions > 20);
  assert.deepEqual(result.errors, []);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(2000);
    assert.equal(
      await page.evaluate(() => !!window.testMap.getLayer('ride-route-pulse')),
      true,
    );
  }
  assert.deepEqual(await page.evaluate(() => window.testErrors ?? []), []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: true, synthetic: true, etaDeliveryMs, ...result }),
  );
} finally {
  await browser?.close();
  await viewer.close();
}
