import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPasswordLogin, buildSessionTransferLogin, buildOtpChannels,
  buildOtpDelivery, buildOtpValidation, parseLoginSummary,
  buildTokenValidation, buildSessionExtension,
  buildLoginMfaOptions, parseLoginMfaOptions, buildLoginMfaOtpDelivery, parseLoginMfaOtpDelivery,
  buildLoginMfaOtpVerification, parseLoginMfaVerification, LOGIN_MFA_JOURNEY,
} from '../src/auth-protocol.mjs';

function candidate() {
  return {
    status: { success: true },
    logonData: { status: 0, gateKeeperCookie: 'synthetic-gatekeeper', jsonWebToken: { rawToken: 'synthetic-jwt' } },
    summary: { status: 0, cardList: [] },
  };
}

test('password login uses the native DTO without device trust enrollment', () => {
  const request = buildPasswordLogin({ userId: 'example-user', password: 'synthetic-password' });
  assert.equal(request.path, '/services/accountservicing/v1/loginsummary');
  assert.equal(request.retry, false);
  assert.deepEqual(request.body, {
    loginCredentials: { userIdLogin: { userId: 'example-user', password: 'synthetic-password', rememberMeFlag: false } },
    cardArtRequest: [{ tag: 'big-image', minimumWidth: 1490 }],
  });
  assert.throws(() => buildPasswordLogin({ userId: 'example-user', password: '' }));
  assert.throws(() => buildPasswordLogin({ userId: 'example-user', password: 'secret', rememberMe: 'yes' }));
  assert.equal(buildPasswordLogin({ userId: 'example-user', password: 'secret', rememberMe: true })
    .body.loginCredentials.userIdLogin.rememberMeFlag, true);
});

test('session transfer accepts an existing code, without inventing an issuer', () => {
  assert.deepEqual(buildSessionTransferLogin({ transferCode: 'synthetic-transfer' }).body, {
    loginCredentials: { sessionTransfer: { transferCode: 'synthetic-transfer' } },
    cardArtRequest: [{ tag: 'big-image', minimumWidth: 1490 }],
  });
  assert.throws(() => buildSessionTransferLogin({ transferCode: '\n' }));
});

test('OTP requests preserve offered channel data and encode context as segments', () => {
  const context = { accountToken: 'synthetic/account', actionId: 'synthetic action' };
  assert.equal(buildOtpChannels(context).path, '/services/otp/v1/challengeOptions/synthetic%2Faccount/synthetic%20action');
  const channel = { deliveryMethod: 'synthetic-method', channelType: 'synthetic-type', encryptedValue: 'opaque-value', displayValue: '••1234' };
  assert.deepEqual(buildOtpDelivery({ ...context, channel }).body, channel);
  assert.throws(() => buildOtpDelivery({ ...context, channel: { ...channel, encryptedValue: undefined } }));
  assert.deepEqual(buildOtpValidation({ ...context, code: '001234' }).body, { oneTimePasscode: '001234' });
  assert.throws(() => buildOtpValidation({ ...context, code: 1234 }));
  assert.throws(() => buildOtpValidation({ ...context, code: '1234' }));
});

test('a successful native envelope remains a candidate until independent validation', () => {
  const parsed = parseLoginSummary(candidate());
  assert.equal(parsed.phase, 'candidate_authenticated');
  assert.equal(parsed.authenticated, false);
  assert.equal(parsed.requiresAccountValidation, true);
  assert.equal(parsed.sessionCandidate.jsonWebToken.rawToken, 'synthetic-jwt');
  assert.equal(parsed.sessionCandidate.gateKeeperCookie, 'synthetic-gatekeeper');
});

test('a successful full summary with JWT-only context remains an unvalidated candidate', () => {
  const response = candidate(); delete response.logonData.gateKeeperCookie;
  const parsed = parseLoginSummary(response);
  assert.equal(parsed.phase, 'candidate_authenticated');
  assert.equal(parsed.authenticated, false);
  assert.equal(parsed.requiresAccountValidation, true);
  assert.equal(parsed.sessionCandidate.jsonWebToken.rawToken, 'synthetic-jwt');
  assert.equal(parsed.sessionCandidate.gateKeeperCookie, undefined);
});

