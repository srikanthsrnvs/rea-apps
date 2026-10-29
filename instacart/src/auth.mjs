// Exact shipped Apollo documents; preserve whitespace for persisted-query hashes.
export const AUTH_QUERIES = Object.freeze({
  "SendPhoneNumberVerificationCode": "mutation SendPhoneNumberVerificationCode($phoneNumber: String!, $countryCallingCode: String, $requestType: UsersVerificationCodeRequestType, $authConfigurationToken: String, $recaptchaType: UsersRecaptchaType, $recaptchaSiteKey: String) { sendVerificationCode(identifier: $phoneNumber, countryCallingCode: $countryCallingCode, identifierType: phoneNumber, requestType: $requestType, authConfigurationToken: $authConfigurationToken, recaptchaType: $recaptchaType, recaptchaSiteKey: $recaptchaSiteKey) { __typename ... on UsersSendVerificationCodeResponse { expiresAt nextCodeAt verificationSessionToken } ... on SharedError { errorTypes } } }",
  "ResendPhoneNumberVerificationCode": "mutation ResendPhoneNumberVerificationCode($phoneNumber: String!, $countryCallingCode: String, $requestType: UsersVerificationCodeRequestType, $authConfigurationToken: String, $recaptchaType: UsersRecaptchaType, $recaptchaSiteKey: String) { sendVerificationCode(identifier: $phoneNumber, countryCallingCode: $countryCallingCode, identifierType: phoneNumber, requestType: $requestType, authConfigurationToken: $authConfigurationToken, recaptchaType: $recaptchaType, recaptchaSiteKey: $recaptchaSiteKey) { __typename ... on UsersSendVerificationCodeResponse { expiresAt nextCodeAt verificationSessionToken } ... on SharedError { errorTypes } } }",
  "ResendEmailVerificationCode": "mutation ResendEmailVerificationCode($identifier: String!, $identifierType: UsersIdentityType!, $recaptcha: String, $requestType: UsersVerificationCodeRequestType, $authConfigurationToken: String, $recaptchaType: UsersRecaptchaType, $recaptchaSiteKey: String) { sendVerificationCode(identifier: $identifier, identifierType: $identifierType, recaptcha: $recaptcha, requestType: $requestType, authConfigurationToken: $authConfigurationToken, recaptchaType: $recaptchaType, recaptchaSiteKey: $recaptchaSiteKey) { __typename ... on UsersSendVerificationCodeResponse { expiresAt nextCodeAt verificationSessionToken } ... on SharedError { errorTypes } } }",
  "CreateUserSessionFromPhoneNumber": "mutation CreateUserSessionFromPhoneNumber($identifier: String!, $verificationCode: String!, $linkUserAccounts: Boolean!, $countryCallingCode: String, $authConfigurationToken: String, $verificationSessionToken: String) { createUserSessionFromVerificationCode(identifier: $identifier, identifierType: phoneNumber, linkUserAccounts: $linkUserAccounts, verificationCode: $verificationCode, countryCallingCode: $countryCallingCode, authConfigurationToken: $authConfigurationToken, verificationSessionToken: $verificationSessionToken) { __typename ...AuthResult } }  fragment AuthResult on UsersAuthResult { __typename ... on UsersAuthToken { token } ... on SharedError { errorTypes } }",
  "CreateUserSessionFromVerificationCode": "mutation CreateUserSessionFromVerificationCode($identifier: String!, $type: UsersIdentityType!, $linkUserAccounts: Boolean!, $verificationCode: String!, $accountType: UsersAccountTypes, $authConfigurationToken: String, $verificationSessionToken: String) { createUserSessionFromVerificationCode(identifier: $identifier, identifierType: $type, linkUserAccounts: $linkUserAccounts, verificationCode: $verificationCode, accountType: $accountType, authConfigurationToken: $authConfigurationToken, verificationSessionToken: $verificationSessionToken) { __typename ...AuthResult } }  fragment AuthResult on UsersAuthResult { __typename ... on UsersAuthToken { token } ... on SharedError { errorTypes } }",
  "IdentityConfig": "query IdentityConfig { authConfiguration { authConfigurationToken recapatchaEnterpriseAuthV4NativeKey incogniaClientId sardineClientId sardineEnv viewSection { identitySdkM1 { tmxProfilingVariant recaptchaVariant } } } }"
});

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  throw error;
}

