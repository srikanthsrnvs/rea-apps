import { ExpediaError } from './errors.mjs';

const DEVICE_TYPES = new Set(['APP_PHONE', 'APP_TABLET', 'CHAT_APP', 'DESKTOP', 'MOBILE_PHONE', 'MOBILE_TABLET', 'VOICE_APP']);
const LAYOUTS = new Set(['SIGNIN', 'HYBRID_LOGIN', 'GET_SEND_OTP_ATO', 'GET_SIGN_IN_ATO', 'GET_SIGN_IN_VERIFY_OTP_ATO']);
const FIELD_TYPES = new Map([
  ['EGDSEmailInputField', 'email'], ['EGDSPasswordInputField', 'password'],
  ['EGDSNumberInputField', 'number'], ['EGDSTextInputField', 'text'],
  ['EGDSBasicCheckBox', 'checkbox'],
]);

function fail(code, message, details) { throw new ExpediaError(code, message, details); }
function string(value) { return typeof value === 'string' ? value : null; }
function plainText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.text === 'string') return value.text;
  return null;
}

// A server response can contain repeated fragments. Bound traversal and preserve identity.
function entries(root) {
  const queue = [{ value: root, owner: null, path: '$' }], seen = new Set(), result = [];
  for (let index = 0; index < queue.length; index++) {
    if (index > 30000) fail('AUTH_RESPONSE_TOO_LARGE', 'Expedia returned an oversized login form.');
    const item = queue[index], value = item.value;
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value); result.push(item);
    const owner = !Array.isArray(value) && typeof value.egdsElementId === 'string' ? value : item.owner;
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === 'object') queue.push({ value: child, owner, path: `${item.path}.${key}` });
    }
  }
  return result;
}

export function buildInitialAuthVariables(context, options = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) fail('INVALID_AUTH_CONTEXT', 'A native Expedia client context is required.');
  const layout = options.layout ?? 'SIGNIN';
  if (!LAYOUTS.has(layout)) fail('UNSUPPORTED_AUTH_LAYOUT', 'This Expedia login layout has not been established from the app.');
  const deviceType = options.deviceType ?? 'MOBILE_PHONE';
  if (!DEVICE_TYPES.has(deviceType)) fail('INVALID_AUTH_DEVICE', 'Unknown Expedia device type.');
  const pageLocation = options.pageLocation ?? 'USER';
  if (!['USER', 'SYSTEM', 'CHECKOUT', 'SEARCH_RESULTS', 'ENTRY'].includes(pageLocation)) fail('INVALID_AUTH_PAGE', 'Unknown Expedia login page location.');
  return {
    context: structuredClone(context),
    clientInfo: {
      appName: options.appName ?? 'android.com.expedia.bookings', appVersion: options.appVersion ?? '2026.41.0',
      channelType: 'ANDROID', deviceOS: 'ANDROID', deviceType,
    },
    layout, pageLocation,
    ...(options.migrationContext !== undefined ? { migrationContext: options.migrationContext } : {}),
    ...(options.migrationStepIdentifier !== undefined ? { migrationStepIdentifier: options.migrationStepIdentifier } : {}),
  };
}

export function buildAuthRefreshVariables(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) fail('INVALID_AUTH_CONTEXT', 'A native Expedia client context is required.');
  return { context: structuredClone(context) };
}

