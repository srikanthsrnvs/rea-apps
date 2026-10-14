import test from 'node:test';
import assert from 'node:assert/strict';
import { startLogin, completeLogin, validateLogin, pollLogin, cancelLogin, authStatus, logout, normalizePhone } from '../src/auth.mjs';
import { ownerBinding } from '../src/ordering-protocol.mjs';

const time = 1_700_000_000_000;
const clone = v => structuredClone(v);
function fixture(intercept) {
  const prior = { token: 'old-private-token', deviceId: 'old-device', account: { id: 'old-account' } };
  const values = new Map([['session', clone(prior)], ['operation-example', { status: 'unknown' }], ['cart-plan', { ready: true }]]);
  let queue = Promise.resolve(), locked = false, clock = time;
  const store = {
    async readState(name) { return clone(values.get(name) ?? null); },
    async saveState(name, value) { values.set(name, clone(value)); },
    async removeState(name) { values.delete(name); },
    async withStateLock(callback) { const run = queue.then(async () => { locked = true; try { return await callback(); } finally { locked = false; } }); queue = run.catch(() => {}); return run; },
  };
  const calls = [];
  async function send(endpoint, options) {
    assert.equal(locked, true, 'all auth sends run under the mutex');
    calls.push({ endpoint, options: clone(options) });
    const value = await intercept?.(endpoint, options, { store, calls, values });
    if (value !== undefined) return clone(value);
    if (endpoint === '/v1/login') return { error: 0, message: 'Successfully Login', user: { _id: 'new-account' } };
    if (endpoint === '/v1/phoneverify') return { error: 0, token: 'new-private-token', cart_id: 'migrated-cart', user: { _id: 'new-account', first_name: 'Test' } };
    if (endpoint === '/v1/userprofile') return { error: 0, user: { _id: 'new-account', first_name: 'Test', ecrs_details_confirmed: 'yes' } };
    if (endpoint === '/v2/myerewhon') return { error: 0, message: 'OK', ecrs_data: {}, current_tier: {}, membership_data: {}, member_benefits: [] };
    assert.fail(`Unexpected endpoint ${endpoint}`);
  }
  return { values, prior, store, calls, options: { store, send, now: () => clock }, advance(ms) { clock += ms; } };
}
const answer = started => ({ loginId: started.loginId, code: '0012' });
const err = (code, status) => Object.assign(new Error('synthetic failure'), { code, ...(status ? { status } : {}) });

test('US normalization rejects other country prefixes and preserves national digits', () => {
  assert.equal(normalizePhone('+1 (202) 555-0100'), '2025550100');
  assert.equal(normalizePhone('2025550100'), '2025550100');
  for (const phone of ['+44 2025550100', '+2025550100', '2025550100abc', '123']) assert.throws(() => normalizePhone(phone), { code: 'INVALID_PHONE' });
});

test('concurrent starts for the same phone send one SMS and reuse the login ID', async () => {
  const f = fixture();
  const [one, two] = await Promise.all([startLogin({ phone: '2025550100' }, f.options), startLogin({ phone: '+1 2025550100' }, f.options)]);
  assert.equal(one.loginId, two.loginId); assert.equal(one.status, 'waiting_for_code');
  assert.deepEqual(one.challenge, { channel: 'sms', contact: '+1 ***0100', codeLength: 4 });
  assert.equal(f.calls.length, 1);
  await assert.rejects(startLogin({ phone: '2025550101' }, f.options), { code: 'LOGIN_PENDING' });
  assert.deepEqual(await f.store.readState('session'), f.prior);
});

test('existing login uses exact form, validates two reads, then promotes without leaking tokens', async () => {
  const f = fixture(async endpoint => {
    if (endpoint === '/v1/userprofile' || endpoint === '/v2/myerewhon') assert.deepEqual(await f.store.readState('session'), f.prior);
  });
  await f.store.saveState('cart', { cartId: 'guest-cart', store: 'selected-store', cartTypeId: 'primary' });
  const started = await startLogin({ phone: '2025550100' }, f.options);
  const done = await completeLogin(answer(started), f.options);
  assert.equal(done.status, 'authenticated');
  assert.deepEqual(f.calls.map(x => x.endpoint), ['/v1/login', '/v1/phoneverify', '/v1/userprofile', '/v2/myerewhon']);
  const verify = f.calls[1].options;
  assert.deepEqual(verify.form, { phone: '2025550100', otp: '0012', userDetails: '{}', device_id: (await f.store.readState('context')).deviceId, cart_id: 'guest-cart' });
  assert.equal(verify.token, undefined); assert.equal(f.calls[2].options.token, 'new-private-token');
  const session = await f.store.readState('session');
  assert.equal(session.token, 'new-private-token'); assert.equal(session.cartId, 'migrated-cart');
  const migrated = await f.store.readState('cart');
  assert.equal(migrated.cartId, 'migrated-cart'); assert.equal(migrated.store, 'selected-store'); assert.equal(migrated.cartTypeId, 'primary');
  assert.equal(migrated.deviceId, session.deviceId); assert.equal(migrated.owner, ownerBinding(session));
  assert.equal(session.validatedAt, time); assert.equal(Object.hasOwn(session, 'phone'), false);
  assert.equal(await f.store.readState('candidate-session'), null);
  assert.equal(JSON.stringify(done).includes('new-private-token'), false);
  assert.equal(JSON.stringify(await authStatus(f.options)).includes('new-private-token'), false);
  assert.equal(JSON.stringify(await pollLogin({}, f.options)).includes('2025550100'), false);
});

