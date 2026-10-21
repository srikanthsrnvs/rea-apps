import { randomUUID, createHash } from 'node:crypto';
import { readCredentials } from './credentials.mjs';
import { createClient } from './client.mjs';
import { readState, saveState, removeState, withStateLock } from './state.mjs';
import { requireSuccess } from './http.mjs';
import { AmexError } from './errors.mjs';
import { buildStreamingPasswordLogin } from './auth-stream-protocol.mjs';
import { parseLoginSummary, buildLoginMfaOptions, parseLoginMfaOptions, buildLoginMfaOtpDelivery,
  parseLoginMfaOtpDelivery, buildLoginMfaOtpVerification, parseLoginMfaVerification } from './auth-protocol.mjs';
import { buildAccountSummary, parseAccountSummary, responseGate } from './account-protocol.mjs';

const TTL = 5 * 60_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw new AmexError(code, message); };
function withoutInputSecrets(value) {
  if (Array.isArray(value)) return value.map(withoutInputSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:password|otp|oneTimePasscode|challengeAnswer)$/iu.test(key))
    .map(([key, item]) => [key, withoutInputSecrets(item)]));
  return value;
}
function responseForJournal(response) {
  // Only this response header affects native business-success classification.
  // Request auth headers and unrelated response cookies/tokens are unnecessary
  // for replay-free recovery and must not be copied into the journal.
  const businessStatus = response.headers?.['x-axp-business-layer-status'];
  return { status: response.status,
    headers: businessStatus === undefined ? {} : { 'x-axp-business-layer-status': businessStatus },
    body: withoutInputSecrets(response.body) };
}
function publicStatus(flow) {
  return { loginId: flow.id, phase: flow.phase, authenticated: false,
    expiresAt: new Date(flow.expiresAt).toISOString(), ...(flow.reason ? { reason: flow.reason } : {}),
    ...(flow.phase === 'otp_options' ? { options: flow.options.map(item => ({ id: item.id,
      supported: item.supported, method: item.option.category, destination: item.option.subtitle })) } : {}),
    ...(flow.phase === 'code_required' ? { next: `amex auth verify --login-id ${flow.id} --code CODE` } : {}),
    ...(flow.phase === 'validation_required' ? { next: `amex auth validate --login-id ${flow.id}` } : {}),
    ...(flow.phase === 'request_pending' ? { message: 'This request has an uncertain outcome and will not be repeated automatically.' } : {}) };
}
async function requireFlow(id) {
  const flow = await readState('login');
  if (!flow || flow.id !== id) fail('LOGIN_NOT_FOUND', 'No matching pending Amex login.');
  if (Date.now() >= flow.expiresAt) fail('LOGIN_EXPIRED', 'This login expired. Start a fresh sign-in.');
  return flow;
}
function tokenUpdate(flow, result) {
  if (result.jsonWebToken) flow.context = { ...flow.context, jsonWebToken: result.jsonWebToken };
}
async function consume(flow) {
  const journal = await readState('auth-response');
  if (flow.phase !== 'request_pending' || journal?.loginId !== flow.id
    || !flow.pending?.requestId || journal.requestId !== flow.pending.requestId
    || journal.action !== flow.pending.action) return flow;
  let result;
  try {
    const body = requireSuccess(journal.response);
    const parsers = { login: parseLoginSummary, options: parseLoginMfaOptions, delivery: parseLoginMfaOtpDelivery, verification: parseLoginMfaVerification };
    const gate = responseGate(body);
    result = parsers[journal.action](body);
    // Keep genuine returned transport context, while an explicit secondary
    // authentication directive always overrides apparent DTO success.
    if (gate.phase === 'action_required') result = { ...result, ...gate };
  } catch (error) {
    result = { phase: 'action_required', reason: error.code ?? 'unrecognized_response' };
  }
  flow = { ...flow, reason: result.reason ?? result.action ?? null };
  if (journal.action === 'login') {
    flow.context = { ...(result.partialSession ?? result.sessionCandidate), additionalHeaders: result.additionalHeaders ?? [] };
    if (result.phase === 'candidate_authenticated') flow.phase = 'validation_required';
    else if (result.phase === 'mfa_required' && flow.context.jsonWebToken?.rawToken) flow.phase = 'mfa_options_required';
    else { flow.phase = result.phase === 'failed' ? 'failed' : 'action_required'; flow.reason ??= result.phase; }
  } else {
    tokenUpdate(flow, result);
    if (result.phase === 'verification_complete') flow.phase = 'validation_required';
    else if (result.phase === 'otp_options') { flow.phase = 'otp_options'; flow.options = result.options; }
    else if (result.phase === 'code_required') { flow.phase = 'code_required'; flow.resendAt = Date.now() + 30_000; }
    else { flow.phase = result.phase === 'failed' ? 'failed' : 'action_required'; flow.reason ??= result.nextChallenge ?? result.phase; }
  }
  await saveState('login', flow);
  await removeState('auth-response');
  return flow;
}
async function perform(flow, action, request) {
  const client = await createClient(action === 'login' ? { anonymous: true } : { session: flow.context });
  const requestId = randomUUID();
  // A previous consume may have crashed after saving its result but before
  // deleting its response. That old response must never complete this request.
  await removeState('auth-response');
  flow = { ...flow, phase: 'request_pending', pending: { requestId, action, method: request.method, path: request.path, startedAt: Date.now() } };
  // Request body is deliberately absent: it can contain a password or passcode.
  await saveState('login', flow);
  const response = await client.response(request);
  await saveState('auth-response', { loginId: flow.id, requestId, action, response: responseForJournal(response) });
  return consume(flow);
}
async function validate(flow) {
  if (!flow.context?.jsonWebToken?.rawToken) fail('AUTH_VALIDATION_REQUIRED', 'No candidate session is available for account validation.');
  const client = await createClient({ session: flow.context });
  const response = await client.request(buildAccountSummary({ sessionContext: flow.context.sessionContext }));
  const account = parseAccountSummary(response);
  if (account.phase !== 'ready' || !account.bindings?.length) {
    flow.phase = 'action_required'; flow.reason = 'account_validation_incomplete';
    await saveState('login', flow); return publicStatus(flow);
  }
  if (Date.now() >= flow.expiresAt) fail('LOGIN_EXPIRED', 'This login expired before independent account validation finished.');
  const ownerId = flow.context.publicGuid ? hash(`amex:${flow.context.publicGuid}`) : flow.ownerSeed;
  await saveState('session', { ...flow.context, version: 1, ownerId, validated: true, validatedAt: new Date().toISOString() });
  await removeState('account-cache');
  const result = { phase: 'authenticated', authenticated: true,
    cards: account.cards.map(card => ({ productName: card.productName, ending: card.ending })) };
  await saveState('login-result', result);
  await removeState('login'); await removeState('auth-response');
  return result;
}
async function advance(flow) {
  if (flow.phase === 'mfa_options_required') {
    flow = await perform(flow, 'options', buildLoginMfaOptions({ riskToken: flow.context.riskToken }));
  }
  return flow.phase === 'validation_required' ? validate(flow) : publicStatus(flow);
}