export function extractSessionCookies(payload) {
  const cookies = new Map();
  for (const { value } of entries(payload)) {
    if (!Array.isArray(value.session)) continue;
    for (const candidate of value.session) {
      if (!candidate || typeof candidate !== 'object' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(candidate.name ?? '') || typeof candidate.value !== 'string') continue;
      if (/[\r\n;\x00]/.test(candidate.value)) fail('INVALID_AUTH_COOKIE', 'Expedia returned an invalid session cookie.');
      const domain = typeof candidate.domain === 'string' ? candidate.domain.toLowerCase().replace(/^\./, '') : 'www.expedia.com';
      if (domain !== 'expedia.com' && !domain.endsWith('.expedia.com')) fail('UNEXPECTED_AUTH_COOKIE_DOMAIN', 'Expedia returned a session cookie for another service.');
      const path = typeof candidate.path === 'string' && candidate.path.startsWith('/') ? candidate.path : '/';
      if (/[\r\n\x00;]/.test(path)) fail('INVALID_AUTH_COOKIE', 'Expedia returned an invalid session cookie path.');
      const cookie = { name: candidate.name, value: candidate.value, domain, path };
      for (const property of ['expires', 'httpOnly', 'maxAge', 'secure']) {
        if (['string', 'number', 'boolean'].includes(typeof candidate[property]) && (typeof candidate[property] !== 'number' || Number.isFinite(candidate[property]))) cookie[property] = candidate[property];
      }
      cookies.set(`${domain}\n${path}\n${cookie.name}`, cookie);
    }
  }
  return [...cookies.values()];
}

