// Native Amex Android 7.34.1 contracts. These functions perform no network I/O
// and never turn a partially authenticated MFA response into a saved session.

function requiredText(value, name, maximum = 16_384) {
  if (typeof value !== 'string' || !value.length || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`Invalid ${name}`);
  return value;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function authRequest(path, body) {
  return { method: 'POST', path, body, sensitive: true, retry: false };
}

export function buildPasswordLogin({ userId, password, rememberMe = false } = {}) {
  requiredText(userId, 'user ID', 512);
  requiredText(password, 'password', 4096);
  if (typeof rememberMe !== 'boolean') throw new TypeError('rememberMe must be a boolean');
  return authRequest('/services/accountservicing/v1/loginsummary', {
    loginCredentials: { userIdLogin: { userId, password, rememberMeFlag: rememberMe } },
    cardArtRequest: [{ tag: 'big-image', minimumWidth: 1490 }],
  });
}

// The app consumes transferCode, but a browser issuer for a new login has not
// been established. This builder does not create one or authorize one to exist.
export function buildSessionTransferLogin({ transferCode } = {}) {
  requiredText(transferCode, 'session transfer code');
  return authRequest('/services/accountservicing/v1/loginsummary', {
    loginCredentials: { sessionTransfer: { transferCode } },
    cardArtRequest: [{ tag: 'big-image', minimumWidth: 1490 }],
  });
}

export function buildOtpChannels({ accountToken, actionId } = {}) {
  return { method: 'GET', path: otpPath('challengeOptions', accountToken, actionId), sensitive: true };
}

function otpPath(operation, accountToken, actionId) {
  requiredText(accountToken, 'account token');
  requiredText(actionId, 'action ID', 512);
  return `/services/otp/v1/${operation}/${encodeURIComponent(accountToken)}/${encodeURIComponent(actionId)}`;
}

export function buildOtpDelivery({ accountToken, actionId, channel } = {}) {
  if (!object(channel)) throw new TypeError('An offered OTP channel is required');
  const body = Object.fromEntries(['deliveryMethod', 'channelType', 'encryptedValue', 'displayValue']
    .map(key => [key, requiredText(channel[key], `channel ${key}`)]));
  return authRequest(otpPath('deliver', accountToken, actionId), body);
}

export function buildOtpValidation({ accountToken, actionId, code } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/u.test(code)) {
    throw new TypeError('The one-time passcode must be a six-digit string');
  }
  return authRequest(otpPath('validate', accountToken, actionId), { oneTimePasscode: code });
}

function transportContextFromLogon(logon) {
  const jwt = logon.jsonWebToken?.rawToken;
  const gatekeeper = logon.gateKeeperCookie;
  const session = {};
  if (typeof jwt === 'string' && jwt) session.jsonWebToken = { rawToken: jwt };
  if (typeof gatekeeper === 'string' && gatekeeper) session.gateKeeperCookie = gatekeeper;
  for (const key of ['cupcake', 'publicGuid', 'sessionContext', 'riskToken']) {
    if (typeof logon[key] === 'string' && logon[key]) session[key] = logon[key];
  }
  if (object(logon.sessionManagement)) session.sessionManagement = structuredClone(logon.sessionManagement);
  return Object.keys(session).length ? session : null;
}

