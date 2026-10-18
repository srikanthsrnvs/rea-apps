// Native ConfirmEmailVM.z5/F6/H6 and W5 keep verification and resend ATO lists
// separate. A receipt is a state transition, not a replacement OTP form.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const types = new Map([
  ['IdentityResendOTPAuthenticationSuccessResponse', ['resend', true]],
  ['IdentityResendOTPAuthenticationFailureResponse', ['resend', false]],
  ['IdentitySendOTPAuthenticationSuccessResponse', ['send', true]],
  ['IdentitySendOTPAuthenticationFailureResponse', ['send', false]],
  ['IdentityVerifyOTPAuthenticationFailureResponse', ['verify', false]],
]);

function receiptOf(payload) {
  const queue = [payload];
  for (let count = 0; queue.length && count < 2000; count++) {
    const value = queue.shift();
    if (!object(value) && !Array.isArray(value)) continue;
    if (types.has(value.__typename)) return value;
    queue.push(...Object.values(value).filter(value => value && typeof value === 'object'));
  }
  return null;
}

function widgetRequirements(widgets) {
  return widgets.map(widget => ({
    kind: widget.__typename === 'IdentityCsrfWidgetAction' ? 'csrf' : 'user_action_required',
    type: widget.__typename,
    inputKeys: Array.isArray(widget.inputKeys) ? [...widget.inputKeys] : [],
    ...(typeof widget.publicKey === 'string' ? { publicKey: widget.publicKey } : {}),
  }));
}
function replaceWidgets(action, widgets) {
  if (!action?.nativeAction || !Array.isArray(widgets)) return;
  action.nativeAction.accountTakeOverWidgets = structuredClone(widgets);
  action.atoActions = structuredClone(widgets);
}
function bannerMessages(value, output = []) {
  if (typeof value === 'string') {
    if (value.trim()) output.push(value.trim().slice(0, 2000));
  } else if (Array.isArray(value)) value.forEach(value => bannerMessages(value, output));
  else if (object(value)) {
    for (const key of ['heading', 'message', 'text', 'primary', 'summary']) {
      if (Object.hasOwn(value, key)) bannerMessages(value[key], output);
    }
  }
  return [...new Set(output)];
}

/**
 * Return a cloned pending login for an OTP receipt/failure, or null when the
 * caller must parse a new form/authentication result normally. No I/O, replay,
 * credential acceptance or marketing-consent choice occurs here.
 */
export function applyOTPReceipt(pending, payload) {
  if (pending?.protocol !== 'native_otp' || !Array.isArray(pending.parsed?.actions) || !Array.isArray(pending.parsed?.challenges)) return null;
  const receipt = receiptOf(payload);
  const graphqlErrors = Array.isArray(payload?.errors) ? payload.errors.filter(error => typeof error?.message === 'string') : [];
  if (!receipt && !graphqlErrors.length) return null;
  const [kind, success] = receipt ? types.get(receipt.__typename) : ['verify', false];
  const result = structuredClone(pending);
  const actions = result.parsed.actions;
  const verify = actions.find(action => action.nativeAction?.__typename === 'IdentityVerifyEmailOTPAction');
  const resend = actions.find(action => action.nativeAction?.__typename === 'IdentityResendEmailOTPAction');
  const send = actions.find(action => action.nativeAction?.__typename === 'IdentitySendEmailOTPAction');
  result.lastResponse = structuredClone(payload);

  if (kind === 'resend') replaceWidgets(resend, receipt?.accountTakeOverWidgets);
  else if (kind === 'send') replaceWidgets(send, success ? undefined : receipt?.accountTakeOverWidgets);
  else if (!success) replaceWidgets(verify, receipt?.accountTakeOverWidgets);

  if (success) {
    result.flowContext ??= {};
    if (Object.hasOwn(receipt, 'referenceId') && (typeof receipt.referenceId === 'string' || receipt.referenceId === null)) {
      result.flowContext.referenceId = receipt.referenceId;
    }
    if (kind === 'resend' && typeof receipt.resendOTPContext === 'string') {
      if (!Object.hasOwn(result, 'queryOTPContext')) result.queryOTPContext = verify?.nativeAction?.verifyEmailOTPContext ?? null;
      if (!Object.hasOwn(result, 'queryResendOTPContext')) result.queryResendOTPContext = resend?.nativeAction?.resendEmailOTPContext ?? null;
      result.otpContext = receipt.resendOTPContext;
      if (verify?.nativeAction) verify.nativeAction.verifyEmailOTPContext = result.otpContext || result.queryOTPContext;
      if (resend?.nativeAction) resend.nativeAction.resendEmailOTPContext = result.otpContext || result.queryResendOTPContext;
    }
    if (kind === 'send' && typeof receipt.sendOTPContext === 'string') result.sendOTPContext = receipt.sendOTPContext;
    // W5 uses backButtonATOWidgets for the newly selected verification method.
    if (kind === 'send') replaceWidgets(verify, receipt.backButtonATOWidgets);
    result.parsed.errors = [];
    delete result.parsed.banner;
  } else {
    const messages = [...new Set([
      ...graphqlErrors.map(error => error.message.slice(0, 2000)),
      ...bannerMessages(receipt?.banner),
    ])];
    if (!messages.length) messages.push('Expedia did not accept this verification step. The current form is still available.');
    result.parsed.errors = messages.map(message => ({ fieldId: kind === 'verify' ? 'oneTimePasscode' : null, message }));
    result.parsed.banner = { messages };
  }

  // Only verification failures/switching methods can change verification ATOs.
  // Resend CSRF belongs to the resend action and must not replace verify CSRF.
  if ((kind === 'verify' && Array.isArray(receipt?.accountTakeOverWidgets))
      || (kind === 'send' && success && Array.isArray(receipt.backButtonATOWidgets))) {
    const code = result.parsed.challenges.filter(challenge => challenge.kind === 'verification_code');
    result.parsed.challenges = [...code, ...widgetRequirements(verify?.nativeAction?.accountTakeOverWidgets ?? [])];
  }
  const blocked = result.parsed.challenges.some(challenge => challenge.kind === 'user_action_required');
  result.parsed.status = success ? blocked ? 'user_action_required' : 'input_required' : 'error';
  result.parsed.userActionRequired = blocked;
  result.lastOTPReceipt = { kind, status: success ? 'code_sent' : 'error' };
  return result;
}
