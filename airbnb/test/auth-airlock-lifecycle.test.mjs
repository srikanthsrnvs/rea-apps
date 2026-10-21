import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airbnb-airlock-login-'));
process.env.AIRBNB_STATE_DIR = directory;
const { login, authStep, authStatus, requestPhoneCode, resumeAuthVerification } = await import('../src/auth.mjs');
const { readState, saveState } = await import('../src/state.mjs');
const originalFetch = globalThis.fetch;
const json = (body, status = 200) => Response.json(body, { status });
const airlock = { id: 'QWlybG9jazotMTIz', internalAirlockId: '-123', airlockWebviewUrl: 'https://www.airbnb.com/airlock?al_id=-123&locale=en', flow: 'CAPTCHA_FLOW', airlockStatus: 'INCOMPLETE',
  viewPayload: { frictionView: 'ARKOSE_BOT_DETECTION', frictionData: { publicKey: '2F0D6CB5-ACAC-4EA9-9B2A-A5F90A2DF15E', encodedDataPayload: 'opaque-private-blob' } } };
const blocked = () => json({ client_error_info: { airlockV2: airlock } }, 420);
const ready = () => json({ nextStepConfig: { smsOtp: { phoneNumber: '+15555550123', fallbackChallenges: [] } } });
const satisfied = { airlock: { id: -123, status: 2, should_replay_request: true } };
async function reset() {
  for (const file of await fs.readdir(directory)) await fs.rm(path.join(directory, file), { recursive: true, force: true });
  await saveState('request-context', { everestDeviceId: 'native-device', everestExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
}
test('durable Airlock login integration', async t => {
  try {
    await t.test('official-page completion resumes the identical auth request once', async () => {
      await reset(); let posts = 0, first;
      globalThis.fetch = async (url, options) => {
        if (url.pathname === '/v2/airlocks/-123') return json(satisfied);
        posts++;
        if (posts === 1) { first = options; return blocked(); }
        assert.equal(options.body, first.body);
        const { 'x-airbnb-replay-airlock-id': id, ...headers } = options.headers;
        assert.equal(id, '-123'); assert.deepEqual(headers, first.headers);
        return ready();
      };
      const start = await login({ phone: '+15555550123', countryCode: 'US' });
      assert.equal(start.status, 'action_required');
      assert.deepEqual(start.requiredSteps, ['airlock']);
      assert.ok(!JSON.stringify(start).includes('opaque-private-blob'));
      const end = await resumeAuthVerification({ loginId: start.loginId });
      assert.equal(end.status, 'code_required'); assert.equal(posts, 2);
      assert.equal((await readState('login')).airlockCheckpoint, undefined);
    });
    await t.test('a second challenge stops without creating a replay cycle', async () => {
      await reset(); let posts = 0;
      globalThis.fetch = async url => {
        if (url.pathname === '/v2/airlocks/-123') return json(satisfied);
        posts++; return blocked();
      };
      const start = await login({ phone: '+15555550123', countryCode: 'US' });
      const end = await resumeAuthVerification({ loginId: start.loginId });
      assert.equal(end.error, 'AUTH_VERIFICATION_REPEATED');
      await assert.rejects(resumeAuthVerification({ loginId: start.loginId }), { code: 'AUTH_REQUEST_PENDING' });
      assert.equal(posts, 2);
    });
    await t.test('an uncertain retry cannot be submitted by another resume or status call', async () => {
      await reset(); let posts = 0;
      globalThis.fetch = async url => {
        if (url.pathname === '/v2/airlocks/-123') return json(satisfied);
        if (++posts === 1) return blocked();
        throw Error('lost response');
      };
      const start = await login({ phone: '+15555550123', countryCode: 'US' });
      await assert.rejects(resumeAuthVerification({ loginId: start.loginId }), { code: 'NETWORK_UNCERTAIN' });
      await assert.rejects(resumeAuthVerification({ loginId: start.loginId }), { code: 'AUTH_REQUEST_PENDING' });
      assert.equal((await authStatus()).pending.status, 'request_pending');
      assert.equal(posts, 2);
    });
    await t.test('genuine browser token is submitted once before checking and resuming', async () => {
      await reset(); let posts = 0, mutations = 0;
      const token = 'genuine-full-token|including|suffix';
      globalThis.fetch = async (url, options) => {
        if (url.pathname === '/v2/airlocks/-123') return json(satisfied);
        if (url.pathname === '/v3') {
          mutations++;
          assert.deepEqual(JSON.parse(options.body).variables, { payload: { airlockId: airlock.id, sessionToken: token } });
          return json({ data: { airlockArkoseBotDetectionSubmitToken: { airlock: { ...airlock, airlockStatus: 'SATISFIED' }, errors: [] } } });
        }
        return ++posts === 1 ? blocked() : ready();
      };
      const start = await login({ phone: '+15555550123', countryCode: 'US' });
      const flow = await readState('login'), id = randomUUID();
      const child = path.join(directory, `verification-${flow.loginId}`);
      await fs.mkdir(child, { mode: 0o700 });
      await fs.writeFile(path.join(child, 'verification-result.json'), JSON.stringify({ id, status: 'completed', eventId: 'challenge-complete', publicKey: airlock.viewPayload.frictionData.publicKey, token }), { mode: 0o600 });
      flow.browserVerification = { id, directory: child, expiresAt: Date.now() + 60_000 };
      await saveState('login', flow);
      assert.equal((await resumeAuthVerification({ loginId: start.loginId })).status, 'code_required');
      assert.equal(mutations, 1); assert.equal(posts, 2);
      await assert.rejects(fs.stat(child), { code: 'ENOENT' });
    });
    await t.test('phone gateway preserves the native login attempt through verification, code and independent account validation', async () => {
      await reset(); let gatewayCalls = 0, verifies = 0, attempt;
      globalThis.fetch = async (url, options) => {
        if (url.pathname === '/v2/airlocks/-123') return json(satisfied);
        if (url.pathname === '/v2/phone_one_time_passwords') {
          assert.equal(JSON.parse(options.body).workFlow, 'GLOBAL_SIGNUP_LOGIN');
          return ++gatewayCalls === 1 ? blocked() : json({ success: true, deliveryMethod: 'TEXT', codeLength: 6, internationalPhoneNumber: '' });
        }
        if (url.pathname === '/v2/auth/identify/phone') { attempt = options.headers['X-Airbnb-Auth-Attempt']; return ready(); }
        if (url.pathname === '/v2/auth/authenticate/sms_otp') {
          verifies++;
          assert.equal(options.headers['X-Airbnb-Auth-Attempt'], attempt);
          assert.equal(options.headers['X-Airbnb-Flex-Auth-Options'], 'null');
          assert.equal(JSON.parse(options.body).steps[1].smsOtpChallenge.otp, '001234');
          return json({ nextStepConfig: { closeModal: {} }, authentication: { userId_str: '123', isNewAccount: false, nativeTokens: { token: 'candidate', aaj: { aaj: 'aaj', maxAgeSecs: null } } } });
        }
        assert.equal(url.pathname, '/v3');
        assert.equal(options.headers['x-airbnb-oauth-token'], 'candidate');
        return json({ data: { viewer: { user: { id: Buffer.from('User:123').toString('base64'), firstName: 'Example' } } } });
      };
      const start = await login({ phone: '+15555550123', countryCode: 'US' });
      const waiting = await readState('login'); waiting.resendAvailableAt = 0; await saveState('login', waiting);
      assert.equal((await requestPhoneCode({ loginId: start.loginId })).status, 'action_required');
      const dispatched = await resumeAuthVerification({ loginId: start.loginId });
      assert.equal(dispatched.codeDispatch.accepted, true);
      assert.equal(dispatched.codeDispatch.deliveryMethod, 'TEXT');
      assert.equal((await authStep({ loginId: start.loginId, code: '001234' })).authenticated, true);
      assert.equal(gatewayCalls, 2); assert.equal(verifies, 1);
    });
  } finally { globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); }
});