export async function startLogin({ replace = false, ...options } = {}) {
  return withStateLock(async () => {
    const saved = await readState('session');
    if (saved?.validated === true && !replace) return { phase: 'session_saved', savedSession: true, next: 'Use amex accounts to check the session, or login --replace for a fresh login.' };
    const current = await readState('login');
    if (current && current.expiresAt > Date.now() && !replace) return advance(await consume(current));
    const credentials = await readCredentials(options);
    const request = buildStreamingPasswordLogin(credentials);
    const flow = { version: 1, id: randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + TTL,
      ownerSeed: hash(`amex-user:${credentials.userId}`), phase: 'starting', attempts: 0, deliveries: 0 };
    await removeState('auth-response');
    return advance(await perform(flow, 'login', request));
  });
}
export async function sendCode({ loginId, optionId } = {}) {
  return withStateLock(async () => {
    let flow = await consume(await requireFlow(loginId));
    if (!['otp_options', 'code_required'].includes(flow.phase)) fail('AUTH_STEP_UNAVAILABLE', 'This login is not ready to request a code.');
    if (flow.deliveries >= 3 || Date.now() < (flow.resendAt ?? 0)) fail('AUTH_RESEND_COOLDOWN', 'Wait before requesting another code; at most three explicit requests are allowed.');
    const selected = flow.options?.find(item => item.id === optionId && item.supported === true);
    if (!selected) fail('INVALID_MFA_OPTION', 'Choose a supported option ID returned by this login.');
    flow.selectedOption = selected.option; flow.deliveries++;
    flow = await perform(flow, 'delivery', buildLoginMfaOtpDelivery({ option: flow.selectedOption }));
    return advance(flow);
  });
}
export async function verifyCode({ loginId, code } = {}) {
  return withStateLock(async () => {
    let flow = await consume(await requireFlow(loginId));
    if (flow.phase === 'validation_required') return validate(flow);
    if (flow.phase !== 'code_required' || !flow.selectedOption) fail('AUTH_STEP_UNAVAILABLE', 'Request and receive the current verification code first.');
    if (flow.attempts >= 5) fail('AUTH_ATTEMPT_LIMIT', 'Start a fresh sign-in after too many code attempts.');
    const request = buildLoginMfaOtpVerification({ option: flow.selectedOption, code, riskToken: flow.context.riskToken });
    flow.attempts++;
    return advance(await perform(flow, 'verification', request));
  });
}
export async function validateLogin({ loginId } = {}) {
  return withStateLock(async () => {
    const flow = await consume(await requireFlow(loginId));
    if (flow.phase !== 'validation_required') fail('AUTH_VALIDATION_REQUIRED', 'This login has no completed candidate to validate.');
    return validate(flow);
  });
}
export async function authStatus() {
  return withStateLock(async () => {
    const saved = await readState('session'); let flow = await readState('login');
    if (flow?.expiresAt <= Date.now()) {
      await removeState('login'); await removeState('auth-response'); flow = null;
    }
    return { savedSession: saved?.validated === true, ...(flow ? { pending: publicStatus(await consume(flow)) } : {}) };
  });
}
export async function cancelLogin({ loginId } = {}) {
  return withStateLock(async () => {
    if (loginId && (await readState('login'))?.id !== loginId) fail('LOGIN_NOT_FOUND', 'No matching pending login.');
    await removeState('login'); await removeState('auth-response'); return { phase: 'login_cancelled' };
  });
}
export async function logout() {
  return withStateLock(async () => {
    for (const name of ['session', 'login', 'auth-response', 'account-cache', 'account-response', 'login-result']) await removeState(name);
    // Financial submission journals remain available to prevent duplicate debits.
    return { phase: 'signed_out', scope: 'local_cli' };
  });
}
