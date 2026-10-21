import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-amex-auth-test-'));
const directory = path.join(temporary, 'state');
const credentialsFile = path.join(temporary, 'input.json');
const originalStateDirectory = process.env.AMEX_STATE_DIR;
const originalFetch = globalThis.fetch;
process.env.AMEX_STATE_DIR = directory;
const auth = await import('../src/auth.mjs');
const state = await import('../src/state.mjs');
const input = { userId: 'example-user', password: 'synthetic-password-never-store' };
await fs.writeFile(credentialsFile, JSON.stringify(input), { mode: 0o600 });

let handler;
let calls;
beforeEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  calls = [];
  handler = async () => { throw new Error('Unexpected offline request'); };
  globalThis.fetch = async (url, options) => {
    const call = { url: new URL(url), method: options.method,
      headers: options.headers, body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    return handler(call);
  };
});
after(async () => {
  globalThis.fetch = originalFetch;
  if (originalStateDirectory === undefined) delete process.env.AMEX_STATE_DIR;
  else process.env.AMEX_STATE_DIR = originalStateDirectory;
  await fs.rm(temporary, { recursive: true, force: true });
});

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
const nativeLogin = () => ({
  status: { success: true },
  logonData: { status: 0, jsonWebToken: { rawToken: 'synthetic-login-jwt' }, publicGuid: 'synthetic-owner-guid' },
  summary: { status: 0, cardList: [] },
  additionalHeaders: [{ header: 'x-axp-stage-context', value: 'synthetic-stage-context' }],
});
const accountSummary = () => ({ status: { success: true }, summaryData: { cardList: [{
  cardId: 'synthetic-card', accountToken: 'synthetic-account-token', sortedIndex: 0,
  cardProductName: 'Example Card', cardEndingDisplay: '••12345',
}] } });
const offeredOtp = { category: 'OTP_SMS', categoryType: 'OTP', encryptedValue: 'synthetic-encrypted-number',
  title: 'Text message', subtitle: '••• 1234' };
const mfaOptions = () => ({ status: { success: true }, data: {
  status: 'CHALLENGE_REQUIRED', jsonWebToken: { rawToken: 'synthetic-options-jwt' },
  challengeOptions: [offeredOtp, { category: 'GOVERNMENT_ID', categoryType: 'GOVERNMENT_ID' }],
} });
const delivery = () => ({ status: { success: true }, data: {
  jsonWebToken: { rawToken: 'synthetic-delivery-jwt' }, successLabels: { title: 'Enter the code' },
} });

async function savedSession() {
  const saved = { version: 1, validated: true, validatedAt: new Date().toISOString(), ownerId: 'synthetic-old-owner',
    jsonWebToken: { rawToken: 'synthetic-old-jwt' }, publicGuid: 'synthetic-old-guid' };
  await state.saveState('session', saved);
  return saved;
}
async function stateText() {
  const entries = await fs.readdir(directory);
  return (await Promise.all(entries.filter(entry => entry.endsWith('.json'))
    .map(entry => fs.readFile(path.join(directory, entry), 'utf8')))).join('\n');
}
function isLogin(call) { return call.url.pathname.endsWith('/loginsummarytimeline'); }
function installMfaHandler({ verification } = {}) {
  handler = async call => {
    if (isLogin(call)) {
      const response = nativeLogin(); response.logonData.status = 4;
      response.logonData.cupcake = 'synthetic-bluebox';
      return json(response);
    }
    if (call.url.pathname.endsWith('/challengeOptions')) return json(mfaOptions());
    if (call.url.pathname.endsWith('/otpDeliver')) return json(delivery());
    if (call.url.pathname.endsWith('/challengeVerification')) return verification(call);
    if (call.url.pathname.endsWith('/summary')) return json(accountSummary());
    throw new Error('Unexpected offline request');
  };
}

