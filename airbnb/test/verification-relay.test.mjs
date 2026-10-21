import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createVerificationRelay } from '../src/verification-relay.mjs';

const publicKey = '8D4A627D-4688-4C42-9B29-9EBEDE945B70';
const token = 'genuine-fixture-token-1234567890';
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airbnb-verification-'));
  const relay = await createVerificationRelay({ directory, publicKey, ...options });
  t.after(async () => { await relay.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const port = await relay.listen(), base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${relay.key}`, 'content-type': 'application/json' };
  return { directory, relay, base, headers, post: body => fetch(`${base}/result`, { method: 'POST', headers, body: JSON.stringify(body) }) };
}

test('verification relay serves only official iframe and protects configuration/status', async t => {
  const { base, headers, relay } = await fixture(t, { dataExchangeBlob: 'a+b/c=d &x%25' });
  const page = await fetch(base), html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /<iframe /);
  assert.doesNotMatch(html, /<form|<input|Airbnb CLI|REA|branding/i);
  assert.match(page.headers.get('content-security-policy'), /frame-src https:\/\/iframe\.arkoselabs\.com/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await fetch(`${base}/config`)).status, 401);
  assert.equal((await fetch(`${base}/status`)).status, 401);
  assert.equal((await fetch(`${base}/config`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const config = await fetch(`${base}/config`, { headers }).then(r => r.json());
  const url = new URL(config.frameURL);
  assert.equal(url.origin, 'https://iframe.arkoselabs.com');
  assert.equal(url.pathname, `/${publicKey}/index.html`);
  assert.equal(url.searchParams.get('data'), 'a+b/c=d &x%25');
  assert.equal(config.publicKey, publicKey);
  assert.equal(relay.status().status, 'waiting');
});

test('only completed vendor events persist owner-only tokens and completion is one shot', async t => {
  const { directory, base, headers, post, relay } = await fixture(t);
  for (const eventId of ['challenge-loaded', 'challenge-shown', 'unknown']) {
    assert.equal((await post({ eventId, publicKey, payload: { sessionToken: token } })).status, 400);
  }
  assert.equal((await post({ eventId: 'challenge-complete', publicKey: 'wrong', payload: { sessionToken: token } })).status, 400);
  assert.equal((await post({ eventId: 'challenge-complete', publicKey, payload: { sessionToken: 'short' } })).status, 400);
  const complete = { eventId: 'challenge-suppressed', publicKey, payload: { sessionToken: token } };
  const results = await Promise.all([post(complete), post(complete)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'verification-result.json'), 'utf8'));
  assert.equal(saved.token, token); assert.equal(saved.id, relay.id); assert.equal(saved.publicKey, publicKey);
  assert.equal((await fs.stat(path.join(directory, 'verification-result.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  const status = await fetch(`${base}/status`, { headers }).then(r => r.json());
  assert.equal(status.status, 'completed');
  assert.doesNotMatch(JSON.stringify(status), new RegExp(token));
  assert.equal((await post(complete)).status, 409);
});

test('failure events never retain a token, malformed and oversized submissions are bounded', async t => {
  const { directory, base, headers, post } = await fixture(t);
  assert.equal((await fetch(`${base}/result`, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/result`, { method: 'POST', headers: { authorization: headers.authorization }, body: '{}' })).status, 415);
  assert.equal((await post({ value: 'x'.repeat(30_000) })).status, 413);
  assert.equal((await post({ eventId: 'challenge-failed', publicKey, payload: { sessionToken: token, error: 'failed' } })).status, 200);
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'verification-result.json'), 'utf8'));
  assert.equal(saved.status, 'failed'); assert.equal(saved.token, undefined);
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(token));
});

test('client accepts only matching vendor origin, iframe window, key and final event', async t => {
  const { base, headers } = await fixture(t);
  const script = await fetch(`${base}/client.mjs`).then(r => r.text());
  const config = await fetch(`${base}/config`, { headers }).then(r => r.json());
  const frame = { contentWindow: {} }, listeners = [], calls = [];
  const context = vm.createContext({
    location: { hash: '#key=capability', pathname: '/' }, history: { replaceState() {} }, URLSearchParams,
    document: { title: '', querySelector: () => frame },
    window: { addEventListener(name, listener) { if (name === 'message') listeners.push(listener); } },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => config }; },
  });
  await new vm.Script(`(async()=>{${script}\n})()`).runInContext(context);
  assert.equal(frame.src, config.frameURL);
  const message = { eventId: 'challenge-complete', publicKey, payload: { sessionToken: token } };
  const event = { origin: 'https://iframe.arkoselabs.com', source: frame.contentWindow, data: JSON.stringify(message) };
  await listeners[0]({ ...event, origin: 'https://untrusted.invalid' });
  await listeners[0]({ ...event, source: {} });
  await listeners[0]({ ...event, data: message });
  await listeners[0]({ ...event, data: JSON.stringify({ ...message, publicKey: 'wrong' }) });
  await listeners[0]({ ...event, data: JSON.stringify({ ...message, eventId: 'challenge-loaded' }) });
  assert.equal(calls.length, 1);
  await listeners[0](event); await listeners[0](event);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/result');
  assert.equal(JSON.parse(calls[1].options.body).payload.sessionToken, token);
  assert.equal(context.document.title, 'Verification complete');
});

test('expiry closes listener and never creates a successful result', async t => {
  const { directory, base, relay } = await fixture(t, { ttlMs: 100 });
  await delay(150);
  assert.equal(relay.status().status, 'expired');
  await assert.rejects(fetch(base));
  await assert.rejects(fs.readFile(path.join(directory, 'verification-result.json')), { code: 'ENOENT' });
});

