import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'expedia-auth-lifecycle-'));
process.env.EXPEDIA_CLI_STATE_DIR = directory;
const { saveState, readState, removeState } = await import('../src/state.mjs');
const { completeLogin, cancelLogin, authStatus } = await import('../src/auth.mjs');
const { createContext } = await import('../src/context.mjs');
const { parseOTPFormResponse } = await import('../src/auth-protocol.mjs');
const originalFetch = globalThis.fetch;
test.after(async () => { globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); });

async function pending() {
  const record = { id: randomUUID(), phase: 'ready', protocol: 'native_otp', context: createContext(), cookies: [],
    expiresAt: new Date(Date.now() + 60000).toISOString(), flowContext: { email: 'test@example.test', flowScenario: 'SIGNIN', referenceId: 'receipt-reference' },
    parsed: parseOTPFormResponse({ data: { identityAuthenticateByOTPForm: {
      __typename: 'IdentityAuthenticateByOTPFormResponse',
      oneTimePasscodeField: { input: { __typename: 'EGDSNumberInputField', required: true }, validations: [{ __typename: 'IdentityRegexValidationRule', regex: '^[0-9]{6}$' }] },
      continueButton: { action: { __typename: 'IdentityVerifyEmailOTPAction', authenticationFlowVariant: 'SERVER_VARIANT', accountTakeOverWidgets: [{ __typename: 'IdentityCsrfWidgetAction', type: 'CSRF', token: 'form-token', inputKeys: ['token'] }] } },
    } } }),
  };
  await saveState('pending-login', record);
  return record;
}
const success = (field, email = 'test@example.test') => ({ data: { [field]: {
  __typename: field === 'identityRefresh' ? 'IdentityRefreshSuccessResponse' : 'IdentityVerifyOTPAuthenticationSuccessResponse',
  profile: { emailAddress: email, firstName: 'Test', expUserId: '123', tuid: '456' },
} } });
function response(payload, session = false) { return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json', ...(session ? { 'set-cookie': 'EG_SESSIONTOKEN=new-test-session; Path=/; Secure; HttpOnly' } : {}) } }); }

test('OTP success is independently validated before replacing the saved account', async () => {
  const record = await pending();
  await saveState('session', { marker: 'old-account' });
  const calls = [];
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body); calls.push(body);
    assert.deepEqual(await readState('session'), { marker: 'old-account' });
    return calls.length === 1 ? response(success('identityVerifyOTPAuthenticationSubmit'), true) : response(success('identityRefresh'));
  };
  const result = await completeLogin({ loginId: record.id, code: '001234' });
  assert.equal(result.status, 'authenticated');
  assert.deepEqual(calls.map(call => call.operationName), ['identityVerifyOTPAuthenticationSubmit', 'identityRefresh']);
  assert.equal(calls[0].variables.request.referenceId, 'receipt-reference');
  assert.equal(Object.hasOwn(calls[0].variables.request, 'authenticationFlowVariant'), false);
  assert.equal((await readState('session')).profile.emailAddress, 'test@example.test');
  assert.equal(await readState('pending-login'), null);
});

test('account mismatch at independent validation preserves the old account', async () => {
  const record = await pending();
  await saveState('session', { marker: 'old-account' });
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? response(success('identityVerifyOTPAuthenticationSubmit'), true) : response(success('identityRefresh', 'other@example.test'));
  await assert.rejects(completeLogin({ loginId: record.id, code: '001234' }), { code: 'SESSION_NOT_VALIDATED' });
  assert.deepEqual(await readState('session'), { marker: 'old-account' });
  assert.equal((await readState('pending-login')).phase, 'validation_failed');
});

test('unknown submission is journaled before network and never replayed', async () => {
  const record = await pending();
  let calls = 0;
  globalThis.fetch = async () => { calls++; assert.equal((await readState('pending-login')).phase, 'submission_pending'); throw Error('Connection lost'); };
  await assert.rejects(completeLogin({ loginId: record.id, code: '001234' }), { code: 'NETWORK_ERROR' });
  await assert.rejects(completeLogin({ loginId: record.id, code: '001234' }), { code: 'LOGIN_OUTCOME_UNKNOWN' });
  assert.equal(calls, 1);
});

test('wrong code length makes no network request and leaves the login ready', async () => {
  const record = await pending();
  globalThis.fetch = () => { throw Error('Must not request'); };
  await assert.rejects(completeLogin({ loginId: record.id, code: '1234' }), { code: 'INVALID_VERIFICATION_CODE' });
  assert.equal((await readState('pending-login')).phase, 'ready');
  await assert.rejects(completeLogin({ loginId: record.id, values: {} }), { code: 'AUTH_INPUT_REQUIRED' });
  const status = await authStatus();
  assert.equal(status.pending.loginId, record.id);
  assert.equal(status.pending.fields[0].codeLength, 6);
});

test('cancelling login preserves the independently saved account', async () => {
  const record = await pending();
  await saveState('session', { marker: 'saved-account' });
  await cancelLogin({ loginId: record.id });
  assert.equal(await readState('pending-login'), null);
  assert.deepEqual(await readState('session'), { marker: 'saved-account' });
  await removeState('session');
});