test('new-user branch stops without verification or storing its provisional token', async () => {
  const f = fixture(endpoint => endpoint === '/v1/login' ? { error: 2, net_new_user: true, token: 'provisional-secret' } : undefined);
  const started = await startLogin({ phone: '2025550100' }, f.options);
  assert.equal(started.status, 'registration_required'); assert.equal(f.calls.length, 1);
  await assert.rejects(completeLogin(answer(started), f.options), { code: 'LOGIN_CODE_NOT_EXPECTED' });
  assert.equal(JSON.stringify([...f.values]).includes('provisional-secret'), false);
  assert.deepEqual(await f.store.readState('session'), f.prior);
});

test('a stale login ID and malformed code make no request', async () => {
  const f = fixture(), started = await startLogin({ phone: '2025550100' }, f.options);
  await assert.rejects(completeLogin({ code: '0012' }, f.options), { code: 'LOGIN_ID_MISMATCH' });
  await assert.rejects(completeLogin({ loginId: 'other-id', code: '0012' }, f.options), { code: 'LOGIN_ID_MISMATCH' });
  await assert.rejects(completeLogin({ loginId: started.loginId, code: '12' }, f.options), { code: 'INVALID_CODE' });
  assert.equal(f.calls.length, 1);
});

test('concurrent code completion cannot replay an accepted OTP', async () => {
  const f = fixture(), started = await startLogin({ phone: '2025550100' }, f.options);
  const results = await Promise.allSettled([completeLogin(answer(started), f.options), completeLogin(answer(started), f.options)]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'LOGIN_CODE_NOT_EXPECTED');
  assert.equal(f.calls.filter(x => x.endpoint === '/v1/phoneverify').length, 1);
});

test('a definite rejected code allows an explicit corrected answer without SMS resend', async () => {
  let wrong = true;
  const f = fixture(endpoint => { if (endpoint === '/v1/phoneverify' && wrong) { wrong = false; return { error: 1, message: 'private rejection' }; } });
  const started = await startLogin({ phone: '2025550100' }, f.options);
  await assert.rejects(completeLogin(answer(started), f.options), { code: 'LOGIN_CODE_REJECTED' });
  assert.equal((await pollLogin({}, f.options)).status, 'waiting_for_code');
  await completeLogin(answer(started), f.options);
  assert.equal(f.calls.filter(x => x.endpoint === '/v1/login').length, 1);
});

test('network uncertainty and server failure stop code replay and preserve the previous account', async t => {
  for (const failure of [err('NETWORK_ERROR'), err('HTTP_ERROR', 503)]) await t.test(failure.code, async () => {
    const f = fixture(endpoint => { if (endpoint === '/v1/phoneverify') throw failure; });
    const started = await startLogin({ phone: '2025550100' }, f.options);
    await assert.rejects(completeLogin(answer(started), f.options));
    assert.equal((await pollLogin({}, f.options)).status, 'outcome_unknown');
    await assert.rejects(completeLogin(answer(started), f.options), { code: 'LOGIN_CODE_NOT_EXPECTED' });
    await assert.rejects(startLogin({ phone: '2025550100' }, f.options), { code: 'LOGIN_OUTCOME_UNKNOWN' });
    assert.equal(f.calls.length, 2); assert.deepEqual(await f.store.readState('session'), f.prior);
  });
});

test('interrupted start is detected locally and not sent again', async () => {
  const f = fixture(), started = await startLogin({ phone: '2025550100' }, f.options);
  const pending = await f.store.readState('login'); await f.store.saveState('login', { ...pending, status: 'starting' });
  assert.equal((await pollLogin({ loginId: started.loginId }, f.options)).status, 'outcome_unknown');
  assert.equal(f.calls.length, 1);
});

test('validation can resume after a failure without repeating verification', async () => {
  let failed = false;
  const f = fixture(endpoint => { if (endpoint === '/v2/myerewhon' && !failed) { failed = true; throw err('NETWORK_ERROR'); } });
  const started = await startLogin({ phone: '2025550100' }, f.options);
  await assert.rejects(completeLogin(answer(started), f.options), { code: 'NETWORK_ERROR' });
  assert.equal((await pollLogin({}, f.options)).status, 'validation_pending'); assert.deepEqual(await f.store.readState('session'), f.prior);
  assert.equal((await validateLogin({ loginId: started.loginId }, f.options)).status, 'authenticated');
  assert.equal(f.calls.filter(x => x.endpoint === '/v1/phoneverify').length, 1);
});