test('authenticated stop revokes listener without persisting a verification result', async t => {
  const { directory, base, headers } = await fixture(t);
  assert.equal((await fetch(`${base}/stop`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/stop`, { method: 'POST', headers })).status, 200);
  await assert.rejects(fetch(`${base}/status`, { headers }));
  await assert.rejects(fs.readFile(path.join(directory, 'verification-result.json')), { code: 'ENOENT' });
});

async function waitFile(filename, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${path.basename(filename)}`);
}

test('worker publishes capability URL then cleans up its exact tunnel after completion', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airbnb-worker-'));
  const tunnel = path.join(directory, 'fake-tunnel.mjs'), marker = path.join(directory, 'tunnel-stopped');
  await fs.writeFile(tunnel, `#!${process.execPath}\nimport fs from 'node:fs';\nprocess.stderr.write('https://fixture-');setTimeout(()=>process.stderr.write('verification.trycloudflare.com\\n'),5);\nprocess.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'stopped');process.exit(0)});\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
  await fs.writeFile(path.join(directory, 'verification-config.json'), JSON.stringify({ publicKey, cloudflared: tunnel, ttlMs: 10_000 }), { mode: 0o600 });
  const worker = spawn(process.execPath, [new URL('../src/verification-worker.mjs', import.meta.url).pathname, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => worker.once('exit', (code, signal) => resolve({ code, signal })));
  let stderr = ''; worker.stderr.on('data', chunk => { stderr += chunk; }); worker.stdout.resume();
  t.after(async () => { if (worker.exitCode === null) worker.kill('SIGTERM'); await exited; await fs.rm(directory, { recursive: true, force: true }); });
  const ready = await waitFile(path.join(directory, 'verification-url.json'));
  assert.equal(new URL(ready.url).hostname, 'fixture-verification.trycloudflare.com');
  const host = await waitFile(path.join(directory, 'verification-host.json'));
  assert.equal(ready.id, host.id); assert.equal(ready.pid, worker.pid);
  assert.equal(new URLSearchParams(new URL(ready.url).hash.slice(1)).get('key'), host.key);
  const response = await fetch(`http://127.0.0.1:${host.port}/result`, { method: 'POST', headers: { authorization: `Bearer ${host.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ eventId: 'challenge-complete', publicKey, payload: { sessionToken: token } }) });
  assert.equal(response.status, 200);
  const result = await waitFile(path.join(directory, 'verification-result.json'));
  assert.equal(result.id, host.id); assert.equal(result.token, token);
  assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
  assert.equal(await fs.readFile(marker, 'utf8'), 'stopped');
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'verification-host.json'), 'utf8')).status, 'closed');
  await assert.rejects(fetch(`http://127.0.0.1:${host.port}/status`));
});

test('invalid or missing tunnel fails without a lingering relay', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airbnb-worker-fail-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'verification-config.json'), JSON.stringify({ publicKey, cloudflared: path.join(directory, 'missing'), ttlMs: 2000 }), { mode: 0o600 });
  const worker = spawn(process.execPath, [new URL('../src/verification-worker.mjs', import.meta.url).pathname, directory], { stdio: 'ignore' });
  assert.equal(await new Promise(resolve => worker.once('exit', resolve)), 1);
  const error = await waitFile(path.join(directory, 'verification-error.json'));
  assert.equal(error.code, 'TUNNEL_START_FAILED');
  const host = await waitFile(path.join(directory, 'verification-host.json'));
  assert.equal(host.status, 'closed'); assert.equal(host.key, undefined);
});

for (const mode of ['cancel', 'expire']) {
  test(`worker ${mode} closes its owned tunnel and publishes closed metadata last`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `airbnb-worker-${mode}-`));
    const tunnel = path.join(directory, 'fake-tunnel.mjs'), marker = path.join(directory, 'tunnel-stopped');
    await fs.writeFile(tunnel, `#!${process.execPath}\nimport fs from 'node:fs';\nprocess.stderr.write('https://fixture-verification.trycloudflare.com\\n');\nprocess.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'stopped');process.exit(0)});setInterval(()=>{},1000);\n`, { mode: 0o700 });
    await fs.writeFile(path.join(directory, 'verification-config.json'), JSON.stringify({ publicKey, cloudflared: tunnel, ttlMs: mode === 'expire' ? 1000 : 10_000 }), { mode: 0o600 });
    const worker = spawn(process.execPath, [new URL('../src/verification-worker.mjs', import.meta.url).pathname, directory], { stdio: 'ignore' });
    const exited = new Promise(resolve => worker.once('exit', (code, signal) => resolve({ code, signal })));
    t.after(async () => { if (worker.exitCode === null) worker.kill('SIGTERM'); await exited; await fs.rm(directory, { recursive: true, force: true }); });
    await waitFile(path.join(directory, 'verification-url.json'));
    const host = await waitFile(path.join(directory, 'verification-host.json'));
    if (mode === 'cancel') {
      const response = await fetch(`http://127.0.0.1:${host.port}/stop`, { method: 'POST', headers: { authorization: `Bearer ${host.key}` } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, 'closing');
    }
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.equal(await fs.readFile(marker, 'utf8'), 'stopped');
    const closed = await waitFile(path.join(directory, 'verification-host.json'));
    assert.equal(closed.id, host.id); assert.equal(closed.status, 'closed'); assert.equal(closed.key, undefined);
    await assert.rejects(fetch(`http://127.0.0.1:${host.port}/status`));
    await assert.rejects(fs.readFile(path.join(directory, 'verification-result.json')), { code: 'ENOENT' });
  });
}
