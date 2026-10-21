import { randomUUID } from 'node:crypto';
import { createAuthFlow, buildAuthRequest, applyAuthResponse, publicAuthStatus } from './auth-protocol.mjs';
import { createClient, getDevice } from './client.mjs';
import { readState, saveState, removeState, withStateLock } from './state.mjs';
import { AirbnbError } from './errors.mjs';
import { buildAccount, parseAccount } from './account-protocol.mjs';
import { extractAirlock, airlockWidget, buildAirlockSubmit, buildAirlockStatus, parseAirlockSubmit } from './airlock-protocol.mjs';
import { createAirlockCheckpoint, buildAirlockResume } from './airlock-flow.mjs';
import { findVerificationTunnel, startBrowserVerification, browserVerificationStatus, takeBrowserVerification, removeBrowserVerification } from './verification-client.mjs';
import { requireSuccess } from './http.mjs';
import { buildPhoneCodeRequest, parsePhoneCodeResponse } from './phone-code-protocol.mjs';

async function status(flow) {
  const result = { loginId: flow.loginId, ...publicAuthStatus(flow) };
  if (flow.status === 'request_pending') result.next = 'The previous request has an uncertain outcome. Start a new login explicitly; this CLI will not replay it.';
  if (flow.status === 'code_required') result.next = `airbnb auth verify --login-id ${flow.loginId} --code CODE`;
  if (flow.codeDispatch) result.codeDispatch = flow.codeDispatch;
  if (flow.airlockCheckpoint) {
    result.verification = { phase: flow.airlockCheckpoint.phase, ...(flow.browserVerification ? await browserVerificationStatus(flow.browserVerification) : { status: 'not_started' }) };
    result.next = flow.airlockCheckpoint.phase === 'waiting'
      ? `airbnb auth verification ${flow.browserVerification ? 'resume' : 'start'} --login-id ${flow.loginId}`
      : 'The protected request was already retried or has an uncertain outcome. Inspect status; it will not be replayed again.';
  }
  return result;
}
async function validateAndSave(flow) {
  if (Date.now() >= flow.expiresAt) throw new AirbnbError('AUTH_FLOW_EXPIRED', 'This sign-in flow expired. Start a new sign-in.');
  if (!flow.candidateTokens?.token) throw new AirbnbError('AUTH_VALIDATION_REQUIRED', 'The login has no candidate session to validate.');
  const session = { token: flow.candidateTokens.token, aaj: flow.candidateTokens.aaj?.aaj,
    userId: flow.userId, nativeSessionId: flow.nativeSessionId, aajAcquiredAt: flow.updatedAt };
  const client = await createClient({ session });
  const data = await client.request(buildAccount());
  let viewer, user;
  try { ({ viewer, user } = parseAccount(data, { expectedUserId: flow.userId })); }
  catch { throw new AirbnbError('AUTH_VALIDATION_FAILED', 'Airbnb did not independently confirm the expected account. The saved session was not replaced.'); }
  if (flow.isNewAccount) throw new AirbnbError('UNEXPECTED_NEW_ACCOUNT', 'This login returned a new account. The existing saved account was not replaced.');
  await saveState('session', { ...session, accountId: user.id, savedAt: new Date().toISOString() });
  await saveState('auth-context', { persisted: flow.persisted });
  const result = { status: 'authenticated', authenticated: true, loginId: flow.loginId,
    account: { id: user.id, name: user.displayFirstName || user.firstName, email: viewer.email } };
  await saveState('login-result', result);
  await removeState('login'); await removeState('auth-response'); await removeState('auth-response-debug');
  return result;
}
async function consumeResponse(flow) {
  const recorded = await readState('auth-response');
  if (!recorded || recorded.loginId !== flow.loginId) return flow;
  if (flow.status !== 'request_pending') {
    await removeState('auth-response');
    return flow;
  }
  const challenge = extractAirlock(recorded.response);
  let next;
  if (challenge && recorded.request) {
    const repeated = flow.airlockCheckpoint?.phase === 'replay_pending';
    next = { ...flow, status: 'action_required', pendingRequest: null,
      requiredSteps: [repeated ? 'airlock_repeated' : 'airlock'], error: repeated ? 'AUTH_VERIFICATION_REPEATED' : 'AUTH_VERIFICATION_REQUIRED',
      airlockCheckpoint: repeated ? { ...flow.airlockCheckpoint, phase: 'replay_responded' }
        : createAirlockCheckpoint(flow, recorded.request, recorded.response) };
  } else if (flow.pendingRequest?.transport === 'phone_gateway') {
    const dispatch = parsePhoneCodeResponse(requireSuccess(recorded.response), flow.identifier.phoneNumber);
    next = { ...flow, status: 'code_required', pendingRequest: null, codeDispatch: dispatch,
      error: null, requiredSteps: [], resendAvailableAt: Date.now() + 30_000 };
    await removeBrowserVerification(flow.browserVerification);
    delete next.airlockCheckpoint; delete next.browserVerification; delete next.verificationSubmission;
  } else {
    next = applyAuthResponse(flow, recorded.response);
    await removeBrowserVerification(flow.browserVerification);
    delete next.airlockCheckpoint; delete next.browserVerification; delete next.verificationSubmission;
  }
  next.loginId = flow.loginId;
  const nativeId = recorded.response.headers?.['x-airbnb-set-native-session-id'];
  if (nativeId) next.nativeSessionId = nativeId;
  if (next.status === 'action_required' || next.status === 'denied') await saveState('auth-response-debug', recorded);
  else await removeState('auth-response-debug');
  await saveState('login', next);
  await removeState('auth-response');
  return next;
}
async function perform(flow, action) {
  const built = buildAuthRequest(flow, action);
  const next = { ...built.nextFlow, loginId: flow.loginId };
  const client = await createClient({ anonymous: true });
  const { nextFlow: _, ...spec } = built;
  const prepared = await client.prepare(spec);
  await saveState('login', next);
  const response = await client.response(prepared);
  // Save the acknowledged response before parsing it. A crash cannot resend an OTP.
  await saveState('auth-response', { loginId: flow.loginId, request: prepared, response });
  const updated = await consumeResponse(next);
  return updated.status === 'validation_required' ? validateAndSave(updated) : status(updated);
}
export async function login({ email, phone, countryCode, replace = false } = {}) {
  // Validate the identifier before replacing any in-progress flow.
  createAuthFlow({ email, phone, countryCode });
  return withStateLock(async () => {
    const saved = await readState('session');
    if (saved && !replace) return { status: 'session_saved', savedSession: true, next: 'Use airbnb account to validate the saved session, or login --replace for a fresh login.' };
    let current = await readState('login');
    if (current && !replace && Date.now() < current.expiresAt) {
      current = await consumeResponse(current);
      return current.status === 'validation_required' ? validateAndSave(current) : status(current);
    }
    const device = await getDevice(), context = await readState('auth-context');
    const flow = { ...createAuthFlow({ email, phone, countryCode, deviceId: device.id, persisted: context?.persisted }), loginId: randomUUID() };
    await removeState('auth-response');
    await removeBrowserVerification(current?.browserVerification);
    return perform(flow, { action: 'identify' });
  });
}
export async function authStep({ loginId, code, method, resend = false } = {}) {
  return withStateLock(async () => {
    let flow = await readState('login');
    if (!flow || (loginId && flow.loginId !== loginId)) throw new AirbnbError('LOGIN_NOT_FOUND', 'No matching pending login. Start with airbnb login.');
    flow = await consumeResponse(flow);
    if (flow.status === 'validation_required') return validateAndSave(flow);
    return perform(flow, { action: resend ? 'resend' : 'verify', ...(resend ? {} : { code }), ...(method ? { method } : {}) });
  });
}
export async function requestPhoneCode({ loginId, initial = false } = {}) {
  return withStateLock(async () => {
    let flow = await readState('login');
    if (!flow || flow.loginId !== loginId) throw new AirbnbError('LOGIN_NOT_FOUND', 'No matching pending login.');
    flow = await consumeResponse(flow);
    if (Date.now() >= flow.expiresAt) throw new AirbnbError('AUTH_FLOW_EXPIRED', 'Start a new login.');
    if (flow.status !== 'code_required' || flow.identifier.type !== 'phone' || flow.activeMethod !== 'sms') throw new AirbnbError('AUTH_METHOD_UNAVAILABLE', 'This command requires a native phone login waiting for an SMS code.');
    if (initial ? flow.initialPhoneGatewayRequested || flow.codeDispatch || flow.resendCount !== 0
      : Date.now() < flow.resendAvailableAt || flow.resendCount >= 3) throw new AirbnbError('AUTH_RESEND_COOLDOWN', 'Wait for the cooldown; at most three explicit code requests are allowed.');
    const client = await createClient({ anonymous: true });
    const request = await client.prepare(buildPhoneCodeRequest(flow.identifier.phoneNumber));
    flow = { ...flow, status: 'request_pending', initialPhoneGatewayRequested: true, resendCount: flow.resendCount + (initial ? 0 : 1),
      pendingRequest: { action: initial ? 'identify' : 'resend', transport: 'phone_gateway', method: 'sms', previousSteps: flow.steps } };
    await saveState('login', flow);
    const response = await client.response(request);
    await saveState('auth-response', { loginId, request, response });
    return status(await consumeResponse(flow));
  });
}
function requireCheckpoint(flow, loginId) {
  if (!flow || flow.loginId !== loginId || !flow.airlockCheckpoint) throw new AirbnbError('LOGIN_NOT_FOUND', 'No matching login awaiting verification.');
  if (Date.now() >= flow.expiresAt) throw new AirbnbError('AUTH_FLOW_EXPIRED', 'This sign-in expired. Start a new sign-in.');
  if (flow.airlockCheckpoint.phase !== 'waiting') throw new AirbnbError('AUTH_REQUEST_PENDING', 'The protected request was already retried or has an uncertain outcome. It will not be sent again.');
  return flow.airlockCheckpoint;
}
export async function startAuthVerification({ loginId } = {}) {
  return withStateLock(async () => {
    const flow = await readState('login');
    const checkpoint = requireCheckpoint(flow, loginId);
    if (!flow.browserVerification) {
      const tunnel = await findVerificationTunnel();
      flow.browserVerification = await startBrowserVerification(loginId, airlockWidget(checkpoint.airlock), tunnel, { ttlMs: Math.min(15 * 60000, flow.expiresAt - Date.now()) });
      await saveState('login', flow);
    }
    return status(flow);
  });
}
export async function resumeAuthVerification({ loginId } = {}) {
  return withStateLock(async () => {
    let flow = await readState('login');
    if (!flow || flow.loginId !== loginId) throw new AirbnbError('LOGIN_NOT_FOUND', 'No matching pending login.');
    // A recorded protected response can be consumed after a crash without any POST.
    if (flow.status === 'request_pending' && (await readState('auth-response'))?.loginId === loginId) {
      flow = await consumeResponse(flow);
      return flow.status === 'validation_required' ? validateAndSave(flow) : status(flow);
    }
    const checkpoint = requireCheckpoint(flow, loginId);
    const client = await createClient({ anonymous: true });
    const browser = await browserVerificationStatus(flow.browserVerification);
    let journal = await readState('airlock-submit-response');
    if (journal?.loginId !== loginId) journal = null;
    if (browser?.status === 'completed' && !flow.verificationSubmission && !journal) {
      flow.verificationSubmission = { status: 'pending', startedAt: Date.now() };
      await saveState('login', flow);
      const token = await takeBrowserVerification(flow.browserVerification, airlockWidget(checkpoint.airlock).publicKey,
        value => buildAirlockSubmit(checkpoint.airlock, value));
      const response = await client.response(buildAirlockSubmit(checkpoint.airlock, token));
      journal = { loginId, response };
      await saveState('airlock-submit-response', journal);
    }
    if (journal) {
      parseAirlockSubmit(requireSuccess(journal.response), checkpoint.airlock);
      flow.verificationSubmission = { ...flow.verificationSubmission, status: 'responded' };
      await saveState('login', flow);
    }
    const checked = await client.request(buildAirlockStatus(checkpoint.airlock));
    let resumed;
    try { resumed = buildAirlockResume(checkpoint, checked); }
    catch (error) {
      if (error.code !== 'VERIFICATION_INCOMPLETE') throw error;
      return status(flow);
    }
    flow = { ...checkpoint.flow, loginId, airlockCheckpoint: resumed.nextCheckpoint,
      browserVerification: flow.browserVerification, verificationSubmission: flow.verificationSubmission };
    // Atomically reserve this sole retry before transmitting it.
    await saveState('login', flow);
    const response = await client.response(resumed.request);
    await saveState('auth-response', { loginId, request: resumed.request, response });
    const next = await consumeResponse(flow);
    await removeState('airlock-submit-response');
    return next.status === 'validation_required' ? validateAndSave(next) : status(next);
  });
}
export async function authStatus() {
  return withStateLock(async () => {
    let flow = await readState('login');
    if (flow && Date.now() >= flow.expiresAt) {
      await removeBrowserVerification(flow.browserVerification);
      flow = { ...flow, status: 'expired', steps: [], candidateTokens: null, pendingRequest: null };
      delete flow.airlockCheckpoint; delete flow.browserVerification; delete flow.verificationSubmission;
      await saveState('login', flow); await removeState('auth-response'); await removeState('auth-response-debug');
    }
    const session = await readState('session');
    return { savedSession: Boolean(session?.token), ...(flow ? { pending: await status(await consumeResponse(flow)) } : {}),
      ...(!flow && !session ? { status: 'signed_out' } : {}) };
  });
}
export async function cancelLogin({ loginId } = {}) {
  return withStateLock(async () => {
    const flow = await readState('login');
    if (loginId && flow?.loginId !== loginId) throw new AirbnbError('LOGIN_NOT_FOUND', 'No matching pending login.');
    await removeBrowserVerification(flow?.browserVerification);
    await removeState('login'); await removeState('auth-response'); await removeState('auth-response-debug');
    await removeState('airlock-submit-response');
    return { status: 'login_cancelled' };
  });
}
export async function logout() {
  return withStateLock(async () => {
    await removeBrowserVerification((await readState('login'))?.browserVerification);
    for (const name of ['session', 'login', 'auth-response', 'auth-response-debug', 'auth-context', 'request-context', 'login-result', 'airlock-submit-response']) await removeState(name);
    return { status: 'signed_out', scope: 'local_cli' };
  });
}
