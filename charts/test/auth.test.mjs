import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createSessionStore } from '../src/session.mjs';
import { createAuth, credentialsFromHeaders } from '../src/auth.mjs';
import { createAttempt, parseCallback, completionUrl } from '../src/auth-protocol.mjs';

const callback = 'tradingview://browser-auth/?token=synthetic-grant';
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'charts-auth-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, store: createSessionStore(directory) };
}
const issued = () => new Response('{}', { status: 200, headers: { 'set-cookie': 'sessionid=synthetic-session; Domain=.tradingview.com; Path=/; Secure; HttpOnly' } });
const previous = { version: 1, credentials: { session: 'previous-session' }, account: { id: 1, username: 'old' }, savedAt: '2026-10-26T00:00:00Z' };

test('the recovered native grant binds the approval hash to a private host proof', () => {
  const pending = createAttempt();
  const url = new URL(pending.approvalUrl);
  assert.equal(url.origin, 'https://auth.tradingview.com'); assert.equal(url.pathname, '/accounts/tvd/connect/');
  assert.equal(url.searchParams.get('key'), createHash('sha256').update(pending.keySource).digest('hex'));
  assert.equal(url.searchParams.get('redirect_url'), 'tradingview://browser-auth/');
  assert.equal(pending.keySource.length, 32);
  assert.equal(parseCallback(callback), 'synthetic-grant');
  const complete = completionUrl(pending, 'synthetic-grant');
  assert.equal(complete.pathname, '/accounts/tvd/complete/'); assert.equal(complete.searchParams.get('key_source'), pending.keySource);
  for (const value of ['https://evil.test/?token=secret', 'tradingview://other/?token=secret', callback + '&token=other', callback + '#x']) assert.throws(() => parseCallback(value));
});

test('session cookies retain domain scope and reject credential injection', () => {
  const headers = new Headers();
  headers.append('set-cookie', 'sessionid=ignored; Domain=evil.test; Path=/');
  assert.deepEqual(credentialsFromHeaders(headers, 'https://auth.tradingview.com/'), {});
  headers.append('set-cookie', 'sessionid=accepted; Domain=.tradingview.com; Path=/; Secure');
  assert.deepEqual(credentialsFromHeaders(headers, 'https://auth.tradingview.com/'), { session: 'accepted' });
});

test('callback exchange saves only after independent validation and keeps credentials private', async t => {
  const { directory, store } = await fixture(t); let exchanges = 0, reads = 0;
  const auth = createAuth({ store, sdk: async () => ({ getUser: async credentials => {
    reads++; assert.equal(credentials.session, 'synthetic-session'); return { id: 42, username: 'expected', authToken: 'never-return' };
  } }), request: async (url, options) => { exchanges++; assert.equal(new URL(url).pathname, '/accounts/tvd/complete/'); assert.equal(options.redirect, 'manual'); return issued(); } });
  const login = await auth.login({ username: 'expected' });
  assert.equal((await auth.login({})).loginId, login.loginId);
  const result = await auth.complete({ 'login-id': login.loginId, 'callback-url': callback }, AbortSignal.timeout(5000));
  assert.equal(result.status, 'authenticated'); assert.equal(reads, 1); assert.equal(exchanges, 1);
  assert.equal((await store.load()).account.id, 42);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-session|never-return|keySource/);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(directory, 'session.json'))).mode & 0o777, 0o600);
  assert.equal((await auth.complete({ 'login-id': login.loginId }, AbortSignal.timeout(5000))).status, 'authenticated');
  assert.equal(exchanges, 1);
});

