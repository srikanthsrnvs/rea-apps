import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildInitialAuthVariables, parseAuthResponse, buildAuthSubmitVariables, extractSessionCookies, buildAuthRefreshVariables, buildOTPFormVariables, parseOTPFormResponse, buildOTPActionOperation } from '../src/auth-protocol.mjs';

const context = { siteId: 1, locale: 'en_US', currency: 'USD', device: { type: 'MOBILE_PHONE' }, identity: { duaid: 'test-device' } };
const form = (field = {}, action = {}) => ({ data: { identityLayout: {
  __typename: 'IdentitySuccessResponse',
  identityComponentLayout: { __typename: 'IdentitySingleColumnComponentLayout', main: { blocks: [{ elements: [
    { __typename: 'EGDSEmailInputField', egdsElementId: 'server-email-id', stringLabel: 'Email', value: '', validations: [{ __typename: 'EGDSRequiredInputValidation' }], ...field },
    { __typename: 'IdentityButton', egdsElementId: 'server-continue-id', element: { __typename: 'UIPrimaryButton', primary: 'Continue' }, action: {
      __typename: 'IdentitySubmitAction', context: 'opaque-server-state', inputIds: ['server-email-id'], requestInputPairList: [{ key: 'routing-state', value: 'opaque-routing' }], atoActions: [], ...action,
    } },
  ] }] } },
} } });

test('initial variables use shipped native enums and never mutate the shared client context', () => {
  const variables = buildInitialAuthVariables(context);
  assert.deepEqual(variables.clientInfo, { appName: 'android.com.expedia.bookings', appVersion: '2026.41.0', channelType: 'ANDROID', deviceOS: 'ANDROID', deviceType: 'MOBILE_PHONE' });
  assert.equal(variables.layout, 'SIGNIN');
  variables.context.identity.duaid = 'other';
  assert.equal(context.identity.duaid, 'test-device');
  assert.throws(() => buildInitialAuthVariables(context, { layout: 'DEVICE_CODE' }), { code: 'UNSUPPORTED_AUTH_LAYOUT' });
  assert.throws(() => buildInitialAuthVariables(context, { deviceType: 'LINUX' }), { code: 'INVALID_AUTH_DEVICE' });
});

test('schema traversal retains opaque action state and server field IDs across submissions', () => {
  const parsed = parseAuthResponse(form());
  assert.equal(parsed.status, 'input_required');
  assert.equal(parsed.actions[0].id, 'server-continue-id');
  const submit = buildAuthSubmitVariables(context, parsed, { values: { 'server-email-id': 'test@example.com' } });
  assert.deepEqual(submit.submitRequest, { atoInputs: [], context: 'opaque-server-state', input: [{ key: 'routing-state', value: 'opaque-routing' }, { key: 'server-email-id', value: 'test@example.com' }] });
  assert.throws(() => buildAuthSubmitVariables(context, parsed, { values: { email: 'test@example.com' } }), { code: 'UNEXPECTED_AUTH_INPUT' });
  assert.throws(() => buildAuthSubmitVariables(context, parsed), { code: 'AUTH_INPUT_REQUIRED' });
});

test('OTP preserves leading zeros, reports exact supplied length, and masks destinations', () => {
  const parsed = parseAuthResponse(form({ __typename: 'EGDSNumberInputField', stringLabel: 'Verification code', instructions: 'Enter the text message code sent to +1 415 555 3917', max: 999999 }, {}));
  assert.equal(parsed.fields[0].kind, 'code');
  assert.deepEqual(parsed.challenges[0], { kind: 'verification_code', fieldId: 'server-email-id', length: 6, maskedTarget: '***3917', channel: 'sms' });
  assert.equal(buildAuthSubmitVariables(context, parsed, { values: { 'server-email-id': '010923' } }).submitRequest.input.at(-1).value, '010923');
  assert.throws(() => buildAuthSubmitVariables(context, parsed, { values: { 'server-email-id': '10923' } }), { code: 'INVALID_VERIFICATION_CODE' });
  const email = parseAuthResponse(form({ __typename: 'EGDSTextInputField', stringLabel: 'One-time code', instructions: 'Check your email at alice@example.com', validations: [{ __typename: 'EGDSMaxLengthInputValidation', maxLength: 4 }] }));
  assert.equal(email.challenges[0].maskedTarget, 'a***@example.com');
  assert.equal(email.challenges[0].length, 4);
});