test('MFA and action-required branches preserve genuine additional headers without aliasing the response', () => {
  const branches = [
    { status: 4 },
    { status: 1, otpTempSessionToken: 'synthetic-reset-token' },
    { status: 2, upgradeInfo: {} },
    { status: 0, statusCode: 'POST_LOGIN_WITH_NO_CARDS_LINKED' },
  ];
  for (const branch of branches) {
    const response = candidate(); Object.assign(response.logonData, branch);
    response.additionalHeaders = [{ key: 'x-axp-synthetic-context', value: 'synthetic-context' }];
    const parsed = parseLoginSummary(response);
    assert.equal(parsed.authenticated, false);
    assert.deepEqual(parsed.additionalHeaders, response.additionalHeaders);
    assert.equal(parsed.partialSession.jsonWebToken.rawToken, 'synthetic-jwt');
    parsed.additionalHeaders[0].value = 'changed-copy';
    assert.equal(response.additionalHeaders[0].value, 'synthetic-context');
  }
});

test('partial MFA JWTs and blocked branches can never become authenticated', () => {
  for (const branch of [{ status: 4 }, { status: 0, multiFactorAuthentication: { deviceTrusted: false, version: 'synthetic' } }]) {
    const response = candidate(); Object.assign(response.logonData, branch);
    const parsed = parseLoginSummary(response);
    assert.equal(parsed.phase, 'mfa_required');
    assert.equal(parsed.authenticated, false);
    assert.ok(parsed.partialSession);
    assert.equal(parsed.sessionCandidate, undefined);
  }
  const partialOnly = candidate(); partialOnly.logonData.status = 4;
  delete partialOnly.logonData.gateKeeperCookie;
  partialOnly.logonData.cupcake = 'synthetic-cupcake';
  const pendingMfa = parseLoginSummary(partialOnly);
  assert.equal(pendingMfa.phase, 'mfa_required');
  assert.equal(pendingMfa.partialSession.jsonWebToken.rawToken, 'synthetic-jwt');
  assert.equal(pendingMfa.partialSession.cupcake, 'synthetic-cupcake');
  assert.equal(pendingMfa.partialSession.gateKeeperCookie, undefined);
  assert.equal(pendingMfa.sessionCandidate, undefined);
  const reset = candidate(); Object.assign(reset.logonData, { status: 1, otpTempSessionToken: 'synthetic-reset' });
  assert.equal(parseLoginSummary(reset).action, 'password_reset');
  const upgrade = candidate(); Object.assign(upgrade.logonData, { status: 2, upgradeInfo: {} });
  assert.equal(parseLoginSummary(upgrade).action, 'app_upgrade');
  const noCards = candidate(); noCards.logonData.statusCode = 'POST_LOGIN_WITH_NO_CARDS_LINKED';
  assert.equal(parseLoginSummary(noCards).action, 'no_linked_cards');
});

test('unknown or conflicting login results fail closed', () => {
  for (const response of [null, {}, { status: { success: 'true' } }, { status: { success: true } }]) {
    assert.equal(parseLoginSummary(response).phase, 'unknown');
  }
  const rejected = candidate(); rejected.status.success = false;
  assert.equal(parseLoginSummary(rejected).phase, 'failed');
  const conflicting = candidate(); conflicting.status.errorScreen = {};
  assert.equal(parseLoginSummary(conflicting).phase, 'failed');
  const logonFailed = candidate(); logonFailed.logonData.status = -1;
  assert.equal(parseLoginSummary(logonFailed).phase, 'failed');
  const summaryFailed = candidate(); summaryFailed.summary.status = -1;
  assert.equal(parseLoginSummary(summaryFailed).phase, 'failed');
  const noSummary = candidate(); delete noSummary.summary;
  assert.equal(parseLoginSummary(noSummary).phase, 'unknown');
  const noJwt = candidate(); delete noJwt.logonData.jsonWebToken;
  assert.equal(parseLoginSummary(noJwt).phase, 'unknown');
});

test('session management uses the actual GET annotations', () => {
  assert.equal(buildTokenValidation().method, 'GET');
  assert.equal(buildTokenValidation().path, '/services/sessionManagement/v1/tokenValidation');
  assert.equal(buildSessionExtension().method, 'GET');
  assert.equal(buildSessionExtension().path, '/services/sessionManagement/v1/extendSession');
});

const offeredOtp = {
  category: 'OTP_SMS', categoryType: 'OTP', encryptedValue: 'synthetic-encrypted-destination',
  title: 'Text message', subtitle: '••• 1234',
};