test('failed validation preserves the existing account and retry never repeats the exchange', async t => {
  const { store } = await fixture(t); await store.save(previous);
  let exchanges = 0, validationWorks = false;
  const auth = createAuth({ store, sdk: async () => ({ getUser: async () => {
    if (!validationWorks) throw Object.assign(new Error('private-provider-body'), { code: 'HTTP_ERROR' });
    return { id: 42, username: 'new' };
  } }), request: async () => { exchanges++; return issued(); } });
  const login = await auth.login({ replace: true });
  await assert.rejects(auth.complete({ 'login-id': login.loginId, 'callback-url': callback }, AbortSignal.timeout(5000)));
  assert.equal((await store.load()).account.id, 1);
  assert.equal((await auth.status()).pending.phase, 'validating');
  validationWorks = true;
  await auth.complete({ 'login-id': login.loginId }, AbortSignal.timeout(5000));
  assert.equal((await store.load()).account.id, 42); assert.equal(exchanges, 1);
});

test('lost exchange responses cannot be replayed and cancellation preserves saved credentials', async t => {
  const { store } = await fixture(t); await store.save(previous); let calls = 0;
  const auth = createAuth({ store, sdk: async () => ({}), request: async () => { calls++; throw new Error('lost response'); } });
  const login = await auth.login({ replace: true });
  await assert.rejects(auth.complete({ 'login-id': login.loginId, 'callback-url': callback }, AbortSignal.timeout(5000)));
  await assert.rejects(auth.complete({ 'login-id': login.loginId, 'callback-url': callback }, AbortSignal.timeout(5000)), { code: 'AUTH_OUTCOME_UNKNOWN' });
  assert.equal(calls, 1); await auth.cancel(); assert.equal((await store.load()).account.id, 1);
  assert.equal((await auth.status()).pending, null);
});

test('native additional 2FA never saves an unvalidated session or launches a helper', async t => {
  const { store } = await fixture(t);
  const auth = createAuth({ store, sdk: async () => { throw new Error('must not validate'); },
    request: async () => new Response(JSON.stringify({ code: '2FA_required' }), { status: 409 }) });
  const login = await auth.login({});
  const result = await auth.complete({ 'login-id': login.loginId, 'callback-url': callback }, AbortSignal.timeout(5000));
  assert.equal(result.status, 'additional_verification_required'); assert.equal(await store.load(), null);
});

test('private state serializes concurrent changes and refuses a session symlink', async t => {
  const { directory, store } = await fixture(t); await store.write('counter', { count: 0 });
  await Promise.all(Array.from({ length: 5 }, () => store.lock(async () => {
    const value = await store.read('counter'); await new Promise(resolve => setTimeout(resolve, 2));
    await store.write('counter', { count: value.count + 1 });
  })));
  assert.equal((await store.read('counter')).count, 5);
  await fs.writeFile(path.join(directory, 'elsewhere'), JSON.stringify(previous));
  await fs.symlink(path.join(directory, 'elsewhere'), path.join(directory, 'session.json'));
  await assert.rejects(store.load(), { code: 'STATE_ERROR' });
});

test('completion recovers a saved candidate after interruption without exchanging twice', async t => {
  const { store } = await fixture(t);
  let exchanges = 0, interrupted = true;
  const auth = createAuth({ store: { ...store, write: async (name, value) => {
    if (name === 'pending-login' && value.phase === 'validating' && interrupted) { interrupted = false; throw new Error('simulated interruption'); }
    return store.write(name, value);
  } }, sdk: async () => ({ getUser: async () => ({ id: 42, username: 'new' }) }),
  request: async () => { exchanges++; return issued(); } });
  const login = await auth.login({});
  await assert.rejects(auth.complete({ 'login-id': login.loginId, 'callback-url': callback }, AbortSignal.timeout(5000)));
  assert.equal((await auth.status()).pending.phase, 'exchanging');
  assert.equal((await auth.complete({ 'login-id': login.loginId }, AbortSignal.timeout(5000))).status, 'authenticated');
  assert.equal(exchanges, 1); assert.equal((await store.load()).account.id, 42);
});

