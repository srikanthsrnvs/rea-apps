import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { createLoginServer, startTunnel } from '../src/auth-worker.mjs';
import { loginPage, widgetLoginUrl } from '../src/login-page.mjs';
import { loginResult } from '../src/auth.mjs';

const id = 'abcdefghijklmnopqrstuvwxABCDEFGH';
const secret = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const origin = 'https://pair.example';
async function fixture(clientFactory) {
  const data = { login: { loginId: id, secret, status: 'waiting', expiresAt: Date.now() + 60000 }, session: { token: 'previous-session', account: { id: '9' } } };
  const server = createLoginServer({ loginId: id, origin: () => origin, read: async name => data[name], save: async (name, value) => { data[name] = value; }, lock: fn => fn(), clientFactory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function request({ method = 'POST', url = `/pair/${id}/complete`, headers = {}, raw = JSON.stringify({ token: 'received-private-token' }) } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers: { Host: 'pair.example', Origin: origin, 'X-REA-Pair-Key': secret, 'Content-Type': 'application/json', ...headers } }, res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers })); }); req.on('error', reject); req.end(method === 'GET' ? undefined : raw);
    });
  }
  return { data, server, request, close: () => new Promise(resolve => server.close(resolve)) };
}

test('Resy session verifies before save, carries only account projection and is single-use', async () => {
  let calls = 0;
  const f = await fixture(token => ({ me: async () => { calls++; assert.equal(f.data.session.token, 'previous-session'); assert.equal(token, 'received-private-token'); return { id: '123456789012345678', first_name: 'Name', payment_methods: [{ secret: 'never persist' }] }; } }));
  try {
    const response = await f.request(); assert.equal(response.status, 200); assert.deepEqual(JSON.parse(response.body), { status: 'authenticated' });
    assert.equal(f.data.session.token, 'received-private-token'); assert.deepEqual(f.data.session.account, { id: '123456789012345678', firstName: 'Name' }); assert.equal(f.data.session.acquiredBy, 'widget-pairing'); assert.equal(f.data.login.secret, undefined);
    assert.equal((await f.request()).status, 410); assert.equal(calls, 1);
  } finally { await f.close(); }
});