test('candidate credentials replace a saved account only after an independent authenticated summary', async () => {
  const old = await savedSession();
  handler = async call => {
    if (isLogin(call)) return json(nativeLogin());
    assert.equal(call.url.pathname.endsWith('/summary'), true);
    assert.deepEqual(await state.readState('session'), old);
    assert.equal(call.headers.authorization, 'AMAT synthetic-login-jwt');
    assert.equal(call.headers['x-axp-stage-context'], 'synthetic-stage-context');
    return json(accountSummary());
  };
  const result = await auth.startLogin({ replace: true, credentialsFile });
  assert.equal(result.phase, 'authenticated');
  assert.deepEqual(result.cards, [{ productName: 'Example Card', ending: '••12345' }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.login.loginCredentials.userIdLogin.password, input.password);
  const saved = await state.readState('session');
  assert.equal(saved.validated, true);
  assert.equal(saved.jsonWebToken.rawToken, 'synthetic-login-jwt');
  assert.equal(saved.gateKeeperCookie, undefined);
  assert.equal(await state.readState('login'), null);
  assert.equal(await state.readState('auth-response'), null);
  assert.equal((await stateText()).includes(input.password), false);
});

test('unknown login results and explicit login step-up directives never reach account validation', async () => {
  const old = await savedSession();
  for (const response of [{ status: { success: true }, data: {} }, ...['secondaryAuthentication', 'secondaryAuthenticationV3', 'secondaryAuthenticationV4']
    .map(key => { const body = nativeLogin(); body.status[key] = { type: 'SYNTHETIC_CHALLENGE' }; return body; })]) {
    handler = async call => { assert.equal(isLogin(call), true); return json(response); };
    const before = calls.length;
    const result = await auth.startLogin({ replace: true, credentialsFile });
    assert.equal(result.phase, 'action_required');
    assert.equal(calls.length - before, 1);
    assert.deepEqual(await state.readState('session'), old);
    if (response.logonData) {
      const pending = await state.readState('login');
      assert.equal(pending.context.jsonWebToken.rawToken, 'synthetic-login-jwt');
      assert.equal(pending.context.additionalHeaders[0].value, 'synthetic-stage-context');
    }
  }
});

test('an account-validation step-up preserves the prior saved session', async () => {
  const old = await savedSession();
  handler = async call => {
    if (isLogin(call)) return json(nativeLogin());
    const body = accountSummary(); body.status.secondaryAuthenticationV4 = { type: 'SYNTHETIC_CHALLENGE' };
    return json(body);
  };
  const result = await auth.startLogin({ replace: true, credentialsFile });
  assert.equal(result.phase, 'action_required');
  assert.equal(result.reason, 'account_validation_incomplete');
  assert.deepEqual(await state.readState('session'), old);
  assert.equal(calls.length, 2);
});

test('MFA follows offered channels and genuine successive JWTs without trusting the device', async () => {
  const code = '001234';
  installMfaHandler({ verification: async call => {
    assert.equal(call.headers.authorization, 'AMAT synthetic-delivery-jwt');
    assert.equal(call.body.challengeAnswer, code);
    return json({ status: { success: true }, data: { status: 'SUCCESS',
      jsonWebToken: { rawToken: 'synthetic-verified-jwt' }, oneTimePasscode: code } });
  } });
  const started = await auth.startLogin({ credentialsFile });
  assert.equal(started.phase, 'otp_options');
  assert.equal(started.authenticated, false);
  assert.equal(calls[1].headers.authorization, 'AMAT synthetic-login-jwt');
  assert.equal(calls[1].headers['x-axp-blueboxvalues'], 'synthetic-bluebox');
  assert.equal(calls[1].headers['x-axp-stage-context'], 'synthetic-stage-context');
  assert.equal(JSON.stringify(started).includes('synthetic-options-jwt'), false);
  assert.equal(JSON.stringify(started).includes(offeredOtp.encryptedValue), false);
  await assert.rejects(auth.sendCode({ loginId: started.loginId, optionId: 'option-2' }), { code: 'INVALID_MFA_OPTION' });
  assert.equal(calls.length, 2);
  const sent = await auth.sendCode({ loginId: started.loginId, optionId: 'option-1' });
  assert.equal(sent.phase, 'code_required');
  assert.equal(calls[2].headers.authorization, 'AMAT synthetic-options-jwt');
  assert.equal(calls[2].body.deliveryMethod, 'SMS');
  assert.equal(calls[2].body.encryptedValue, offeredOtp.encryptedValue);
  await assert.rejects(auth.sendCode({ loginId: started.loginId, optionId: 'option-1' }), { code: 'AUTH_RESEND_COOLDOWN' });
  const result = await auth.verifyCode({ loginId: started.loginId, code });
  assert.equal(result.authenticated, true);
  assert.equal(calls.at(-1).headers.authorization, 'AMAT synthetic-verified-jwt');
  assert.equal((await state.readState('session')).jsonWebToken.rawToken, 'synthetic-verified-jwt');
  const persisted = await stateText();
  assert.equal(persisted.includes(input.password), false);
  assert.equal(persisted.includes(code), false);
  assert.equal(calls.some(call => /agentEnrollment|rememberDevice|optIn/iu.test(call.url.pathname)), false);
});

test('a lost login response remains uncertain and cannot trigger a repeated credential POST', async () => {
  await assert.rejects(auth.startLogin({ credentialsFile }), { code: 'NETWORK_UNCERTAIN' });
  const flow = await state.readState('login');
  assert.equal(flow.phase, 'request_pending');
  assert.ok(flow.pending.requestId);
  assert.equal((await auth.authStatus()).pending.phase, 'request_pending');
  assert.equal((await auth.startLogin()).phase, 'request_pending');
  assert.equal(calls.length, 1);
  assert.equal((await stateText()).includes(input.password), false);
});

test('a lost verification response never allows another verification submission', async () => {
  installMfaHandler({ verification: async () => { throw new Error('Simulated response loss'); } });
  const started = await auth.startLogin({ credentialsFile });
  await auth.sendCode({ loginId: started.loginId, optionId: 'option-1' });
  await assert.rejects(auth.verifyCode({ loginId: started.loginId, code: '001234' }), { code: 'NETWORK_UNCERTAIN' });
  assert.equal((await auth.authStatus()).pending.phase, 'request_pending');
  await assert.rejects(auth.verifyCode({ loginId: started.loginId, code: '001234' }), { code: 'AUTH_STEP_UNAVAILABLE' });
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/challengeVerification')).length, 1);
  assert.equal((await stateText()).includes('001234'), false);
});

test('a pending additional challenge or unknown verification result cannot save a session or fetch account data', async () => {
  const old = await savedSession();
  for (const data of [
    { status: 'PENDING', jsonWebToken: { rawToken: 'synthetic-next-stage-jwt' }, nextChallenge: 'GOVERNMENT_ID' },
    { status: 'UNRECOGNIZED', jsonWebToken: { rawToken: 'synthetic-unknown-stage-jwt' } },
  ]) {
    installMfaHandler({ verification: async () => json({ status: { success: true }, data }) });
    const started = await auth.startLogin({ replace: true, credentialsFile });
    await auth.sendCode({ loginId: started.loginId, optionId: 'option-1' });
    const count = calls.length;
    const result = await auth.verifyCode({ loginId: started.loginId, code: '001234' });
    assert.equal(result.phase, 'action_required');
    assert.equal(result.authenticated, false);
    assert.equal(calls.length - count, 1);
    assert.deepEqual(await state.readState('session'), old);
    await assert.rejects(auth.verifyCode({ loginId: started.loginId, code: '001234' }), { code: 'AUTH_STEP_UNAVAILABLE' });
  }
  assert.equal(calls.some(call => call.url.pathname.endsWith('/summary')), false);
});

test('stale response journals cannot complete a later uncertain request, including the same action', async () => {
  for (const staleAction of ['options', 'delivery']) {
    const flow = { version: 1, id: 'synthetic-login', expiresAt: Date.now() + 60_000,
      phase: 'request_pending', attempts: 0, deliveries: 1,
      context: { jsonWebToken: { rawToken: 'synthetic-context-jwt' } },
      pending: { requestId: 'synthetic-current-request', action: 'delivery', startedAt: Date.now() } };
    await state.saveState('login', flow);
    await state.saveState('auth-response', { loginId: flow.id,
      requestId: staleAction === 'options' ? flow.pending.requestId : 'synthetic-previous-request',
      action: staleAction, response: { status: 200, headers: {}, body: staleAction === 'options' ? mfaOptions() : delivery() } });
    assert.equal((await auth.authStatus()).pending.phase, 'request_pending');
    assert.equal((await auth.startLogin()).phase, 'request_pending');
    await assert.rejects(auth.sendCode({ loginId: flow.id, optionId: 'option-1' }), { code: 'AUTH_STEP_UNAVAILABLE' });
  }
  assert.equal(calls.length, 0);
});

test('a matching captured response is consumed once without resubmitting its request', async () => {
  const flow = { version: 1, id: 'synthetic-login', expiresAt: Date.now() + 60_000,
    phase: 'request_pending', attempts: 0, deliveries: 1,
    context: { jsonWebToken: { rawToken: 'synthetic-context-jwt' } },
    pending: { requestId: 'synthetic-current-request', action: 'delivery', startedAt: Date.now() } };
  await state.saveState('login', flow);
  await state.saveState('auth-response', { loginId: flow.id, requestId: flow.pending.requestId,
    action: 'delivery', response: { status: 200, headers: {}, body: delivery() } });
  assert.equal((await auth.authStatus()).pending.phase, 'code_required');
  assert.equal((await auth.authStatus()).pending.phase, 'code_required');
  assert.equal((await state.readState('login')).context.jsonWebToken.rawToken, 'synthetic-delivery-jwt');
  assert.equal(await state.readState('auth-response'), null);
  assert.equal(calls.length, 0);
});

test('interrupted independent account validation can be retried as a read without repeating login', async () => {
  const old = await savedSession(); let validationCalls = 0;
  handler = async call => {
    if (isLogin(call)) return json(nativeLogin());
    validationCalls += 1;
    if (validationCalls === 1) throw new Error('Simulated read failure');
    return json(accountSummary());
  };
  await assert.rejects(auth.startLogin({ replace: true, credentialsFile }), { code: 'NETWORK_UNCERTAIN' });
  const flow = await state.readState('login');
  assert.equal(flow.phase, 'validation_required');
  assert.deepEqual(await state.readState('session'), old);
  assert.equal((await auth.validateLogin({ loginId: flow.id })).authenticated, true);
  assert.equal(calls.filter(isLogin).length, 1);
  assert.equal(validationCalls, 2);
});

test('a captured response survives a consumption crash without recording input or unrelated credential headers', async () => {
  handler = async call => {
    assert.equal(isLogin(call), true);
    const response = nativeLogin(); response.password = input.password;
    return json(response, 200, {
      authorization: 'AMAT synthetic-header-token',
      'set-cookie': 'synthetic-cookie=do-not-journal',
      'x-axp-business-layer-status': 'PASS',
    });
  };
  const rename = fs.rename; let crashed = false;
  fs.rename = async (from, to) => {
    if (!crashed && to === path.join(directory, 'login.json') && await state.readState('auth-response')) {
      crashed = true;
      throw new Error('Simulated crash after capturing the response');
    }
    return rename(from, to);
  };
  try {
    await assert.rejects(auth.startLogin({ credentialsFile }), /Simulated crash/u);
  } finally { fs.rename = rename; }
  const flow = await state.readState('login');
  const journal = await state.readState('auth-response');
  assert.equal(flow.phase, 'request_pending');
  assert.equal(journal.requestId, flow.pending.requestId);
  assert.deepEqual(journal.response.headers, { 'x-axp-business-layer-status': 'PASS' });
  assert.equal(journal.response.body.password, undefined);
  const persisted = await stateText();
  for (const secret of [input.password, 'synthetic-header-token', 'do-not-journal']) {
    assert.equal(persisted.includes(secret), false);
  }
  assert.equal((await auth.authStatus()).pending.phase, 'validation_required');
  assert.equal(await state.readState('auth-response'), null);
  assert.equal(calls.length, 1);
});