test('unknown form and unhandled attestation request explicit user action', () => {
  assert.equal(parseAuthResponse({ data: { identityLayout: { __typename: 'NewUnknownLayout' } } }).userActionRequired, true);
  const parsed = parseAuthResponse(form({}, { atoActions: [{ __typename: 'IdentityCaptchaSafetyNetAndroidWidgetAction', type: 'CAPTCHA_SAFETYNET_ANDROID', siteKey: 'public', inputKeys: ['token'] }] }));
  assert.equal(parsed.status, 'user_action_required');
  assert.throws(() => buildAuthSubmitVariables(context, parsed, { values: { 'server-email-id': 'test@example.com' } }), { code: 'AUTH_CHALLENGE_REQUIRED' });
});

test('CSRF tokens are propagated into the returned input keys without mutating caller data', () => {
  const parsed = parseAuthResponse(form({}, { atoActions: [{ __typename: 'IdentityCsrfWidgetAction', type: 'CSRF', token: 'csrf-from-server', inputKeys: ['csrf-id'] }] }));
  const challengeInputs = [];
  const result = buildAuthSubmitVariables(context, parsed, { values: { 'server-email-id': 'test@example.com' }, challengeInputs });
  assert.deepEqual(result.submitRequest.atoInputs, [{ type: 'CSRF', inputs: [{ key: 'csrf-id', value: 'csrf-from-server' }] }]);
  assert.deepEqual(challengeInputs, []);
});

test('email Continue evaluates only its ATO requirements, independently of password autofill and social login', () => {
  // Sanitized shape from the live native SIGNIN layout; no account data or tokens.
  const response = form({}, { migrationContext: 'SHARED_UI_EMAIL_OTP', retrieveAtoLayout: 'GET_SEND_OTP_ATO', atoActions: [{ __typename: 'IdentityCsrfWidgetAction', type: 'CSRF', token: 'continue-csrf', inputKeys: ['token'] }] });
  const layout = response.data.identityLayout.identityComponentLayout;
  layout.identityOneTapSelection = {
    submitAction: {
      __typename: 'IdentitySubmitAction', context: 'single-tap-password-context',
      inputIds: ['hidden-password-email', 'hidden-password'],
      atoActions: [{ __typename: 'IdentityTrustWidgetAction', type: 'TRUST_WIDGET', inputKeys: ['payload'] }, { __typename: 'IdentityCaptchaArkoseMobileAppWidgetAction', type: 'CAPTCHA_ARKOSE_MOBILE_APP', publicKey: 'public-test-key', inputKeys: ['fc-token'] }],
    },
  };
  layout.main.blocks[0].elements.push({
    __typename: 'IdentitySocialButton', egdsElementId: 'google',
    action: { __typename: 'IdentitySocialSubmitAction', atoActions: [{ __typename: 'IdentityTrustWidgetAction', type: 'TRUST_WIDGET', inputKeys: ['payload'] }] },
  });
  const parsed = parseAuthResponse(response);
  assert.equal(parsed.status, 'input_required');
  assert.equal(parsed.selectedActionId, 'server-continue-id');
  assert.deepEqual(parsed.challenges.map(value => value.type), ['IdentityCsrfWidgetAction']);
  assert.equal(JSON.stringify(parsed.challenges).includes('continue-csrf'), false);
  const variables = buildAuthSubmitVariables(context, parsed, { values: { 'server-email-id': 'test@example.com' } });
  assert.deepEqual(variables.submitRequest.atoInputs, [{ type: 'CSRF', inputs: [{ key: 'token', value: 'continue-csrf' }] }]);
  assert.equal(variables.submitRequest.migrationContextInput, 'SHARED_UI_EMAIL_OTP');
  const hiddenAction = parsed.actions.find(action => !action.primary);
  const alternative = parseAuthResponse(response, { actionId: hiddenAction.id });
  assert.equal(alternative.status, 'user_action_required');
  assert.deepEqual(alternative.challenges.map(value => value.type), ['IdentityTrustWidgetAction', 'IdentityCaptchaArkoseMobileAppWidgetAction']);
});

