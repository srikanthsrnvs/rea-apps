import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOTPReceipt } from '../src/otp-lifecycle.mjs';

const csrf = token => ({ __typename: 'IdentityCsrfWidgetAction', type: 'CSRF', token, inputKeys: ['token'] });
const trust = { __typename: 'IdentityTrustWidgetAction', type: 'TRUST_WIDGET', inputKeys: ['payload'] };
function pending() {
  return { id: 'local-login', protocol: 'native_otp', phase: 'submission_pending', flowContext: { email: 'traveler@example.test', flowScenario: 'SIGNIN' },
    parsed: { status: 'user_action_required', userActionRequired: true,
      fields: [{ id: 'oneTimePasscode', kind: 'code', codeLength: 6 }],
      actions: [
        { id: 'continueButton', primary: true, nativeAction: { __typename: 'IdentityVerifyEmailOTPAction', verifyEmailOTPContext: 'original-verify-context', accountTakeOverWidgets: [csrf('original-verify-csrf'), trust] }, atoActions: [csrf('original-verify-csrf'), trust] },
        { id: 'resendCodeButton', nativeAction: { __typename: 'IdentityResendEmailOTPAction', resendEmailOTPContext: 'original-resend-context', accountTakeOverWidgets: [csrf('original-resend-csrf')] } },
        { id: 'sendCodeToEmailButton', nativeAction: { __typename: 'IdentitySendEmailOTPAction', accountTakeOverWidgets: [csrf('send-csrf')] } },
      ],
      challenges: [{ kind: 'verification_code', fieldId: 'oneTimePasscode' }, { kind: 'csrf', type: 'IdentityCsrfWidgetAction' }, { kind: 'user_action_required', type: 'IdentityTrustWidgetAction' }], errors: [],
    },
  };
}
const response = (type, fields = {}) => ({ data: { result: { __typename: type, ...fields } } });

test('resend receipt retains the OTP form and original verify ATOs while rotating only resend CSRF and reference', () => {
  const original = pending(), before = structuredClone(original);
  const updated = applyOTPReceipt(original, response('IdentityResendOTPAuthenticationSuccessResponse', { referenceId: 'real-server-reference', resendOTPContext: null, accountTakeOverWidgets: [csrf('new-resend-csrf')] }));
  assert.deepEqual(original, before);
  assert.deepEqual(updated.parsed.fields, before.parsed.fields);
  assert.deepEqual(updated.parsed.actions[0], before.parsed.actions[0]);
  assert.deepEqual(updated.parsed.challenges, before.parsed.challenges);
  assert.equal(updated.parsed.actions[1].nativeAction.accountTakeOverWidgets[0].token, 'new-resend-csrf');
  assert.equal(updated.flowContext.referenceId, 'real-server-reference');
  assert.equal(Object.hasOwn(updated, 'otpContext'), false);
  assert.deepEqual(updated.lastOTPReceipt, { kind: 'resend', status: 'code_sent' });
  assert.equal(updated.phase, 'submission_pending'); // The executor owns durable request phase.
});

test('nonnull resend context overrides verify context; null keeps it and empty restores original query context', () => {
  const first = applyOTPReceipt(pending(), response('IdentityResendOTPAuthenticationSuccessResponse', { referenceId: 'ref-1', resendOTPContext: 'server-context' }));
  assert.equal(first.parsed.actions[0].nativeAction.verifyEmailOTPContext, 'server-context');
  assert.equal(first.parsed.actions[1].nativeAction.resendEmailOTPContext, 'server-context');
  assert.equal(first.queryOTPContext, 'original-verify-context');
  const next = applyOTPReceipt(first, response('IdentityResendOTPAuthenticationSuccessResponse', { referenceId: 'ref-2', resendOTPContext: null }));
  assert.equal(next.otpContext, 'server-context');
  assert.equal(next.parsed.actions[0].nativeAction.verifyEmailOTPContext, 'server-context');
  const reset = applyOTPReceipt(next, response('IdentityResendOTPAuthenticationSuccessResponse', { referenceId: null, resendOTPContext: '' }));
  assert.equal(reset.flowContext.referenceId, null);
  assert.equal(reset.otpContext, '');
  assert.equal(reset.parsed.actions[0].nativeAction.verifyEmailOTPContext, 'original-verify-context');
  assert.equal(reset.parsed.actions[1].nativeAction.resendEmailOTPContext, 'original-resend-context');
});

test('generic verification failure preserves actionable form and challenge requirements', () => {
  const original = pending();
  const failed = applyOTPReceipt(original, response('IdentityVerifyOTPAuthenticationFailureResponse', { banner: { summary: { message: 'Please check the verification code.' } } }));
  assert.deepEqual(failed.parsed.actions, original.parsed.actions);
  assert.deepEqual(failed.parsed.fields, original.parsed.fields);
  assert.deepEqual(failed.parsed.challenges, original.parsed.challenges);
  assert.equal(failed.parsed.status, 'error');
  assert.match(failed.parsed.errors[0].message, /check the verification code/);
  assert.equal(Object.hasOwn(failed.flowContext, 'referenceId'), false);
  const graphql = applyOTPReceipt(original, { errors: [{ message: 'Request could not be completed' }] });
  assert.equal(graphql.parsed.errors[0].message, 'Request could not be completed');
  assert.deepEqual(graphql.parsed.actions, original.parsed.actions);
});

test('only a verification failure replaces verify ATOs; resend failure updates resend requirements', () => {
  const original = pending();
  const failed = applyOTPReceipt(original, response('IdentityVerifyOTPAuthenticationFailureResponse', { accountTakeOverWidgets: [csrf('fresh-verify-csrf')] }));
  assert.deepEqual(failed.parsed.actions[0].nativeAction.accountTakeOverWidgets, [csrf('fresh-verify-csrf')]);
  assert.equal(failed.parsed.userActionRequired, false);
  assert.deepEqual(failed.parsed.challenges.map(value => value.kind), ['verification_code', 'csrf']);
  const resend = applyOTPReceipt(original, response('IdentityResendOTPAuthenticationFailureResponse', { accountTakeOverWidgets: [csrf('resend-retry-csrf')] }));
  assert.deepEqual(resend.parsed.actions[0], original.parsed.actions[0]);
  assert.equal(resend.parsed.actions[1].nativeAction.accountTakeOverWidgets[0].token, 'resend-retry-csrf');
});

test('explicit alternate-email send uses returned back-button verification widgets and actual reference only', () => {
  const updated = applyOTPReceipt(pending(), response('IdentitySendOTPAuthenticationSuccessResponse', { referenceId: 'issued-reference', sendOTPContext: 'issued-send-context', backButtonATOWidgets: [csrf('next-verify-csrf')] }));
  assert.equal(updated.flowContext.referenceId, 'issued-reference');
  assert.equal(updated.sendOTPContext, 'issued-send-context');
  assert.deepEqual(updated.parsed.actions[0].nativeAction.accountTakeOverWidgets, [csrf('next-verify-csrf')]);
  assert.equal(updated.parsed.status, 'input_required');
  assert.equal(Object.hasOwn(updated, 'emailMarketingConsent'), false);
});

test('new forms and authenticated outcomes remain the normal auth parser’s responsibility', () => {
  for (const type of ['IdentityAuthenticateByOTPFormResponse', 'IdentityVerifyOTPAuthenticationSuccessResponse', 'IdentitySuccessResponse']) {
    assert.equal(applyOTPReceipt(pending(), response(type)), null);
  }
  assert.equal(applyOTPReceipt({ ...pending(), protocol: 'layout' }, response('IdentityResendOTPAuthenticationSuccessResponse')), null);
});