test('handoff rejects foreign origin, Host, secret, malformed body and path before API calls', async () => {
  let calls = 0; const f = await fixture(() => ({ me: async () => { calls++; return { id: '1' }; } }));
  try {
    assert.equal((await f.request({ headers: { Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await f.request({ headers: { Host: 'attacker.example' } })).status, 403);
    assert.equal((await f.request({ headers: { 'X-REA-Pair-Key': 'wrong' } })).status, 403);
    assert.equal((await f.request({ headers: { 'Content-Type': 'text/plain' } })).status, 403);
    assert.equal((await f.request({ raw: '{' })).status, 400);
    assert.equal((await f.request({ raw: JSON.stringify({ token: 'short' }) })).status, 400);
    assert.equal((await f.request({ raw: JSON.stringify({ token: 'token with whitespace' }) })).status, 400);
    assert.equal((await f.request({ raw: JSON.stringify({ token: 'x'.repeat(4097) }) })).status, 400);
    assert.equal((await f.request({ raw: JSON.stringify({ token: 'valid-token', arbitrary: true }) })).status, 400);
    assert.equal((await f.request({ raw: 'x'.repeat(20001) })).status, 400);
    assert.equal((await f.request({ url: `/pair/${id}/complete?token=leak` })).status, 404);
    assert.equal(calls, 0); assert.equal(f.data.login.status, 'waiting');
  } finally { await f.close(); }
});

test('expired or canceled login cannot overwrite a prior session', async () => {
  const f = await fixture(() => ({ me: async () => ({ id: '1' }) }));
  try { f.data.login.expiresAt = Date.now() - 1; assert.equal((await f.request()).status, 410); assert.equal(f.data.session.token, 'previous-session'); f.data.login.expiresAt = Date.now() + 60000; f.data.login.status = 'canceled'; assert.equal((await f.request()).status, 410); } finally { await f.close(); }
});

test('cancellation and supersession during validation prevent session commit', async () => {
  for (const action of ['cancel', 'replace']) {
    let release; let entered; const ready = new Promise(resolve => { entered = resolve; });
    const f = await fixture(() => ({ me: async () => { entered(); return new Promise(resolve => { release = resolve; }); } }));
    try { const response = f.request(); await ready; if (action === 'cancel') f.data.login.status = 'canceled'; else f.data.login = { ...f.data.login, loginId: 'new-login-id', status: 'waiting' }; release({ id: '1' }); assert.equal((await response).status, 409); assert.equal(f.data.session.token, 'previous-session'); } finally { await f.close(); }
  }
});

test('validation failure and malformed account responses retain prior session and redact errors', async () => {
  for (const me of [async () => { throw new Error('private-token-password'); }, async () => ({ unexpected: 'shape' }), async () => ({ id: 1e20 })]) {
    const f = await fixture(() => ({ me }));
    try { const response = await f.request(); assert.ok([401, 502].includes(response.status)); assert.equal(f.data.session.token, 'previous-session'); assert.equal(f.data.login.status, 'failed'); assert.equal(f.data.login.secret, undefined); assert.equal(f.data.login.approvalUrl, undefined); assert.doesNotMatch(JSON.stringify(loginResult(f.data.login)), /private-token-password|received-private-token|secret|previous-session/); } finally { await f.close(); }
  }
});

test('pairing page uses only first-party credential UI with nonce CSP and source/origin checks', async () => {
  const official = new URL(widgetLoginUrl);
  assert.equal(official.origin, 'https://widgets.resy.com');
  const parameters = new URLSearchParams(official.hash.split('?')[1]);
  assert.equal(parameters.get('phone'), ' '); assert.equal(parameters.get('authSuccessRedirectUrl'), 'https://resy.com/');
  const page = loginPage(id); assert.match(page.html, /src="https:\/\/widgets\.resy\.com\/#\/login\?/); assert.doesNotMatch(page.html, /<input|<form|password.*name=/);
  assert.doesNotMatch(page.html, /Connect Resy|Cloudflare|<h1|<p\b|role="status"|textContent/); assert.match(page.html, /inset:0;width:100%;height:100%;border:0/);
  assert.match(page.html, /event\.origin!=="https:\/\/widgets\.resy\.com"/); assert.match(page.html, /event\.source!==frame\.contentWindow/); assert.match(page.html, /event\.data\?\.event!=='loginSync'/); assert.match(page.html, /location\.hash/); assert.match(page.html, /history\.replaceState/);
  assert.doesNotThrow(() => new Function(page.html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]));
  assert.equal(page.headers['Cache-Control'], 'no-store'); assert.equal(page.headers['Referrer-Policy'], 'no-referrer'); assert.match(page.headers['Content-Security-Policy'], /frame-ancestors 'none'/); assert.doesNotMatch(page.html, new RegExp(secret)); assert.throws(() => loginPage('../bad'));
  const f = await fixture(() => ({ me: async () => ({ id: '1' }) }));
  try { const response = await f.request({ method: 'GET', url: `/pair/${id}` }); assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store'); assert.doesNotMatch(response.body, new RegExp(secret)); } finally { await f.close(); }
});

test('status projection never returns session token or internal secret and hides terminal URL', () => {
  const pending = { loginId: id, secret, token: 'private-token', status: 'waiting', expiresAt: Date.now() + 60000, approvalUrl: `${origin}/pair/${id}#key=${secret}` };
  assert.equal(loginResult(pending).approvalUrl, pending.approvalUrl);
  assert.equal(loginResult(pending).secret, undefined); assert.equal(loginResult(pending).token, undefined);
  assert.equal(loginResult({ ...pending, status: 'authenticated' }).approvalUrl, undefined); assert.deepEqual(loginResult(null), { status: 'none' });
});

test('executed page bridge ignores unrelated messages and sends approved result once', async () => {
  const script = loginPage(id).html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const source = {}; let handler, calls = 0, removed = false, cleaned = false, redirected = false;
  const status = {}; const frame = { contentWindow: source, remove() { removed = true; } };
  vm.runInNewContext(script, { URLSearchParams, location: { hash: `#key=${secret}`, pathname: `/pair/${id}`, replace(url) { assert.equal(url, 'https://resy.com/'); redirected = true; } }, document: { getElementById(name) { return name === 'resy' ? frame : status; } }, window: { addEventListener(name, fn) { assert.equal(name, 'message'); handler = fn; } }, history: { replaceState(_state, _title, pathname) { assert.equal(pathname, `/pair/${id}`); cleaned = true; } }, async fetch(url, options) { calls++; assert.equal(url, `/pair/${id}/complete`); assert.equal(options.headers['X-REA-Pair-Key'], secret); assert.equal(options.credentials, 'omit'); assert.equal(JSON.parse(options.body).token, 'received-private-token'); return { ok: true, json: async () => ({ status: 'authenticated' }) }; } });
  const message = { origin: 'https://widgets.resy.com', source, data: { event: 'loginSync', token: 'received-private-token' } };
  await handler({ ...message, origin: 'https://attacker.example' }); await handler({ ...message, source: {} }); await handler({ ...message, data: { event: 'authRedirect', token: message.data.token } }); await handler({ ...message, data: { event: 'loginSync', token: 'token with whitespace' } }); assert.equal(calls, 0);
  await handler(message); assert.equal(calls, 1); assert.equal(removed, false); assert.equal(cleaned, true); assert.equal(redirected, true); await handler(message); assert.equal(calls, 1);
});

test('temporary tunnel starts scoped localhost relay and accepts only provider hostname', async () => {
  const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { child.killed = true; };
  const pending = startTunnel('/approved/cloudflared', 12345, { spawnImpl(binary, args, options) { assert.equal(binary, '/approved/cloudflared'); assert.deepEqual(args, ['tunnel', '--url', 'http://127.0.0.1:12345', '--no-autoupdate']); assert.equal(options.stdio[2], 'pipe'); queueMicrotask(() => { child.stderr.emit('data', 'https://evil.example/ is not accepted\n'); child.stderr.emit('data', 'Your tunnel: https://example-words.trycloudflare.com\n'); }); return child; } });
  const result = await pending; assert.equal(result.url, 'https://example-words.trycloudflare.com'); assert.equal(result.child, child);
  const failed = new EventEmitter(); failed.stderr = new EventEmitter(); failed.kill = () => { failed.killed = true; };
  await assert.rejects(startTunnel('missing', 12345, { spawnImpl() { queueMicrotask(() => failed.emit('error', new Error('not available'))); return failed; } })); assert.equal(failed.killed, true);
});

test('auth polling, cancellation and logout cleanse pending secrets; cloudflared env and PATH resolve', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'resy-auth-test-'));
  const binary = path.join(directory, 'cloudflared'); await fs.writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const resolvedBinary = await fs.realpath(binary);
  const authUrl = new URL('../src/auth.mjs', import.meta.url).href;
  const stateUrl = new URL('../src/state.mjs', import.meta.url).href;
  const script = `import assert from 'node:assert/strict';import{pollLogin,cancelLogin,logout,findCloudflared}from${JSON.stringify(authUrl)};import{readState,saveState}from${JSON.stringify(stateUrl)};
const pending={loginId:'id',secret:'private',approvalUrl:'https://example/#key=private',status:'waiting',expiresAt:Date.now()-1};await saveState('session',{token:'prior-session'});await saveState('login',pending);assert.equal((await pollLogin()).status,'expired');assert.equal((await readState('login')).secret,undefined);assert.equal((await readState('login')).approvalUrl,undefined);assert.equal((await readState('session')).token,'prior-session');await saveState('login',{...pending,expiresAt:Date.now()+60000});assert.equal((await cancelLogin()).status,'canceled');assert.equal((await readState('login')).secret,undefined);await saveState('login',{...pending,expiresAt:Date.now()+60000});await logout();assert.equal(await readState('session'),null);assert.equal((await readState('login')).secret,undefined);assert.equal(await findCloudflared(),${JSON.stringify(resolvedBinary)});await assert.rejects(findCloudflared('/missing/resy-cloudflared'),{code:'TUNNEL_UNAVAILABLE'});delete process.env.RESY_CLOUDFLARED;assert.equal(await findCloudflared(),${JSON.stringify(resolvedBinary)});`;
  try { await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, RESY_CLI_STATE_DIR: directory, RESY_CLOUDFLARED: binary, PATH: directory } }); } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