test('completion reconciles a committed account when cleanup was interrupted', async t => {
  const { store } = await fixture(t);
  let interrupted = true, exchanges = 0;
  const auth = createAuth({ store: { ...store, removeRecord: async name => {
    if (name === 'pending-login' && interrupted) { interrupted = false; throw new Error('simulated interruption'); }
    return store.removeRecord(name);
  } }, sdk: async () => ({ getUser: async () => ({ id: 42, username: 'new' }) }),
  request: async () => { exchanges++; return issued(); } });
  const login = await auth.login({});
  await assert.rejects(auth.complete({ 'login-id': login.loginId, 'callback-url': callback }, AbortSignal.timeout(5000)));
  assert.equal((await store.load()).account.id, 42);
  assert.equal((await auth.complete({ 'login-id': login.loginId }, AbortSignal.timeout(5000))).status, 'authenticated');
  assert.equal((await auth.status()).pending, null); assert.equal(exchanges, 1);
});

test('private callback files reject symlinks, public modes, oversized files and FIFOs before exchange', async t => {
  const { store, directory } = await fixture(t);
  let exchanges = 0;
  const auth = createAuth({ store, sdk: async () => ({ getUser: async () => ({ id: 42, username: 'new' }) }),
    request: async () => { exchanges++; return issued(); } });
  const login = await auth.login({});
  const file = path.join(directory, 'callback');
  await fs.writeFile(file, callback, { mode: 0o600 });
  const symlink = path.join(directory, 'callback-link'); await fs.symlink(file, symlink);
  const rejectFile = filename => assert.rejects(auth.complete({ 'login-id': login.loginId, 'callback-file': filename }, AbortSignal.timeout(5000)), { code: 'INVALID_ARGUMENT' });
  await rejectFile(symlink);
  await fs.chmod(file, 0o644); await rejectFile(file);
  await fs.chmod(file, 0o600); await fs.writeFile(file, 'x'.repeat(16385)); await rejectFile(file);
  const fifo = path.join(directory, 'callback-fifo'); execFileSync('mkfifo', [fifo]); await rejectFile(fifo);
  assert.equal(exchanges, 0); assert.equal((await auth.status()).pending.phase, 'awaiting_callback');
  await fs.writeFile(file, callback);
  assert.equal((await auth.complete({ 'login-id': login.loginId, 'callback-file': file }, AbortSignal.timeout(5000))).status, 'authenticated');
});

test('an aborted lock waiter cannot exchange credentials or leave a participant behind', async t => {
  const { store, directory } = await fixture(t);
  let release, acquired;
  const acquiredPromise = new Promise(resolve => { acquired = resolve; });
  const holding = store.lock(async () => { acquired(); await new Promise(resolve => { release = resolve; }); });
  await acquiredPromise;
  const controller = new AbortController();
  const waiting = store.lock(() => assert.fail('cancelled waiter acquired the lock'), { signal: controller.signal });
  setTimeout(() => controller.abort(new DOMException('cancelled', 'AbortError')), 10);
  try { await assert.rejects(waiting, { name: 'AbortError' }); }
  finally { release(); await holding; }
  assert.deepEqual(await fs.readdir(path.join(directory, '.state-lock')), []);
});

test('unexpected authorization JSON stays uncertain and cannot be replayed', async t => {
  const { store } = await fixture(t); let exchanges = 0;
  const auth = createAuth({ store, sdk: async () => ({}), request: async () => { exchanges++; return new Response('null'); } });
  const login = await auth.login({});
  await assert.rejects(auth.complete({ 'login-id': login.loginId, 'callback-url': callback }, AbortSignal.timeout(5000)), { code: 'PROTOCOL_ERROR' });
  assert.equal((await auth.status()).pending.phase, 'exchange_uncertain');
  await assert.rejects(auth.complete({ 'login-id': login.loginId, 'callback-url': callback }, AbortSignal.timeout(5000)), { code: 'AUTH_OUTCOME_UNKNOWN' });
  assert.equal(exchanges, 1);
});
