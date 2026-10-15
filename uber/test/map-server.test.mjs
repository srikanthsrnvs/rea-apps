import test from 'node:test';
import assert from 'node:assert/strict';
import { startMapServer, mapServerOptions, mapSessionGuard } from '../src/map-server.mjs';

const scene = { schemaVersion: 1, state: 'idle', tripId: null, pollingIntervalMs: 8000, driver: { position: null, path: [] }, routes: [], waypoints: [] };
function access(viewer) {
  const url = new URL(viewer.mapUrl);
  const key = new URLSearchParams(url.hash.slice(1)).get('key');
  return { url: new URL('state', url), headers: { authorization: `Bearer ${key}` } };
}

test('iframe page has no credentials and trip data requires a fragment-bound viewer key', async t => {
  let calls = 0;
  const viewer = await startMapServer({}, { getScene: async () => { calls++; return scene; } });
  t.after(() => viewer.close());
  const page = await fetch(viewer.mapUrl);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors \*/);
  const html = await page.text();
  const { url, headers } = access(viewer);
  assert.ok(!html.includes(headers.authorization));
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const result = await fetch(url, { headers });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('access-control-allow-origin'), null);
  assert.deepEqual((await result.json()).scene, scene);
  assert.equal(calls, 1);
  assert.equal((await fetch(url, { headers: { ...headers, origin: 'https://other.example' } })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers })).status, 405);
  assert.equal((await fetch(new URL('auth/session.json', viewer.mapUrl))).status, 404);
  assert.equal((await fetch(new URL('viewer.mjs', viewer.mapUrl))).status, 200);
  assert.equal((await fetch(new URL('map-style.mjs', viewer.mapUrl))).status, 200);
});

test('all viewers share one server-cadenced read and failures never silently present stale data as current', async t => {
  let time = 1000, calls = 0, fail = false;
  const viewer = await startMapServer({}, { now: () => time, getScene: async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    if (fail) throw new Error('private credential example that must not escape');
    return { ...scene, revision: calls };
  } });
  t.after(() => viewer.close());
  const { url, headers } = access(viewer);
  time += 8001;
  const batch = await Promise.all(Array.from({ length: 6 }, () => fetch(url, { headers })));
  assert.ok(batch.every(response => response.status === 200));
  for (const response of batch) assert.equal((await response.json()).scene.revision, 2);
  assert.equal(calls, 2);
  time += 8001; fail = true;
  const failedBatch = await Promise.all(Array.from({ length: 6 }, () => fetch(url, { headers })));
  assert.ok(failedBatch.every(response => response.status === 503));
  const first = failedBatch[0];
  assert.equal(first.status, 503);
  assert.ok(!(await first.text()).includes('credential'));
  assert.equal((await fetch(url, { headers })).status, 503);
  assert.equal(calls, 3);
  time += 8001; fail = false;
  assert.equal((await fetch(url, { headers })).status, 200);
  assert.equal(calls, 4);
});

test('expiry and exact parent origins bound a viewer lease and proxy paths are retained', async t => {
  let time = 0;
  const viewer = await startMapServer({ publicUrl: 'https://orin.example/tools/uber', frameOrigins: ['https://client.example'], durationSeconds: 10 }, { getScene: async () => scene, now: () => time });
  t.after(() => viewer.close());
  assert.equal(new URL(viewer.mapUrl).pathname, '/tools/uber/');
  const local = `http://127.0.0.1:${viewer.listening.port}`;
  const html = await fetch(`${local}/tools/uber/`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/client\.example/);
  assert.equal((await fetch(`${local}/`)).status, 404);
  time = 10000;
  assert.equal((await fetch(`${local}/tools/uber/`)).status, 410);
});

test('rejects invalid network/proxy/embedding configuration before reading the account', async () => {
  for (const input of [
    { host: '0.0.0.0' }, { port: '-1' }, { port: '3.5' }, { durationSeconds: 1 },
    { publicUrl: 'file:///private' }, { publicUrl: 'https://user:password@orin.example' },
    { publicUrl: 'https://orin.example/?key=secret' }, { frameOrigins: ['https://client.example/path'] },
    { frameOrigins: ["https://client.example/#' unsafe-inline"] },
  ]) assert.throws(() => mapServerOptions(input));
  let calls = 0;
  await assert.rejects(startMapServer({ host: '0.0.0.0' }, { getScene: () => { calls++; } }));
  assert.equal(calls, 0);
});

test('logout or account change revokes access even while a snapshot is cached', async t => {
  let allowed = true;
  const viewer = await startMapServer({}, { getScene: async () => scene, isAuthorized: async () => allowed });
  t.after(() => viewer.close());
  const { url, headers } = access(viewer);
  assert.equal((await fetch(url, { headers })).status, 200);
  allowed = false;
  const response = await fetch(url, { headers });
  assert.equal(response.status, 410);
  assert.ok(!(await response.text()).includes('schemaVersion'));
  allowed = true;
  assert.equal((await fetch(url, { headers })).status, 410);
});

test('session generations survive refresh and cannot be revived by same-user login', async () => {
  let session = { userUUID: 'fixture-owner', accessToken: 'fixture-token' };
  const store = { withStateLock: fn => fn(), readState: async () => session, saveState: async (_, value) => { session = structuredClone(value); } };
  const original = await mapSessionGuard(store);
  assert.equal(await original(), true);
  session = { ...session, accessToken: 'refreshed', receivedAt: 'new' };
  assert.equal(await original(), true);
  session = null;
  assert.equal(await original(), false);
  session = { userUUID: 'fixture-owner', accessToken: 'fresh-login' };
  assert.equal(await original(), false);
  const next = await mapSessionGuard(store);
  assert.equal(await next(), true);
  assert.equal(await original(), false);
});

test('a longer server polling interval is respected across viewers', async t => {
  let time = 0, calls = 0;
  const viewer = await startMapServer({}, { now: () => time, getScene: async () => { calls++; return { ...scene, pollingIntervalMs: 120000 }; } });
  t.after(() => viewer.close());
  const { url, headers } = access(viewer);
  time += 60001;
  assert.equal((await fetch(url, { headers })).status, 200);
  assert.equal(calls, 1);
  time += 60001;
  assert.equal((await fetch(url, { headers })).status, 200);
  assert.equal(calls, 2);
});