test('session success requires identified profile and a live EG_SESSIONTOKEN, not merely a form success typename', () => {
  assert.equal(parseAuthResponse(form()).status, 'input_required');
  const payload = { data: { identityFormSubmit: { __typename: 'IdentitySuccessResponse', profile: { tuid: '123' }, identitySessionAction: { session: [{ name: 'EG_SESSIONTOKEN', value: 'test-session', domain: '.expedia.com', httpOnly: true, secure: true, path: '/' }] } } } };
  const parsed = parseAuthResponse(payload);
  assert.equal(parsed.status, 'authenticated');
  assert.equal(parsed.cookies[0].domain, 'expedia.com');
  payload.data.identityFormSubmit.identitySessionAction.session[0].maxAge = 0;
  assert.notEqual(parseAuthResponse(payload).status, 'authenticated');
});

test('new native verify and refresh recognize valid transport cookies and retain follow-up identifiers', () => {
  const payload = { data: { identityVerifyOTPAuthenticationSubmit: { __typename: 'IdentityVerifyOTPAuthenticationSuccessResponse', success: true, profile: { tuid: '123' }, authStepIdentifier: 'ORIGIN', redirectionContext: 'opaque-next-state' } } };
  assert.notEqual(parseAuthResponse(payload).status, 'authenticated');
  const parsed = parseAuthResponse(payload, { cookies: [{ name: 'EG_SESSIONTOKEN', value: 'session-from-http', domain: 'expedia.com' }] });
  assert.equal(parsed.status, 'authenticated');
  assert.equal(parsed.authStepIdentifier, 'ORIGIN');
  assert.equal(parsed.redirectionContext, 'opaque-next-state');
  assert.equal(parseAuthResponse({ data: { identityRefresh: { action: 'NONE', profile: { tuid: '123' } } } }, { cookies: parsed.cookies }).status, 'authenticated');
});

test('untrusted session domains and header injection are rejected and cookie deletion is retained', () => {
  assert.throws(() => extractSessionCookies({ session: [{ name: 'EG_SESSIONTOKEN', value: 'secret', domain: 'expedia.com.evil.test' }] }), { code: 'UNEXPECTED_AUTH_COOKIE_DOMAIN' });
  assert.throws(() => extractSessionCookies({ session: [{ name: 'EG_SESSIONTOKEN', value: 'x\r\nInjected: y', domain: 'expedia.com' }] }), { code: 'INVALID_AUTH_COOKIE' });
  assert.equal(extractSessionCookies({ session: [{ name: 'EG_SESSIONTOKEN', value: '', maxAge: 0, domain: 'expedia.com' }] })[0].maxAge, 0);
});

test('server errors remain errors and cannot cause a guessed next step', () => {
  const parsed = parseAuthResponse({ errors: [{ message: 'Verification code expired' }] });
  assert.equal(parsed.status, 'error');
  assert.equal(parsed.errors[0].message, 'Verification code expired');
});

test('email migration is a read-only form step, not another initial email submission', () => {
  const parsed = parseAuthResponse({ data: { identityFormSubmit: { __typename: 'IdentitySuccessResponse', flowContext: { email: 'test@example.com', flowIdentifier: 'EMAIL_OTP', flowScenario: 'SIGNIN' } } } });
  assert.equal(parsed.status, 'migration_required');
  assert.deepEqual(parsed.nextStep, { kind: 'query', operationName: 'identityAuthenticateByOTPForm' });
  assert.deepEqual(buildOTPFormVariables(context, parsed).request, { emailInput: 'test@example.com', verifyOTPFormContext: null });
  assert.equal(parseAuthResponse([{ errors: [{ message: 'Nested native error' }] }]).status, 'error');
});