// This is deliberately a candidate result. The orchestrator must perform an
// independent authenticated account read before replacing a validated session.
// Return values may contain credentials and must never be printed wholesale.
export function parseLoginSummary(response) {
  if (!object(response) || !object(response.status) || typeof response.status.success !== 'boolean') {
    return { phase: 'unknown', authenticated: false, reason: 'unrecognized_login_envelope' };
  }
  if (response.status.success !== true || response.status.errorMessage || response.status.errorScreen) {
    return { phase: 'failed', authenticated: false, reason: 'login_rejected', status: structuredClone(response.status) };
  }
  const logon = response.logonData;
  if (!object(logon) || !Number.isSafeInteger(logon.status)) {
    return { phase: 'unknown', authenticated: false, reason: 'missing_logon_data' };
  }
  if (logon.status <= -1) {
    return { phase: 'failed', authenticated: false, reason: 'logon_rejected', statusCode: logon.statusCode ?? null };
  }
  const additionalHeaders = Array.isArray(response.additionalHeaders)
    ? structuredClone(response.additionalHeaders) : [];
  const partialSession = transportContextFromLogon(logon);
  if (logon.status === 1 && typeof logon.otpTempSessionToken === 'string' && logon.otpTempSessionToken) {
    return { phase: 'action_required', authenticated: false, action: 'password_reset', partialSession, additionalHeaders };
  }
  if (logon.status === 2 && logon.upgradeInfo != null) {
    return { phase: 'action_required', authenticated: false, action: 'app_upgrade', partialSession, additionalHeaders };
  }
  if (logon.status === 4 || logon.multiFactorAuthentication != null) {
    return {
      phase: 'mfa_required', authenticated: false, partialSession, additionalHeaders,
      challenge: logon.multiFactorAuthentication == null ? null : structuredClone(logon.multiFactorAuthentication),
      directives: response.directives == null ? null : structuredClone(response.directives),
    };
  }
  if (String(logon.statusCode).toUpperCase() === 'POST_LOGIN_WITH_NO_CARDS_LINKED') {
    return { phase: 'action_required', authenticated: false, action: 'no_linked_cards', partialSession, additionalHeaders };
  }
  const summary = response.summary;
  if (!object(summary) || !Number.isSafeInteger(summary.status)) {
    return { phase: 'unknown', authenticated: false, reason: 'missing_summary' };
  }
  if (summary.status <= -1) return { phase: 'failed', authenticated: false, reason: 'summary_rejected' };
  if (!partialSession?.jsonWebToken) {
    return { phase: 'unknown', authenticated: false, reason: 'missing_session_credentials' };
  }
  return {
    phase: 'candidate_authenticated', authenticated: false, requiresAccountValidation: true,
    sessionCandidate: partialSession,
    additionalHeaders,
    summary: structuredClone(summary),
  };
}

export function buildTokenValidation() {
  return { method: 'GET', path: '/services/sessionManagement/v1/tokenValidation', sensitive: true };
}

export function buildSessionExtension() {
  // The shipped annotation is GET even though the DTO is named POSTResponse.
  return { method: 'GET', path: '/services/sessionManagement/v1/extendSession', sensitive: true, retry: false };
}

export const LOGIN_MFA_JOURNEY = 'aexp.global:create:session';

function optionalContextHeaders({ accountToken, riskToken, experience } = {}) {
  const headers = {};
  for (const [name, value] of [
    ['x-axp-account-token', accountToken], ['x-axp-risk-token', riskToken],
    ['x-axp-step-up-experience', experience],
  ]) if (value != null) headers[name] = requiredText(value, name);
  return headers;
}

// This is the app's migrated MFA branch, not the old generic /otp feature.
// The migrated native caller passes no StepUpExperience for this branch.
export function buildLoginMfaOptions({ accountToken, riskToken } = {}) {
  return {
    ...authRequest('/services/secondaryAuthentication/v3/challengeOptions', {
      actionId: 'MFAOI01', userJourneyIdentifier: LOGIN_MFA_JOURNEY,
    }),
    headers: optionalContextHeaders({ accountToken, riskToken }),
  };
}

const otpMethods = { OTP_SMS: 'SMS', OTP_EMAIL: 'EMAIL', OTP_VOICE: 'VOICE' };

function supportedOtp(option) {
  if (!object(option) || !Object.hasOwn(otpMethods, option.category) || option.categoryType !== 'OTP') {
    throw new TypeError('A supported offered OTP option is required');
  }
  requiredText(option.encryptedValue, 'OTP encrypted value');
  return option;
}

function acceptedEnvelope(response) {
  if (!object(response) || !object(response.status) || typeof response.status.success !== 'boolean') return 'unknown';
  if (!response.status.success || response.status.errorMessage || response.status.errorScreen) return 'failed';
  return object(response.data) ? 'accepted' : 'unknown';
}

function resultJwt(data) {
  return object(data?.jsonWebToken) && typeof data.jsonWebToken.rawToken === 'string'
    && data.jsonWebToken.rawToken ? structuredClone(data.jsonWebToken) : null;
}