function serverFailure(result) {
  const types = (Array.isArray(result?.errorTypes) ? result.errorTypes : [])
    .filter(value => typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,100}$/.test(value));
  const challenge = types.some(value => /captcha|challenge|profiling|attest/i.test(value));
  fail(challenge ? 'AUTH_CHALLENGE_REQUIRED' : 'AUTH_REJECTED',
    challenge ? 'Instacart requires an identity challenge that the headless CLI cannot complete.'
      : 'Instacart did not accept this authentication request.',
    { errorTypes: types, responseType: /^[a-zA-Z0-9_]{1,100}$/.test(result?.__typename ?? '') ? result.__typename : undefined });
}

function destination(options) {
  if (Boolean(options.phone) === Boolean(options.email)) fail('INVALID_ARGUMENT', 'Supply exactly one phone number or email address.');
  if (options.email) {
    const identifier = String(options.email).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) fail('INVALID_ARGUMENT', 'Supply a valid email address.');
    return { identifier, type: 'email' };
  }
  const countryCallingCode = String(options.countryCallingCode ?? '1').replace(/^\+/, '');
  if (!/^[1-9]\d{0,3}$/.test(countryCallingCode)) fail('INVALID_ARGUMENT', 'Supply a valid country calling code.');
  let identifier = String(options.phone).trim().replace(/[\s().-]/g, '');
  if (identifier.startsWith('+' + countryCallingCode)) identifier = identifier.slice(countryCallingCode.length + 1);
  if (!/^\d{6,15}$/.test(identifier)) fail('INVALID_ARGUMENT', 'Supply a phone number and its matching country calling code.');
  return { identifier, countryCallingCode, type: 'phoneNumber' };
}