test('native OTP form parses the regex length and retains mandatory provider requirements', () => {
  const payload = { data: { identityAuthenticateByOTPForm: {
    __typename: 'IdentityAuthenticateByOTPFormResponse', heading: 'Confirm email', description: 'Code sent to test@example.com',
    oneTimePasscodeField: { __typename: 'IdentityNumberInputField', input: { __typename: 'EGDSNumberInputField', label: '6-digit code', required: true }, validations: [{ __typename: 'IdentityRegexValidationRule', regex: '^[0-9]{6}$' }] },
    continueButton: { button: { primary: 'Continue' }, action: { __typename: 'IdentityVerifyEmailOTPAction', authenticationFlowVariant: 'SIGN_IN', verifyEmailOTPContext: null, accountTakeOverWidgets: [{ __typename: 'IdentityCsrfWidgetAction', type: 'CSRF', token: 'csrf', inputKeys: ['token'] }, { __typename: 'IdentityTrustWidgetAction', type: 'TRUST_WIDGET', inputKeys: ['payload'] }] } },
    resendCodeButton: { maxTimerInSeconds: 30, button: { primary: 'Resend' }, action: { __typename: 'IdentityResendEmailOTPAction', resendEmailOTPContext: 'resend-state', accountTakeOverWidgets: [{ __typename: 'IdentityCsrfWidgetAction', type: 'CSRF', token: 'resend-csrf', inputKeys: ['token'] }] } },
  } } };
  const parsed = parseOTPFormResponse(payload);
  assert.equal(parsed.fields[0].codeLength, 6);
  assert.equal(parsed.status, 'user_action_required');
  assert.throws(() => buildOTPActionOperation(context, parsed, { code: '010923', flowContext: { email: 'test@example.com', flowScenario: 'SIGNIN' } }), { code: 'AUTH_CHALLENGE_REQUIRED' });
  const operation = buildOTPActionOperation(context, parsed, { code: '010923', flowContext: { email: 'test@example.com', flowScenario: 'SIGNIN' }, challengeInputs: [{ type: 'TRUST_WIDGET', inputs: [{ key: 'payload', value: 'test-provider-result' }] }] });
  assert.equal(operation.operationName, 'identityVerifyOTPAuthenticationSubmit');
  assert.equal(operation.variables.request.oneTimePasscode, '010923');
  assert.equal(Object.hasOwn(operation.variables.request, 'verifyOTPContext'), false);
  assert.equal(Object.hasOwn(operation.variables.request, 'authenticationFlowVariant'), false);
  const resend = buildOTPActionOperation(context, parsed, { actionId: 'resendCodeButton', flowContext: { email: 'test@example.com' } });
  assert.equal(resend.operationName, 'identityResendOTPAuthenticateSubmit');
  assert.equal(resend.variables.request.resendOTPContext, 'resend-state');
});

test('ambiguous actions require explicit selection and read-only server inputs cannot be overwritten', () => {
  const parsed = parseAuthResponse(form({ value: 'server@example.com', readOnly: true }));
  parsed.actions.push({ ...parsed.actions[0], id: 'second', primary: true });
  assert.throws(() => buildAuthSubmitVariables(context, parsed), { code: 'AUTH_ACTION_REQUIRED' });
  assert.throws(() => buildAuthSubmitVariables(context, parsed, { actionId: 'server-continue-id', values: { 'server-email-id': 'other@example.com' } }), { code: 'READ_ONLY_AUTH_INPUT' });
});

test('refresh variables and exact shipped GraphQL documents retain provenance checksums', async () => {
  assert.deepEqual(buildAuthRefreshVariables(context), { context });
  const base = new URL('../src/graphql/auth/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('provenance.json', base), 'utf8'));
  for (const operation of manifest.operations) {
    const document = (await readFile(new URL(operation.file, base), 'utf8')).trimEnd();
    assert.equal(createHash('sha256').update(document).digest('hex'), operation.documentSha256);
    assert.match(document, new RegExp(`(?:query|mutation) ${operation.operation}\\(`));
  }
});