export function parseLoginMfaOptions(response) {
  const envelope = acceptedEnvelope(response);
  if (envelope !== 'accepted') return { phase: envelope, authenticated: false };
  const data = response.data;
  const jsonWebToken = resultJwt(data);
  if (data.status === 'NO_CHALLENGE_REQUIRED' && jsonWebToken) {
    return { phase: 'verification_complete', authenticated: false, requiresAccountValidation: true, jsonWebToken };
  }
  if (data.status !== 'CHALLENGE_REQUIRED' || !Array.isArray(data.challengeOptions) || !jsonWebToken) {
    return { phase: 'unknown', authenticated: false };
  }
  const options = data.challengeOptions.map((option, index) => {
    let supported = false;
    try { supportedOtp(option); supported = typeof option.subtitle === 'string' && !!option.subtitle; } catch {}
    return { id: `option-${index + 1}`, supported, option: structuredClone(option) };
  });
  return {
    phase: options.some(option => option.supported) ? 'otp_options' : 'action_required',
    authenticated: false, options, jsonWebToken,
    selectionScreen: data.challengeOptionsSelectionScreen == null ? null : structuredClone(data.challengeOptionsSelectionScreen),
  };
}

export function buildLoginMfaOtpDelivery({ option, userJourneyIdentifier = LOGIN_MFA_JOURNEY, experience } = {}) {
  supportedOtp(option);
  return {
    ...authRequest('/services/secondaryAuthentication/v3/otpDeliver', {
      deliveryMethod: otpMethods[option.category],
      // Native ChallengeSelectionScreen passes option.subtitle as displayValue.
      displayValue: requiredText(option.subtitle, 'OTP destination display value'),
      encryptedValue: option.encryptedValue,
      userJourneyIdentifier: requiredText(userJourneyIdentifier, 'user journey identifier'),
    }),
    headers: optionalContextHeaders({ experience }),
  };
}

export function parseLoginMfaOtpDelivery(response) {
  const envelope = acceptedEnvelope(response);
  if (envelope !== 'accepted') return { phase: envelope, authenticated: false };
  const jsonWebToken = resultJwt(response.data);
  if (!jsonWebToken || !object(response.data.successLabels)) return { phase: 'unknown', authenticated: false };
  return {
    phase: 'code_required', authenticated: false, jsonWebToken,
    labels: structuredClone(response.data.successLabels),
  };
}

export function buildLoginMfaOtpVerification({
  option, code, userJourneyIdentifier = LOGIN_MFA_JOURNEY, accountToken, riskToken, experience,
} = {}) {
  supportedOtp(option);
  requiredText(code, 'one-time passcode', 256);
  return {
    ...authRequest('/services/secondaryAuthentication/v3/challengeVerification', {
      category: option.category, categoryType: option.categoryType,
      challengeAnswer: code, encryptedValue: option.encryptedValue,
      userJourneyIdentifier: requiredText(userJourneyIdentifier, 'user journey identifier'),
    }),
    headers: optionalContextHeaders({ accountToken, riskToken, experience }),
  };
}

export function parseLoginMfaVerification(response) {
  const envelope = acceptedEnvelope(response);
  if (envelope !== 'accepted') return { phase: envelope, authenticated: false };
  const data = response.data;
  const jsonWebToken = resultJwt(data);
  if (!jsonWebToken) return { phase: 'unknown', authenticated: false };
  if (data.status === 'SUCCESS') {
    return { phase: 'verification_complete', authenticated: false, requiresAccountValidation: true, jsonWebToken };
  }
  const knownNextChallenges = ['AEXP_CARD_ACCOUNT_SECURITY_CODE', 'GOVERNMENT_ID', 'N_DIGIT_SECURITY_CODE', 'OTP', 'TOTP'];
  if (data.status === 'PENDING' && knownNextChallenges.includes(data.nextChallenge)) {
    return { phase: 'next_challenge', authenticated: false, jsonWebToken, nextChallenge: structuredClone(data.nextChallenge) };
  }
  return { phase: 'unknown', authenticated: false };
}
