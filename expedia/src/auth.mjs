import { randomUUID } from 'node:crypto';
import { createContext } from './context.mjs';
import { ExpediaHttpClient } from './http.mjs';
import { buildInitialAuthVariables, buildAuthSubmitVariables, buildAuthRefreshVariables, parseAuthResponse, extractSessionCookies, buildOTPFormVariables, parseOTPFormResponse, buildOTPActionOperation } from './auth-protocol.mjs';
import { readState, saveState, removeState, withStateLock } from './state.mjs';
import { ExpediaError } from './errors.mjs';
import { applyOTPReceipt } from './otp-lifecycle.mjs';
import { browserVerificationStatus, findVerificationTunnel, startBrowserVerification, takeBrowserVerification, removeBrowserVerification } from './verification-client.mjs';

const invalid = (code, message) => { throw new ExpediaError(code, message); };
async function publicLogin(pending) {
  const p = pending.parsed;
  return { loginId: pending.id, status: pending.phase !== 'ready' ? 'outcome_unknown' : p.status,
    expiresAt: pending.expiresAt,
    fields: p.fields.filter(f => !f.readOnly).map(f => ({ id: f.id, kind: f.kind, label: f.label, required: f.required, codeLength: f.codeLength })),
    actions: p.actions.map(a => ({ id: a.id, label: a.label, inputIds: a.inputIds })),
    challenges: p.challenges.map(c => ({ kind: c.kind, type: c.type, fieldId: c.fieldId, channel: c.channel, length: c.length, maskedTarget: c.maskedTarget })),
    errors: p.errors,
    verification: await browserVerificationStatus(pending.verification),
    codeDelivery: pending.codeDelivery ?? null,
  };
}
async function anonymous() {
  let state = await readState('anonymous');
  if (!state) {
    const context = createContext();
    state = { context, cookies: [{ name: 'DUAID', value: context.identity.duaid, domain: 'expedia.com', path: '/', secure: true }] };
    await saveState('anonymous', state);
  }
  return state;
}
async function acceptResponse(pending, payload, client) {
  const receipt = pending.protocol === 'native_otp' ? applyOTPReceipt(pending, payload) : null;
  if (receipt) {
    pending = receipt;
    pending.cookies = client.jar.cookies;
    pending.phase = 'ready';
    if (pending.codeDelivery && receipt.lastOTPReceipt?.kind === 'resend') {
      const sent = payload.data?.identityResendOTPAuthenticateSubmit;
      pending.codeDelivery = sent?.__typename === 'IdentityResendOTPAuthenticationSuccessResponse' && typeof sent.referenceId === 'string' && sent.referenceId
        ? { status: 'acknowledged', channel: 'email', acknowledgedAt: new Date().toISOString() }
        : { status: 'failed', channel: 'email' };
    }
    await saveState('pending-login', pending);
    return publicLogin(pending);
  }
  pending.lastResponse = payload;
  pending.parsed = pending.protocol === 'native_otp' ? parseOTPFormResponse(payload, { cookies: client.jar.cookies }) : parseAuthResponse(payload, { cookies: client.jar.cookies });
  if (pending.parsed.status === 'migration_required' && pending.parsed.nextStep?.operationName === 'identityAuthenticateByOTPForm') {
    pending.flowContext = pending.parsed.flowContext;
    pending.protocol = 'native_otp';
    pending.phase = 'loading_form';
    await saveState('pending-login', { ...pending, cookies: client.jar.cookies });
    const next = await client.graphql({ operationName: 'identityAuthenticateByOTPForm', group: 'auth', variables: buildOTPFormVariables(pending.context, { flowContext: pending.flowContext }) });
    pending.lastResponse = next;
    pending.parsed = parseOTPFormResponse(next, { cookies: client.jar.cookies });
  }
  client.jar.merge(extractSessionCookies(payload));
  pending.cookies = client.jar.cookies;
  pending.phase = 'ready';
  if (pending.parsed.status === 'authenticated') {
    // A success form alone must never replace a working account. Validate its
    // freshly issued transport session with the independent refresh operation.
    const validation = await client.graphql({ operationName: 'identityRefresh', group: 'auth', variables: buildAuthRefreshVariables(createContext({ duaid: pending.context.identity.duaid, profile: pending.parsed.profile })) });
    const verified = parseAuthResponse(validation, { cookies: client.jar.cookies });
    const actualEmail = verified.profile?.emailAddress ?? verified.profile?.email;
    if (verified.status !== 'authenticated' || pending.flowContext?.email && (typeof actualEmail !== 'string' || actualEmail.toLowerCase() !== pending.flowContext.email.toLowerCase())) {
      pending.phase = 'validation_failed';
      await saveState('pending-login', { ...pending, cookies: client.jar.cookies });
      invalid('SESSION_NOT_VALIDATED', 'Expedia did not independently validate the new login. Any saved account was preserved.');
    }
    const profile = verified.profile;
    client.jar.merge(verified.cookies);
    await saveState('session', { context: createContext({ duaid: pending.context.identity.duaid, profile }), cookies: client.jar.cookies, profile, validatedAt: new Date().toISOString() });
    await removeState('pending-login');
    await removeBrowserVerification(pending.verification);
    return { loginId: pending.id, status: 'authenticated', account: accountSummary(profile) };
  }
  await saveState('pending-login', pending);
  return publicLogin(pending);
}
function accountSummary(profile) { return { firstName: profile?.firstName ?? null, lastName: profile?.lastName ?? null }; }