function masked(pending) {
  if (pending.type === 'email') {
    const [local, domain] = pending.identifier.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  return `+${pending.countryCallingCode} ***${pending.identifier.slice(-4)}`;
}

function pendingStatus(pending) {
  return { status: pending.candidateAccessToken ? 'validation_pending'
    : pending.responseIncomplete ? 'verification_session_incomplete' : 'verification_required',
    method: pending.type === 'email' ? 'email' : 'sms', destination: masked(pending),
    expiresAt: pending.expiresAt, nextCodeAt: pending.nextCodeAt };
}

export function authStatus(state) {
  return { authenticated: Boolean(state.accessToken),
    ...(state.pendingLogin ? { pending: pendingStatus(state.pendingLogin) } : {}) };
}

export async function authStart(client, state, options = {}) {
  const target = destination(options);
  const now = options.now ?? Date.now();
  const pending = state.pendingLogin;
  if (pending && pending.identifier === target.identifier && pending.type === target.type
      && pending.countryCallingCode === target.countryCallingCode) {
    if (pending.candidateAccessToken) return pendingStatus(pending);
    if (pending.responseIncomplete && !options.resend) fail('AUTH_RESPONSE_INVALID', 'A previous code request returned an incomplete session. It has been retained privately; no new code was requested.');
    if (!options.resend && Date.parse(pending.expiresAt) > now) return pendingStatus(pending);
    if (options.resend && Date.parse(pending.nextCodeAt) > now) fail('AUTH_RESEND_TOO_SOON', 'Wait until nextCodeAt before requesting another code.', { nextCodeAt: pending.nextCodeAt });
  } else if (pending && !options.replacePending) {
    fail('AUTH_LOGIN_PENDING', 'Another login is pending. Complete it or explicitly replace the pending login.');
  }
  const configuration = await client.graphql('IdentityConfig', AUTH_QUERIES.IdentityConfig, {});
  const config = configuration?.authConfiguration;
  if (!config || typeof config.authConfigurationToken !== 'string') fail('AUTH_CONFIGURATION_INVALID', 'Instacart did not return a usable authentication configuration.');
  const variables = { requestType: 'loginRequestInitiated', authConfigurationToken: config.authConfigurationToken,
    recaptchaType: 'recaptchaTypeEnterpriseV3' };
  if (typeof config.recapatchaEnterpriseAuthV4NativeKey === 'string') variables.recaptchaSiteKey = config.recapatchaEnterpriseAuthV4NativeKey;
  let operation;
  if (target.type === 'phoneNumber') {
    operation = options.resend ? 'ResendPhoneNumberVerificationCode' : 'SendPhoneNumberVerificationCode';
    Object.assign(variables, { phoneNumber: target.identifier, countryCallingCode: target.countryCallingCode });
  } else {
    operation = 'ResendEmailVerificationCode';
    Object.assign(variables, { identifier: target.identifier, identifierType: 'email' });
  }
  const result = (await client.graphql(operation, AUTH_QUERIES[operation], variables))?.sendVerificationCode;
  if (result?.__typename !== 'UsersSendVerificationCodeResponse') serverFailure(result);
  // The generated Android adapter requires both ISO8601DateTime fields, but
  // explicitly accepts a nullable verificationSessionToken. Some accepted OTP
  // requests therefore legitimately have no session token.
  const validTiming = typeof result.expiresAt === 'string' && Number.isFinite(Date.parse(result.expiresAt))
    && typeof result.nextCodeAt === 'string' && Number.isFinite(Date.parse(result.nextCodeAt));
  state.pendingLogin = { ...target, verificationSessionToken: typeof result.verificationSessionToken === 'string' ? result.verificationSessionToken : null,
    authConfigurationToken: config.authConfigurationToken, expiresAt: result.expiresAt,
    nextCodeAt: result.nextCodeAt, requestedAt: new Date(now).toISOString() };
  if (!validTiming) {
    // A successful union response may already have sent the code. Retain its
    // private fields before reporting a parse error rather than resending.
    state.pendingLogin.responseIncomplete = true;
    fail('AUTH_RESPONSE_INVALID', 'Instacart returned invalid verification timing. The response was retained privately; no new code was requested.', {
      expiresAtType: typeof result.expiresAt, nextCodeAtType: typeof result.nextCodeAt });
  }
  return pendingStatus(state.pendingLogin);
}

export async function authComplete(client, state, options = {}) {
  const pending = state.pendingLogin;
  if (!pending) fail('AUTH_NO_LOGIN_PENDING', 'Start a login before supplying its verification code.');
  if (typeof options.validateSession !== 'function') fail('AUTH_VALIDATOR_REQUIRED', 'A read-only session validator is required before saving authentication.');
  if (!pending.candidateAccessToken) {
    if (pending.responseIncomplete) fail('AUTH_RESPONSE_INVALID', 'The pending verification session has incomplete timing and must be recovered before confirmation.');
    if (Date.parse(pending.expiresAt) <= (options.now ?? Date.now())) fail('AUTH_CODE_EXPIRED', 'This verification session expired. Request a fresh login code.');
    if (!/^\d{4,8}$/.test(String(options.code ?? ''))) fail('INVALID_ARGUMENT', 'Supply the fresh verification code as digits.');
    const operation = pending.type === 'phoneNumber' ? 'CreateUserSessionFromPhoneNumber' : 'CreateUserSessionFromVerificationCode';
    const variables = { identifier: pending.identifier, verificationCode: String(options.code),
      linkUserAccounts: false, authConfigurationToken: pending.authConfigurationToken };
    if (pending.verificationSessionToken != null) variables.verificationSessionToken = pending.verificationSessionToken;
    if (pending.type === 'phoneNumber') variables.countryCallingCode = pending.countryCallingCode;
    else variables.type = 'email';
    const result = (await client.graphql(operation, AUTH_QUERIES[operation], variables))?.createUserSessionFromVerificationCode;
    if (result?.__typename !== 'UsersAuthToken') serverFailure(result);
    if (typeof result.token !== 'string' || !result.token) fail('AUTH_RESPONSE_INVALID', 'Instacart returned an empty session.');
    pending.candidateAccessToken = result.token;
  }
  // Keep an existing valid session if the replacement fails validation. Keep the
  // candidate privately so retrying validation does not consume the OTP twice.
  const account = await options.validateSession(pending.candidateAccessToken);
  if (!account) fail('AUTH_SESSION_INVALID', 'The new session could not be verified. The previous saved session was preserved.');
  state.accessToken = pending.candidateAccessToken;
  state.authenticatedAt = new Date(options.now ?? Date.now()).toISOString();
  delete state.pendingLogin;
  return { authenticated: true, authenticatedAt: state.authenticatedAt };
}

export function authLogout(state) {
  delete state.accessToken;
  delete state.pendingLogin;
  delete state.authenticatedAt;
  return { authenticated: false, scope: 'local' };
}