function maskTarget(value) {
  if (typeof value !== 'string') return null;
  const email = value.match(/[A-Za-z0-9.*_+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0];
  if (email) {
    const [local, domain] = email.split('@');
    return local.includes('*') ? email : `${local.slice(0, 1)}***@${domain}`;
  }
  const phone = value.match(/(?:\+?[\d*][\d* ().-]{5,}[\d*])/ )?.[0];
  if (phone) {
    const normalized = phone.replace(/[^\d*]/g, '');
    return normalized.includes('*') ? normalized : `***${normalized.slice(-4)}`;
  }
  return null;
}

function codeLength(field) {
  const lengths = (field.validations ?? []).filter(v => v?.__typename === 'EGDSMaxLengthInputValidation' && Number.isInteger(v.maxLength)).map(v => v.maxLength);
  if (lengths.length) {
    const length = Math.min(...lengths);
    return length >= 1 && length <= 10 ? length : null;
  }
  if (/^9{4,10}$/.test(String(field.max ?? ''))) return String(field.max).length;
  return null;
}

export function selectAuthAction(parsed, options = {}) {
  const actions = parsed?.actions ?? [];
  if (options.actionId) return actions.find(candidate => candidate.id === options.actionId) ?? null;
  const primary = actions.filter(candidate => candidate.primary);
  return primary.length === 1 ? primary[0] : actions.length === 1 ? actions[0] : null;
}

export function parseAuthResponse(payload, options = {}) {
  const rows = entries(payload), fields = [], actions = [], fieldChallenges = [], errors = [];
  const seenFields = new Set(), seenActions = new Set();
  let profile = null, successType = null, flowContext = null, authStepIdentifier = null, redirectionContext = null;
  const responseTypes = new Set();
  for (const { value, owner, path } of rows) {
    const type = value.__typename;
    if (typeof type === 'string' && /^Identity.*Response$/.test(type)) responseTypes.add(type);
    if (value.flowContext && typeof value.flowContext === 'object' && !Array.isArray(value.flowContext)) flowContext = structuredClone(value.flowContext);
    if (typeof value.authStepIdentifier === 'string') authStepIdentifier = value.authStepIdentifier;
    if (typeof value.redirectionContext === 'string') redirectionContext = value.redirectionContext;
    if (FIELD_TYPES.has(type) && typeof value.egdsElementId === 'string' && !seenFields.has(value.egdsElementId)) {
      seenFields.add(value.egdsElementId);
      const label = plainText(value.stringLabel ?? value.stringLabelNullable ?? value.egdsTextLabel ?? value.label) ?? '';
      const instructions = plainText(value.instructions) ?? '';
      const kind = FIELD_TYPES.get(type), isCode = ['number', 'text'].includes(kind) && /(?:verification|security|one[ -]?time|passcode|\bcode\b)/i.test(`${label} ${instructions} ${value.placeholder ?? ''}`);
      const field = {
        id: value.egdsElementId, kind: isCode ? 'code' : kind, label, instructions,
        required: (value.validations ?? []).some(v => v?.__typename === 'EGDSRequiredInputValidation') || value.required === true,
        readOnly: value.readOnly === true, value: value.value ?? (kind === 'checkbox' ? value.state : null),
        codeLength: isCode ? codeLength(value) : null,
      };
      fields.push(field);
      if (isCode) fieldChallenges.push({ kind: 'verification_code', fieldId: field.id, length: field.codeLength, maskedTarget: maskTarget(instructions) ?? maskTarget(label), channel: /\b(?:sms|text message|phone)\b/i.test(instructions) ? 'sms' : /\bemail\b/i.test(instructions) ? 'email' : null });
    }
    if (type === 'IdentitySubmitAction') {
      const id = owner?.egdsElementId ?? `action:${path}`;
      const key = `${id}\n${value.context}`;
      if (!seenActions.has(key)) {
        seenActions.add(key);
        actions.push({
          id, label: plainText(owner?.element?.primary) ?? '',
          primary: owner?.element?.__typename === 'UIPrimaryButton',
          context: string(value.context), inputIds: Array.isArray(value.inputIds) ? value.inputIds.filter(v => typeof v === 'string') : [],
          requestInputPairList: Array.isArray(value.requestInputPairList) ? value.requestInputPairList.filter(v => typeof v?.key === 'string' && typeof v?.value === 'string').map(v => ({ key: v.key, value: v.value })) : [],
          atoActions: Array.isArray(value.atoActions) ? structuredClone(value.atoActions) : [],
          migrationContext: string(value.migrationContext), retrieveAtoLayout: string(value.retrieveAtoLayout),
        });
      }
    }
    if (value.profile && typeof value.profile === 'object' && !Array.isArray(value.profile)) {
      const p = value.profile;
      if ((p.tuid != null && String(p.tuid) !== '-1' && String(p.tuid) !== '') || (typeof p.expUserId === 'string' && p.expUserId)) profile = structuredClone(p);
    }
    if (typeof value.identitySuccessType === 'string') successType = value.identitySuccessType;
    if (Array.isArray(value.errorFields)) for (const error of value.errorFields) if (typeof error?.errorText === 'string') errors.push({ fieldId: string(error.elementId), message: error.errorText });
    if (Array.isArray(value.errors)) for (const error of value.errors) if (typeof error?.message === 'string') errors.push({ fieldId: null, message: error.message });
  }
  const cookies = extractSessionCookies(options.cookies ? { payload, received: { session: options.cookies } } : payload);
  const hasSession = cookies.some(c => c.name === 'EG_SESSIONTOKEN' && c.value && (c.maxAge === undefined || Number(c.maxAge) > 0));
  const selectedAction = selectAuthAction({ actions }, options);
  // The same layout ships password autofill and social-login actions. Their ATO
  // requirements are independent of the primary email Continue action.
  const challenges = fieldChallenges.filter(challenge => selectedAction?.inputIds.includes(challenge.fieldId));
  for (const ato of selectedAction?.atoActions ?? []) {
    challenges.push({
      kind: ato.__typename === 'IdentityCsrfWidgetAction' ? 'csrf' : 'user_action_required',
      type: ato.__typename ?? 'UnknownIdentityWidgetAction', actionId: selectedAction.id,
      inputKeys: Array.isArray(ato.inputKeys) ? ato.inputKeys.filter(key => typeof key === 'string') : [],
      ...(typeof ato.publicKey === 'string' ? { publicKey: ato.publicKey } : {}),
    });
  }
  const unknownChallenges = challenges.some(c => c.kind === 'user_action_required');
  const usableAction = selectedAction?.context && selectedAction.inputIds.length && selectedAction.inputIds.every(id => fields.some(f => f.id === id) || selectedAction.requestInputPairList.some(p => p.key === id));
  const nextStep = flowContext?.flowIdentifier === 'EMAIL_OTP' && typeof flowContext.email === 'string' ? { kind: 'query', operationName: 'identityAuthenticateByOTPForm' } : null;
  let status = profile && hasSession ? 'authenticated' : errors.length ? 'error' : unknownChallenges ? 'user_action_required' : usableAction ? 'input_required' : nextStep ? 'migration_required' : 'user_action_required';
  return { status, userActionRequired: status === 'user_action_required', selectedActionId: selectedAction?.id ?? null, fields, actions, challenges, cookies, profile, successType, flowContext, authStepIdentifier, redirectionContext, nextStep, responseTypes: [...responseTypes], errors };
}

export function buildOTPFormVariables(context, { flowContext, pageLocation = 'USER' } = {}) {
  if (flowContext?.flowIdentifier !== 'EMAIL_OTP' || typeof flowContext.email !== 'string') fail('AUTH_MIGRATION_REQUIRED', 'Expedia has not supplied an email verification flow.');
  const initial = buildInitialAuthVariables(context, { pageLocation });
  return { context: initial.context, identityClientContext: { clientIdentifier: 'ANDROID_APP', pageLocation }, request: { emailInput: flowContext.email, verifyOTPFormContext: null } };
}

function otpActionRequirements(action) {
  return (action.accountTakeOverWidgets ?? []).map(ato => ({
    kind: ato.__typename === 'IdentityCsrfWidgetAction' ? 'csrf' : 'user_action_required', type: ato.__typename,
    inputKeys: Array.isArray(ato.inputKeys) ? ato.inputKeys.filter(value => typeof value === 'string') : [],
    ...(typeof ato.publicKey === 'string' ? { publicKey: ato.publicKey } : {}),
  }));
}

export function parseOTPFormResponse(payload, options = {}) {
  const base = parseAuthResponse(payload, options), rows = entries(payload);
  const form = rows.find(({ value }) => value.__typename === 'IdentityAuthenticateByOTPFormResponse')?.value;
  if (!form) return { ...base, protocol: 'native_otp' };
  const field = form.oneTimePasscodeField;
  const regex = field?.validations?.find(value => value?.__typename === 'IdentityRegexValidationRule')?.regex;
  const length = typeof regex === 'string' ? /^\^\[0-9\]\{([1-9]|10)\}\$$/.exec(regex)?.[1] : null;
  const actions = [];
  for (const id of ['continueButton', 'resendCodeButton', 'sendCodeToMobileButton', 'sendCodeToEmailButton', 'usePasswordButton', 'useAlternativeOTPButton']) {
    const button = form[id];
    if (button?.action) actions.push({ id, primary: id === 'continueButton', label: plainText(button.button?.primary) ?? '', actionType: button.action.__typename, nativeAction: structuredClone(button.action), atoActions: structuredClone(button.action.accountTakeOverWidgets ?? []), inputIds: id === 'continueButton' ? ['oneTimePasscode'] : [] });
  }
  const selected = selectAuthAction({ actions }, options), challenges = selected ? otpActionRequirements(selected.nativeAction) : [];
  const fields = field?.input?.__typename === 'EGDSNumberInputField' ? [{ id: 'oneTimePasscode', kind: 'code', label: plainText(field.input.label) ?? '', required: field.input.required === true, readOnly: false, value: field.input.value, codeLength: length ? Number(length) : null }] : [];
  if (fields.length) challenges.unshift({ kind: 'verification_code', fieldId: 'oneTimePasscode', length: fields[0].codeLength, maskedTarget: maskTarget(form.description), channel: /\bemail\b/i.test(`${form.heading} ${form.description}`) ? 'email' : null });
  const blocked = challenges.some(value => value.kind === 'user_action_required');
  return { ...base, protocol: 'native_otp', status: base.errors.length ? 'error' : selected && !blocked ? 'input_required' : 'user_action_required', userActionRequired: blocked || !selected, heading: string(form.heading), selectedActionId: selected?.id ?? null, fields, actions, challenges, resendAfterSeconds: Number.isFinite(form.resendCodeButton?.maxTimerInSeconds) ? form.resendCodeButton.maxTimerInSeconds : null };
}

function nativeATOInputs(action, provided = []) {
  if (!Array.isArray(provided)) fail('INVALID_AUTH_CHALLENGE', 'Challenge inputs must be a list.');
  const challengeInputs = [];
  for (const ato of action.accountTakeOverWidgets ?? []) {
    if (ato.__typename === 'IdentityCsrfWidgetAction' && typeof ato.token === 'string' && Array.isArray(ato.inputKeys)) {
      challengeInputs.push({ type: 'CSRF', inputs: ato.inputKeys.map(key => ({ key, value: ato.token })) });
      continue;
    }
    const supplied = provided.find(value => value.type === ato.type);
    if (!supplied || !Array.isArray(supplied.inputs) || !(ato.inputKeys ?? []).every(key => supplied.inputs.some(pair => pair.key === key && typeof pair.value === 'string' && pair.value.length))) fail('AUTH_CHALLENGE_REQUIRED', 'Complete Expedia’s verification challenge before continuing.', { challengeType: ato.__typename });
    challengeInputs.push(structuredClone(supplied));
  }
  for (const input of challengeInputs) if (typeof input?.type !== 'string' || !Array.isArray(input.inputs) || input.inputs.some(pair => typeof pair?.key !== 'string' || typeof pair?.value !== 'string')) fail('INVALID_AUTH_CHALLENGE', 'Malformed Expedia challenge input.');
  return challengeInputs;
}

export function buildOTPActionOperation(context, parsed, options = {}) {
  const selected = selectAuthAction(parsed, options), action = selected?.nativeAction;
  if (!action) fail('AUTH_ACTION_REQUIRED', 'Choose the current Expedia verification action.');
  const initial = buildInitialAuthVariables(context, options), flowContext = options.flowContext ?? parsed.flowContext;
  const identityClientContext = { clientIdentifier: 'ANDROID_APP', pageLocation: options.pageLocation ?? 'USER' };
  const request = { atoInputs: nativeATOInputs(action, options.challengeInputs) };
  let operationName;
  if (action.__typename === 'IdentityVerifyEmailOTPAction') {
    operationName = 'identityVerifyOTPAuthenticationSubmit';
    const length = parsed.fields.find(field => field.id === 'oneTimePasscode')?.codeLength;
    if (typeof options.code !== 'string' || !/^\d{4,10}$/.test(options.code) || (length && options.code.length !== length)) fail('INVALID_VERIFICATION_CODE', 'Enter the verification code exactly as received.');
    if (typeof flowContext?.email !== 'string') fail('AUTH_MIGRATION_REQUIRED', 'The returned email verification context is missing.');
    request.emailInput = flowContext.email; request.oneTimePasscode = options.code;
    if (typeof flowContext.flowScenario === 'string') request.flowScenario = flowContext.flowScenario;
    if (typeof action.verifyEmailOTPContext === 'string' && action.verifyEmailOTPContext) request.verifyOTPContext = action.verifyEmailOTPContext;
    // ConfirmEmailVM.Y5 omits the variant even when the server action supplies it.
    if (typeof flowContext.referenceId === 'string' && flowContext.referenceId) request.referenceId = flowContext.referenceId;
  } else if (action.__typename === 'IdentitySendEmailOTPAction') {
    operationName = 'identitySendOTPSubmitMutation';
    request.sendOTPContext = action.sendEmailOTPContext ?? null;
  } else if (action.__typename === 'IdentityResendEmailOTPAction') {
    operationName = 'identityResendOTPAuthenticateSubmit';
    if (typeof flowContext?.email === 'string') request.emailInput = flowContext.email;
    request.resendOTPContext = action.resendEmailOTPContext ?? null;
  } else fail('UNSUPPORTED_OTP_ACTION', 'This Expedia verification action has not been implemented.', { actionType: action.__typename });
  return { operationName, variables: { context: initial.context, identityClientContext, request } };
}

export function buildAuthSubmitVariables(context, parsed, options = {}) {
  const action = selectAuthAction(parsed, options);
  if (!action?.context) fail('AUTH_ACTION_REQUIRED', 'Choose a recognized Expedia login action before submitting.');
  const values = options.values ?? {};
  if (typeof values !== 'object' || values === null || Array.isArray(values)) fail('INVALID_AUTH_INPUT', 'Login values must be keyed by the returned field IDs.');
  const input = new Map(action.requestInputPairList.map(pair => [pair.key, pair.value]));
  for (const key of Object.keys(values)) if (!action.inputIds.includes(key)) fail('UNEXPECTED_AUTH_INPUT', 'This field is not accepted by the selected login action.', { fieldId: key });
  for (const id of action.inputIds) {
    const field = parsed.fields.find(candidate => candidate.id === id);
    if (!field && !input.has(id)) fail('UNSUPPORTED_AUTH_FIELD', 'Expedia returned an unrecognized login field.', { fieldId: id });
    const supplied = Object.hasOwn(values, id);
    if (field?.readOnly && supplied && String(values[id]) !== String(field.value)) fail('READ_ONLY_AUTH_INPUT', 'A server-controlled login field cannot be changed.', { fieldId: id });
    const value = supplied ? values[id] : input.get(id) ?? field?.value;
    if (value == null || (value === '' && field?.required)) fail('AUTH_INPUT_REQUIRED', 'Complete the requested Expedia login field.', { fieldId: id });
    if (!['string', 'boolean', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) fail('INVALID_AUTH_INPUT', 'Login field values must be text, numbers, or booleans.', { fieldId: id });
    const text = String(value);
    if (field?.kind === 'code' && field.codeLength && !new RegExp(`^\\d{${field.codeLength}}$`).test(text)) fail('INVALID_VERIFICATION_CODE', `Enter the ${field.codeLength}-digit verification code.`, { fieldId: id });
    input.set(id, text);
  }
  const challengeInputs = structuredClone(options.challengeInputs ?? []);
  if (!Array.isArray(challengeInputs)) fail('INVALID_AUTH_CHALLENGE', 'Challenge inputs must be a list.');
  for (const ato of action.atoActions) {
    if (ato.__typename === 'IdentityCsrfWidgetAction') {
      if (!Array.isArray(ato.inputKeys) || typeof ato.token !== 'string' || !ato.inputKeys.length) fail('AUTH_CHALLENGE_REQUIRED', 'The login form has an incomplete CSRF challenge.');
      challengeInputs.push({ type: 'CSRF', inputs: ato.inputKeys.map(key => ({ key, value: ato.token })) });
    } else {
      const supplied = challengeInputs.find(value => value.type === ato.type);
      if (!supplied || !Array.isArray(supplied.inputs) || !(ato.inputKeys ?? []).every(key => supplied.inputs.some(pair => pair.key === key && typeof pair.value === 'string' && pair.value.length))) fail('AUTH_CHALLENGE_REQUIRED', 'Complete Expedia’s verification challenge before continuing.', { challengeType: ato.__typename });
    }
  }
  const validatedChallenges = challengeInputs.map(value => {
    if (!value || typeof value.type !== 'string' || !Array.isArray(value.inputs) || value.inputs.some(pair => typeof pair?.key !== 'string' || typeof pair?.value !== 'string')) fail('INVALID_AUTH_CHALLENGE', 'Malformed Expedia challenge input.');
    return { type: value.type, inputs: value.inputs.map(pair => ({ key: pair.key, value: pair.value })) };
  });
  const initial = buildInitialAuthVariables(context, options);
  return {
    context: initial.context, clientInfo: initial.clientInfo,
    submitRequest: {
      atoInputs: validatedChallenges, context: action.context, input: [...input].map(([key, value]) => ({ key, value })),
      ...(action.migrationContext !== null ? { migrationContextInput: action.migrationContext } : {}),
    },
  };
}