export async function startLogin({ email } = {}) {
  if (email !== undefined && (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) invalid('INVALID_EMAIL', 'Enter the email address for an existing Expedia account.');
  return withStateLock(async () => {
    const previous = await readState('pending-login');
    // Returning a pending flow must never request another code silently.
    if (previous && Date.parse(previous.expiresAt) > Date.now()) {
      if (email && previous.flowContext?.email && email.toLowerCase() !== previous.flowContext.email.toLowerCase()) invalid('LOGIN_ALREADY_PENDING', 'Cancel the pending login before signing in with another email.');
      return publicLogin(previous);
    }
    if (previous) await removeBrowserVerification(previous.verification);
    const state = await anonymous(), client = new ExpediaHttpClient(state);
    const payload = await client.graphql({ operationName: 'IdentityLayoutQuery', group: 'auth', variables: buildInitialAuthVariables(state.context) });
    const pending = { id: randomUUID(), context: state.context, cookies: client.jar.cookies, expiresAt: new Date(Date.now() + 20 * 60000).toISOString(), parsed: parseAuthResponse(payload), lastResponse: payload, phase: 'ready' };
    await saveState('pending-login', pending);
    if (email === undefined) return publicLogin(pending);
    const fields = pending.parsed.fields.filter(f => f.kind === 'email' && !f.readOnly);
    const actions = pending.parsed.actions.filter(a => a.primary && a.inputIds.length === 1 && a.inputIds[0] === fields[0]?.id);
    if (fields.length !== 1 || actions.length !== 1) return publicLogin(pending);
    return submit(pending, client, { actionId: actions[0].id, values: { [fields[0].id]: email } });
  });
}
async function submit(pending, client, options) {
  const request = pending.protocol === 'native_otp'
    ? buildOTPActionOperation(pending.context, pending.parsed, { ...options, flowContext: pending.flowContext, code: options.values?.oneTimePasscode })
    : { operationName: 'identityFormSubmit', variables: buildAuthSubmitVariables(pending.context, pending.parsed, options) };
  // Never replay a login submission with an uncertain result (e.g. a code was sent).
  pending.phase = 'submission_pending';
  await saveState('pending-login', pending);
  const payload = await client.graphql({ ...request, group: 'auth' });
  return acceptResponse(pending, payload, client);
}
export async function completeLogin({ loginId, code, actionId, values } = {}) {
  return withStateLock(async () => {
    const pending = await readState('pending-login');
    if (!pending || pending.id !== loginId) invalid('LOGIN_NOT_FOUND', 'Use the loginId returned by expedia login.');
    if (Date.parse(pending.expiresAt) <= Date.now()) invalid('LOGIN_EXPIRED', 'This login expired. Cancel it and start a fresh login.');
    if (pending.phase !== 'ready') invalid('LOGIN_OUTCOME_UNKNOWN', 'The previous login request has an uncertain outcome. It was not repeated.');
    let input = values;
    if (code !== undefined) {
      if (values !== undefined || typeof code !== 'string' || !/^\d{4,10}$/.test(code)) invalid('INVALID_VERIFICATION_CODE', 'Enter the verification code as text.');
      const fields = pending.parsed.fields.filter(f => f.kind === 'code' && !f.readOnly);
      if (fields.length !== 1) invalid('AUTH_INPUT_REQUIRED', 'Expedia is not requesting a single verification code. Inspect auth status.');
      input = { [fields[0].id]: code };
    }
    if (!input) invalid('AUTH_INPUT_REQUIRED', 'Supply the current verification code or requested form fields.');
    // No silent registration, terms acceptance, password creation, or additional personal fields.
    for (const id of Object.keys(input)) {
      const field = pending.parsed.fields.find(f => f.id === id);
      if (!field || !['email', 'code'].includes(field.kind)) invalid('AUTH_USER_ACTION_REQUIRED', 'This sign-in step requires additional user action; automatic account creation is not supported.');
      if (field.kind === 'code' && (typeof input[id] !== 'string' || !/^\d{4,10}$/.test(input[id]) || field.codeLength && input[id].length !== field.codeLength)) invalid('INVALID_VERIFICATION_CODE', 'Enter the verification code exactly as received.');
    }
    let challengeInputs;
    if (pending.protocol === 'native_otp') {
      if (typeof input.oneTimePasscode !== 'string') invalid('AUTH_INPUT_REQUIRED', 'Supply the current email verification code.');
      const action = pending.parsed.actions.find(a => a.id === (actionId ?? pending.parsed.selectedActionId));
      const trust = action?.atoActions.find(w => w.__typename === 'IdentityTrustWidgetAction');
      const arkose = action?.atoActions.find(w => w.__typename === 'IdentityCaptchaArkoseMobileAppWidgetAction');
      if (trust || arkose) {
        if (!trust || !arkose) invalid('AUTH_CHALLENGE_REQUIRED', 'Expedia returned a verification combination this client does not support.');
        const { collectLinuxTrust } = await import('./trust.mjs');
        const measurement = await collectLinuxTrust();
        await takeBrowserVerification(pending.verification, arkose.publicKey, token => {
          challengeInputs = [
            { type: trust.type, inputs: trust.inputKeys.map(key => ({ key, value: measurement.encoded })) },
            { type: arkose.type, inputs: arkose.inputKeys.map(key => ({ key, value: token })) },
          ];
          // Compile and validate the complete native operation before consuming
          // its proof. Local mistakes must not invalidate a genuine callback.
          buildOTPActionOperation(pending.context, pending.parsed, { actionId, flowContext: pending.flowContext, code: input.oneTimePasscode, challengeInputs });
        });
      }
    }
    return submit(pending, new ExpediaHttpClient(pending), { actionId, values: input, challengeInputs });
  });
}
export async function authStatus() {
  return withStateLock(async () => {
    const [session, pending] = await Promise.all([readState('session'), readState('pending-login')]);
    return { authenticated: Boolean(session), validatedAt: session?.validatedAt ?? null, account: session ? accountSummary(session.profile) : null, pending: pending ? await publicLogin(pending) : null };
  });
}
export async function login({ email, replace = false } = {}) {
  if (email !== undefined && (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) invalid('INVALID_EMAIL', 'Enter the email address for an existing Expedia account.');
  const saved = await withStateLock(async () => {
    const session = await readState('session');
    const savedEmail = session?.profile?.emailAddress ?? session?.profile?.email;
    if (session && !replace && (!email || typeof savedEmail === 'string' && savedEmail.toLowerCase() === email.toLowerCase())) {
      return { status: 'authenticated', account: accountSummary(session.profile), validatedAt: session.validatedAt ?? null, validation: 'saved_session' };
    }
    return null;
  });
  if (saved) return saved;
  if (!email) invalid('EMAIL_REQUIRED', 'Provide --email to begin a fresh Expedia login.');
  if (process.platform !== 'linux') invalid('UNSUPPORTED_PLATFORM', 'Fresh login currently requires Linux host telemetry. Saved account commands also work on other platforms.');
  const tunnel = await findVerificationTunnel();
  await startLogin({ email });
  return withStateLock(async () => {
    let pending = await readState('pending-login');
    if (!pending) return { status: 'authenticated' };
    if (pending.phase !== 'ready' || pending.protocol !== 'native_otp') return publicLogin(pending);
    // The verified fresh-login path uses Expedia's returned resend action to
    // obtain an acknowledged delivery and its correlation reference exactly once.
    if (!pending.codeDelivery) {
      pending.codeDelivery = { status: 'submission_pending' };
      await saveState('pending-login', pending);
      await submit(pending, new ExpediaHttpClient(pending), { actionId: 'resendCodeButton' });
      pending = await readState('pending-login');
      if (pending.codeDelivery?.status !== 'acknowledged') invalid('CODE_DELIVERY_NOT_CONFIRMED', 'Expedia did not acknowledge the email-code request. Inspect auth status; it was not repeated.');
    }
    if (pending.codeDelivery.status !== 'acknowledged') invalid('CODE_DELIVERY_NOT_CONFIRMED', 'The previous email-code request was not confirmed. Cancel this login before starting again; it was not repeated.');
    const action = pending.parsed.actions.find(a => a.id === pending.parsed.selectedActionId);
    const arkose = action?.atoActions.find(w => w.__typename === 'IdentityCaptchaArkoseMobileAppWidgetAction');
    const verification = await browserVerificationStatus(pending.verification);
    // An explicit login command may renew a completed/expired browser proof,
    // but never replays the code request or an uncertain verification mutation.
    if (['consumed', 'failed', 'expired'].includes(verification?.status)) {
      await removeBrowserVerification(pending.verification);
      delete pending.verification;
      await saveState('pending-login', pending);
    }
    if (arkose && !pending.verification) {
      pending.verification = await startBrowserVerification(pending.id, arkose, tunnel);
      await saveState('pending-login', pending);
    }
    return publicLogin(pending);
  });
}
export async function cancelLogin({ loginId }) {
  return withStateLock(async () => {
    const pending = await readState('pending-login');
    if (pending && pending.id !== loginId) invalid('LOGIN_NOT_FOUND', 'Use the current loginId.');
    await removeBrowserVerification(pending?.verification);
    await removeState('pending-login'); return { status: 'cancelled' };
  });
}
export async function logout() {
  return withStateLock(async () => {
    const pending = await readState('pending-login');
    await removeBrowserVerification(pending?.verification);
    await removeState('session'); await removeState('pending-login');
    await removeState('native-login'); await removeState('native-candidate');
    return { status: 'logged_out' };
  });
}
export async function refreshLogin() {
  return withStateLock(async () => {
    const session = await readState('session');
    if (!session) invalid('LOGIN_REQUIRED', 'No saved Expedia session. Use expedia login --email EMAIL; anonymous flight search is also available.');
    const client = new ExpediaHttpClient(session);
    const context = { ...session.context, identity: createContext({ duaid: session.context.identity.duaid, profile: session.profile }).identity };
    const payload = await client.graphql({ operationName: 'identityRefresh', group: 'auth', variables: buildAuthRefreshVariables(context) });
    const parsed = parseAuthResponse(payload, { cookies: client.jar.cookies });
    if (parsed.status !== 'authenticated') invalid('SESSION_NOT_VALIDATED', 'Expedia did not validate the saved session. Start a fresh login.');
    client.jar.merge(extractSessionCookies(payload));
    await saveState('session', { ...session, context: { ...context, identity: createContext({ duaid: context.identity.duaid, profile: parsed.profile }).identity }, profile: parsed.profile, cookies: client.jar.cookies, validatedAt: new Date().toISOString() });
    return { status: 'authenticated', account: accountSummary(parsed.profile) };
  });
}
export async function withClient(operation) {
  return withStateLock(async () => {
    const isAuthenticated = Boolean(await readState('session'));
    const state = await readState('session') ?? await anonymous();
    const client = new ExpediaHttpClient(state);
    try { return await operation(client, state.context); }
    finally { await saveState(isAuthenticated ? 'session' : 'anonymous', { ...state, cookies: client.jar.cookies }); }
  });
}