test('migrated login MFA options preserve the native journey and omit unset headers', () => {
  const request = buildLoginMfaOptions();
  assert.equal(request.path, '/services/secondaryAuthentication/v3/challengeOptions');
  assert.deepEqual(request.body, { actionId: 'MFAOI01', userJourneyIdentifier: LOGIN_MFA_JOURNEY });
  assert.deepEqual(request.headers, {});
  const withRisk = buildLoginMfaOptions({ riskToken: 'synthetic-risk-context' });
  assert.deepEqual(withRisk.headers, { 'x-axp-risk-token': 'synthetic-risk-context' });
});

test('MFA options expose only offered supported OTP branches without completing login', () => {
  const parsed = parseLoginMfaOptions({ status: { success: true }, data: {
    status: 'CHALLENGE_REQUIRED', jsonWebToken: { rawToken: 'synthetic-mfa-jwt' },
    challengeOptions: [offeredOtp, { category: 'GOVERNMENT_ID', categoryType: 'GOVERNMENT_ID' }],
  } });
  assert.equal(parsed.phase, 'otp_options');
  assert.equal(parsed.authenticated, false);
  assert.equal(parsed.options[0].supported, true);
  assert.equal(parsed.options[1].supported, false);
  assert.equal(parseLoginMfaOptions({ status: { success: true }, data: { status: 'FUTURE_STATUS' } }).phase, 'unknown');
  const noChallenge = parseLoginMfaOptions({ status: { success: true }, data: {
    status: 'NO_CHALLENGE_REQUIRED', jsonWebToken: { rawToken: 'synthetic-verified-jwt' },
  } });
  assert.equal(noChallenge.requiresAccountValidation, true);
  assert.equal(noChallenge.authenticated, false);
});

test('MFA OTP delivery uses the selected native subtitle and encrypted destination', () => {
  const request = buildLoginMfaOtpDelivery({ option: offeredOtp });
  assert.equal(request.path, '/services/secondaryAuthentication/v3/otpDeliver');
  assert.deepEqual(request.body, {
    deliveryMethod: 'SMS', displayValue: '••• 1234', encryptedValue: 'synthetic-encrypted-destination',
    userJourneyIdentifier: LOGIN_MFA_JOURNEY,
  });
  assert.throws(() => buildLoginMfaOtpDelivery({ option: { ...offeredOtp, category: 'GOVERNMENT_ID' } }));
  const parsed = parseLoginMfaOtpDelivery({ status: { success: true }, data: {
    jsonWebToken: { rawToken: 'synthetic-delivery-jwt' }, successLabels: { title: 'Enter the code' },
  } });
  assert.equal(parsed.phase, 'code_required');
  assert.equal(parseLoginMfaOtpDelivery({ status: { success: true }, data: {} }).phase, 'unknown');
});

test('MFA verification preserves tagged DTOs and distinguishes pending from completion', () => {
  const request = buildLoginMfaOtpVerification({ option: offeredOtp, code: '001234' });
  assert.equal(request.path, '/services/secondaryAuthentication/v3/challengeVerification');
  assert.deepEqual(request.body, {
    category: 'OTP_SMS', categoryType: 'OTP', challengeAnswer: '001234',
    encryptedValue: 'synthetic-encrypted-destination', userJourneyIdentifier: LOGIN_MFA_JOURNEY,
  });
  const parsed = parseLoginMfaVerification({ status: { success: true }, data: {
    status: 'SUCCESS', jsonWebToken: { rawToken: 'synthetic-verified-jwt' },
  } });
  assert.equal(parsed.phase, 'verification_complete');
  assert.equal(parsed.authenticated, false);
  assert.equal(parsed.requiresAccountValidation, true);
  assert.equal(parseLoginMfaVerification({ status: { success: true }, data: {
    status: 'PENDING', jsonWebToken: { rawToken: 'synthetic-next-jwt' }, nextChallenge: 'OTP',
  } }).phase, 'next_challenge');
  assert.equal(parseLoginMfaVerification({ status: { success: true }, data: {
    status: 'PENDING', jsonWebToken: { rawToken: 'synthetic-next-jwt' }, nextChallenge: 'FUTURE_CHALLENGE',
  } }).phase, 'unknown');
  assert.equal(parseLoginMfaVerification({ status: { success: true }, data: {
    status: 'SUCCESS', jsonWebToken: 'unexpected-wire-token',
  } }).phase, 'unknown');
});