test('candidate saved just before a crash is recovered for validation only', async () => {
  const f = fixture(), started = await startLogin({ phone: '2025550100' }, f.options);
  const pending = await f.store.readState('login');
  await f.store.saveState('candidate-session', { loginId: started.loginId, token: 'new-private-token', deviceId: pending.deviceId, account: { id: 'new-account' } });
  await f.store.saveState('login', { ...pending, status: 'submitting' });
  assert.equal((await pollLogin({}, f.options)).status, 'validation_pending');
  await validateLogin({ loginId: started.loginId }, f.options);
  assert.deepEqual(f.calls.map(x => x.endpoint), ['/v1/login', '/v1/userprofile', '/v2/myerewhon']);
});

test('candidate account mismatch fails validation and keeps the prior session', async () => {
  const f = fixture(endpoint => endpoint === '/v1/userprofile' ? { error: 0, user: { _id: 'different-account' } } : undefined);
  const started = await startLogin({ phone: '2025550100' }, f.options);
  await assert.rejects(completeLogin(answer(started), f.options), { code: 'LOGIN_ACCOUNT_MISMATCH' });
  assert.deepEqual(await f.store.readState('session'), f.prior); assert.equal((await pollLogin({}, f.options)).status, 'validation_pending');
});

test('unconfirmed profile is surfaced without changing its fields or sending membership requests', async () => {
  const f = fixture(endpoint => endpoint === '/v1/userprofile' ? { error: 0, user: { _id: 'new-account', ecrs_details_confirmed: 'no' } } : undefined);
  const started = await startLogin({ phone: '2025550100' }, f.options), done = await completeLogin(answer(started), f.options);
  assert.equal(done.profileConfirmationRequired, true); assert.equal(f.calls.length, 4);
});

test('local login timeout and cancellation remove secrets without deleting mutation journals', async () => {
  const f = fixture(), started = await startLogin({ phone: '2025550100' }, f.options);
  f.advance(15 * 60 * 1000);
  assert.equal((await pollLogin({}, f.options)).status, 'expired');
  await cancelLogin({ loginId: started.loginId }, f.options); await logout(f.options);
  assert.equal(await f.store.readState('session'), null);
  assert.deepEqual(await f.store.readState('operation-example'), { status: 'unknown' });
  assert.deepEqual(await f.store.readState('cart-plan'), { ready: true });
  assert.ok((await f.store.readState('context')).deviceId);
});

test('missing account identity cannot produce a candidate or replace the prior session',async()=>{
 const f=fixture(endpoint=>endpoint==='/v1/phoneverify'?{error:0,token:'private',user:{first_name:'Test'}}:undefined);
 const started=await startLogin({phone:'2025550100'},f.options);
 await assert.rejects(completeLogin(answer(started),f.options),{code:'LOGIN_PROTOCOL_CHANGED'});
 assert.equal(await f.store.readState('candidate-session'),null);assert.deepEqual(await f.store.readState('session'),f.prior);
});

test('native success must have a recognized membership structure; paid membership is not required',async t=>{
 await t.test('unrecognized',async()=>{
  const f=fixture(endpoint=>endpoint==='/v2/myerewhon'?{error:0,message:'OK'}:undefined);
  const started=await startLogin({phone:'2025550100'},f.options);
  await assert.rejects(completeLogin(answer(started),f.options),{code:'LOGIN_VALIDATION_FAILED'});assert.deepEqual(await f.store.readState('session'),f.prior);
 });
 await t.test('nonmember',async()=>{
  const f=fixture(endpoint=>endpoint==='/v2/myerewhon'?{error:0,ecrs_data:null,current_tier:null,membership_data:null}:undefined);
  const started=await startLogin({phone:'2025550100'},f.options);
  assert.equal((await completeLogin(answer(started),f.options)).status,'authenticated');
 });
});

test('missing profile confirmation flag remains unconfirmed',async()=>{
 const f=fixture(endpoint=>endpoint==='/v1/userprofile'?{error:0,user:{_id:'new-account'}}:undefined);
 const started=await startLogin({phone:'2025550100'},f.options);
 assert.equal((await completeLogin(answer(started),f.options)).profileConfirmationRequired,true);
});

test('validated account change rebinds the migrated cart and drops another account’s cached locations',async()=>{
 const f=fixture();await f.store.saveState('cart',{cartId:'old-cart',owner:'different-owner',store:{name:'another-account-store'},address:{private:'another-account-address'}});
 const started=await startLogin({phone:'2025550100'},f.options);await completeLogin(answer(started),f.options);
 const cart=await f.store.readState('cart');assert.equal(cart.cartId,'migrated-cart');assert.equal(cart.store,undefined);assert.equal(cart.address,undefined);assert.match(cart.owner,/^[a-f0-9]{64}$/);
 assert.deepEqual(await f.store.readState('operation-example'),{status:'unknown'});
});
