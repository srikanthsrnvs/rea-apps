import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airbnb-auth-test-'));
process.env.AIRBNB_STATE_DIR = directory;
const { login, authStep, authStatus } = await import('../src/auth.mjs');
const { readState, saveState } = await import('../src/state.mjs');
const { createAuthFlow, buildAuthRequest } = await import('../src/auth-protocol.mjs');
const { dispatch } = await import('../src/cli.mjs');
const originalFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const challenge = { nextStepConfig: { emailOtp: { email: 'person@example.invalid', fallbackChallenges: [] } } };
const completed = { nextStepConfig: {}, authentication: { userId_str: '123', isNewAccount: false, nativeTokens: { token: 'candidate-token', aaj: { aaj: 'candidate-aaj', maxAgeSecs: 300 } } } };
const account = { data: { viewer: { email: 'person@example.invalid', user: { id: Buffer.from('User:123').toString('base64'), firstName: 'Example' } } } };
async function reset() {
  for (const file of await fs.readdir(directory)) await fs.rm(path.join(directory, file), { recursive: true, force: true });
  await saveState('request-context', { everestDeviceId: 'registered-test-device', everestExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
}

test('durable authentication lifecycle', async t => {
  try {
    await t.test('CLI phone login dispatches one initial code and repeated calls reuse pending or saved state', async () => {
      await reset(); let identifies = 0, dispatches = 0;
      globalThis.fetch = async url => {
        if (url.pathname === '/v2/auth/identify/phone') {
          identifies++;
          return json({ nextStepConfig: { smsOtp: { phoneNumber: '+15555550123', fallbackChallenges: [] } } });
        }
        assert.equal(url.pathname, '/v2/phone_one_time_passwords');
        dispatches++;
        return json({ success: true, deliveryMethod: 'TEXT', codeLength: 6 });
      };
      const args = ['login', '--phone', '+15555550123', '--country', 'US'];
      const start = await dispatch(args);
      assert.equal(start.status, 'code_required');
      assert.equal(start.codeDispatch.accepted, true);
      assert.equal((await dispatch(args)).loginId, start.loginId);
      await saveState('session', { token: 'already-saved' });
      assert.equal((await dispatch(args)).status, 'session_saved');
      assert.equal(identifies, 1); assert.equal(dispatches, 1);
    });
    await t.test('code is submitted once and the independently validated account replaces a session', async () => {
      await reset(); let posts = 0; let reads = 0;
      globalThis.fetch = async (url, options) => {
        assert.equal(url.searchParams.get('client_id'), '3092nxybyb0otqw18e8nh5nty');
        if (url.pathname === '/v3') { reads++; assert.equal(options.headers['x-airbnb-oauth-token'], 'candidate-token'); return json(account); }
        posts++;
        const body = JSON.parse(options.body);
        if (posts === 1) return json(challenge);
        assert.equal(body.steps[1].emailOtpChallenge.otp, '001234');
        return json(completed);
      };
      const start = await login({ email: 'person@example.invalid' });
      assert.equal(start.status, 'code_required');
      const end = await authStep({ loginId: start.loginId, code: '001234' });
      assert.equal(end.status, 'authenticated');
      assert.equal(posts, 2); assert.equal(reads, 1);
      assert.equal(await readState('login'), null);
      assert.equal((await readState('session')).token, 'candidate-token');
      assert.equal((await fs.stat(path.join(directory, 'session.json'))).mode & 0o777, 0o600);
      assert.ok(!JSON.stringify(await authStatus()).includes('candidate-token'));
    });
    await t.test('an interrupted account read is recoverable without resending the OTP or replacing the old account', async () => {
      await reset(); let posts = 0; let allowRead = false;
      await saveState('session', { token: 'old-token' });
      globalThis.fetch = async url => {
        if (url.pathname === '/v3') { if (!allowRead) throw Error('disconnected'); return json(account); }
        return json(++posts === 1 ? challenge : completed);
      };
      const start = await login({ email: 'person@example.invalid', replace: true });
      await assert.rejects(authStep({ loginId: start.loginId, code: '001234' }), { code: 'NETWORK_UNCERTAIN' });
      assert.equal((await readState('session')).token, 'old-token');
      assert.equal((await readState('login')).status, 'validation_required');
      allowRead = true;
      assert.equal((await authStep({ loginId: start.loginId })).status, 'authenticated');
      assert.equal(posts, 2);
    });
    await t.test('uncertain POSTs are not replayed by repeated login or status', async () => {
      await reset(); let posts = 0;
      globalThis.fetch = async () => { posts++; throw Error('lost response'); };
      await assert.rejects(login({ email: 'person@example.invalid' }), { code: 'NETWORK_UNCERTAIN' });
      assert.equal((await login({ email: 'person@example.invalid' })).status, 'request_pending');
      assert.equal((await authStatus()).pending.status, 'request_pending');
      assert.equal(posts, 1);
    });
    await t.test('durable acknowledged response can be processed repeatedly without network traffic', async () => {
      await reset(); let requests = 0;
      globalThis.fetch = async () => { requests++; throw Error('unexpected'); };
      const flow = { ...createAuthFlow({ email: 'person@example.invalid' }), loginId: 'recorded-login' };
      const { nextFlow } = buildAuthRequest(flow, { action: 'identify' });
      await saveState('login', { ...nextFlow, loginId: flow.loginId });
      await saveState('auth-response', { loginId: flow.loginId, response: { status: 200, headers: {}, body: challenge } });
      assert.equal((await authStatus()).pending.status, 'code_required');
      assert.equal((await authStatus()).pending.status, 'code_required');
      assert.equal(requests, 0);
      assert.equal(await readState('auth-response'), null);
    });
    await t.test('wrong account and accidental signup never overwrite the saved session', async () => {
      for (const signup of [false, true]) {
        await reset(); let posts = 0;
        await saveState('session', { token: 'old-token' });
        globalThis.fetch = async url => {
          if (url.pathname === '/v3') return json(signup ? account : { data: { viewer: { user: { id: 'different-user' } } } });
          return json(++posts === 1 ? challenge : { ...completed, authentication: { ...completed.authentication, isNewAccount: signup } });
        };
        const start = await login({ email: 'person@example.invalid', replace: true });
        await assert.rejects(authStep({ loginId: start.loginId, code: '001234' }), { code: signup ? 'UNEXPECTED_NEW_ACCOUNT' : 'AUTH_VALIDATION_FAILED' });
        assert.equal((await readState('session')).token, 'old-token');
      }
    });
    await t.test('an expired candidate cannot issue an account read or replace a saved session', async () => {
      await reset(); let calls = 0;
      const old = Date.now() - 20 * 60_000;
      const flow = { ...createAuthFlow({ email: 'person@example.invalid', now: old }), loginId: 'expired', status: 'validation_required',
        userId: '123', candidateTokens: { token: 'candidate-token', aaj: { aaj: 'candidate-aaj' } } };
      await saveState('session', { token: 'old-token' }); await saveState('login', flow);
      globalThis.fetch = async () => { calls++; return json(account); };
      await assert.rejects(authStep({ loginId: 'expired' }), { code: 'AUTH_FLOW_EXPIRED' });
      assert.equal(calls, 0);
      assert.equal((await readState('session')).token, 'old-token');
    });
  } finally { globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); }
});
