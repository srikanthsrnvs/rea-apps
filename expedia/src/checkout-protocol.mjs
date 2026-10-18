import { ExpediaError } from './errors.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw new ExpediaError(code, message); };
const text = value => typeof value === 'string' ? value : null;

export function validateFlightCheckoutUrl(value, { preparation = false } = {}) {
  let url;
  try { url = new URL(value, 'https://www.expedia.com'); }
  catch { fail('INVALID_CHECKOUT_URL', 'The flight has no valid checkout address.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'www.expedia.com' || url.port || url.username || url.password || url.hash) fail('INVALID_CHECKOUT_URL', 'The checkout address must use the official Expedia HTTPS host.');
  if (preparation) {
    if (url.pathname !== '/checkout-redirect' || url.searchParams.get('action') !== 'UnifiedDetailsWidget@statelessBook' || !url.searchParams.get('offerToken')) fail('INVALID_CHECKOUT_URL', 'Only the selected flight preparation action is accepted.');
  } else if (!UUID.test(url.pathname.match(/^\/checkout\/session\/([^/]+)\/?$/)?.[1] ?? '') || url.searchParams.get('productLine') !== 'FLIGHT') fail('INVALID_CHECKOUT_URL', 'The response is not a flight checkout session.');
  return url.href;
}

export function extractFlightCheckoutUrl(response) {
  const summary = response?.data?.flightsDetail?.priceSummary;
  const primary = summary?.buttonAction?.relativeURI?.value;
  const dialog = summary?.stackedFooter?.dialog?.dialog?.footer?.buttons?.find(button => button.clientAction?.resource?.value)?.clientAction?.resource?.value;
  const value = primary ?? dialog;
  if (!value) fail('CHECKOUT_UNAVAILABLE', 'Expedia did not return a flight checkout action.');
  return validateFlightCheckoutUrl(value, { preparation: true });
}

// Parse the serialized Apollo cache as JSON. Never evaluate remote JavaScript.
export function parseCheckoutApolloState(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 12 * 1024 * 1024) fail('INVALID_CHECKOUT_RESPONSE', 'The checkout document is missing or too large.');
  const match = html.match(/window\.__APOLLO_STATE__\s*=\s*JSON\.parse\(\s*("(?:\\.|[^"\\])*")\s*\)/);
  if (!match) fail('CHECKOUT_BOOTSTRAP_MISSING', 'Expedia did not return checkout session data.');
  let state;
  try { state = JSON.parse(JSON.parse(match[1])); }
  catch { fail('INVALID_CHECKOUT_RESPONSE', 'The checkout session data is invalid.'); }
  if (!object(state) || !object(state.ROOT_QUERY)) fail('INVALID_CHECKOUT_RESPONSE', 'The checkout session data has no query root.');
  delete state.__REA_CHECKOUT_PAGE__;
  const metadata = checkoutPageMetadata(html);
  if (metadata) state.__REA_CHECKOUT_PAGE__ = metadata;
  return state;
}

function checkoutPageMetadata(html) {
  const match = html.match(/window\.__PLUGIN_STATE__\s*=\s*JSON\.parse\(\s*("(?:\\.|[^"\\])*")\s*\)/);
  if (!match) return null;
  let plugins;
  try { plugins = JSON.parse(JSON.parse(match[1])); }
  catch { fail('INVALID_CHECKOUT_RESPONSE', 'The checkout experiment data is invalid.'); }
  const exposures = plugins?.['experiment-store']?.experimentStore?.exposures ?? {};
  const bucket = name => Number.isInteger(exposures[name]?.bucket) ? exposures[name].bucket : null;
  const trustBucket = bucket('HYBRID_CHECKOUT_PASS_EMPTY_TRUST_PAYLOAD');
  const migration = bucket('MCKO_MIGRATION_ONECPM_TNL_EXPOSURE'), flight = bucket('MCKO_ONECPM_FLIGHT_LOB'), rest = bucket('MCKO_ONECPM_REST_LOB');
  const oneCpm = migration === 1 ? (flight === null ? null : flight === 1) : migration === 0 ? (flight === 1 || rest === 1 ? true : flight !== null && rest !== null ? false : null) : null;
  return {
    deviceId: plugins?.context?.context?.deviceId ?? null,
    trustRequirement: { source: 'checkout_ssr_experiment', experiment: 'HYBRID_CHECKOUT_PASS_EMPTY_TRUST_PAYLOAD', bucket: trustBucket,
      mode: trustBucket === 1 ? 'empty_payload_supported' : trustBucket === null ? 'unknown' : 'payload_required', allowsEmpty: trustBucket === 1 },
    // The newer component still supplies modern-checkout's QE service adapter.
    // QE maps to paymentModule/UpdatePaymentMethod, not generic OneCPM APIs.
    paymentFlow: 'LEGACY_CPM',
    paymentComponent: oneCpm === null ? 'UNKNOWN' : oneCpm ? 'ONE_CPM' : 'LEGACY_CPM',
    paymentFlowSource: 'checkout_modern_checkout_service_adapter',
    paymentClientDetails: { clientId: 'MCKO', clientName: 'MODERN CHECKOUT' },
    bookClientId: bucket('MCKO_CLIENT_ID_ONE_CPM') === 1 ? (bucket('MCKO_MIGRATION_ONECPM') === 1 ? 'MCKO' : 'LEGACY_CPM') : null,
    experimentBuckets: { migration, flight, rest },
  };
}

function cacheField(root, field) {
  return Object.entries(root ?? {}).filter(([key]) => key === field || key.startsWith(`${field}(`)).map(([key, value]) => {
    let args = {};
    try { if (key.startsWith(`${field}(`)) args = JSON.parse(key.slice(field.length + 1, -1)); }
    catch { fail('INVALID_CHECKOUT_RESPONSE', 'A checkout query has invalid arguments.'); }
    return { args, value };
  });
}

export function resolveCheckoutReferences(state, input) {
  let count = 0;
  function resolve(value, ancestors = new Set(), depth = 0) {
    if (++count > 100000 || depth > 80) fail('INVALID_CHECKOUT_RESPONSE', 'The checkout data exceeds supported limits.');
    if (Array.isArray(value)) return value.map(item => resolve(item, ancestors, depth + 1));
    if (!object(value)) return value;
    if (typeof value.__ref === 'string') {
      if (ancestors.has(value.__ref) || !Object.hasOwn(state, value.__ref)) fail('INVALID_CHECKOUT_RESPONSE', 'The checkout data contains an invalid reference.');
      return resolve(state[value.__ref], new Set([...ancestors, value.__ref]), depth + 1);
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child, ancestors, depth + 1)]));
  }
  return resolve(input);
}

export function checkoutFromApolloState(state, checkoutUrl) {
  const url = new URL(validateFlightCheckoutUrl(checkoutUrl));
  const sessionId = url.pathname.split('/')[3];
  const checkoutFields = cacheField(state.ROOT_QUERY, 'checkout');
  const selected = checkoutFields.find(({ value }) => cacheField(value, 'getSession').some(({ args }) => args.sessionID === sessionId));
  if (!selected) fail('CHECKOUT_SESSION_MISMATCH', 'The returned checkout data does not match this session.');
  const session = cacheField(selected.value, 'getSession').find(({ args }) => args.sessionID === sessionId)?.value;
  if (session?.productLine !== 'FLIGHT') fail('UNSUPPORTED_CHECKOUT_PRODUCT', 'This checkout is not for a flight.');
  if (!text(session.token)) fail('CHECKOUT_TOKEN_MISSING', 'Expedia did not return a checkout session token.');
  const read = field => cacheField(state.ROOT_QUERY, field).map(({ args, value }) => ({ args, value: resolveCheckoutReferences(state, value) }));
  const payment = read('paymentModule').find(({ args }) => args.sessionId === sessionId)?.value ?? null;
  const forms = read('smartForm').filter(({ args }) => args.sessionId === sessionId).map(({ args, value }) => ({ type: args.type ?? null, view: value?.view ?? null }));
  const prices = read('priceDetails').map(({ value }) => value).filter(value => value?.pricePresentation);
  const metadata = state.__REA_CHECKOUT_PAGE__;
  const matchedMetadata = metadata?.deviceId && metadata.deviceId === selected.args.context?.identity?.duaid ? metadata : null;
  return {
    sessionId, sessionToken: session.token, checkoutSessionMode: session.checkoutSessionMode ?? null,
    context: selected.args.context, checkoutUrl: url.href, tripId: url.searchParams.get('tripId'),
    productLine: session.productLine, signals: session.signals ?? [], serverSignals: session.serverSignals ?? [],
    payment, forms, prices,
    product: read('productSummary')[0]?.value ?? null,
    importantInfo: read('importantInfo')[0]?.value ?? null,
    legal: read('legal').map(({ value }) => value),
    bookButton: resolveCheckoutReferences(state, cacheField(selected.value, 'checkoutBookButton')[0]?.value ?? null),
    trustRequirement: matchedMetadata?.trustRequirement ?? { source: 'unknown', mode: 'unknown', allowsEmpty: false },
    paymentFlow: matchedMetadata?.paymentFlow ?? 'UNKNOWN',
    paymentComponent: matchedMetadata?.paymentComponent ?? 'UNKNOWN',
    paymentFlowSource: matchedMetadata?.paymentFlowSource ?? 'unknown',
    paymentClientDetails: matchedMetadata?.paymentClientDetails ?? null,
    bookClientId: matchedMetadata?.bookClientId ?? null,
  };
}

function collectDisplayText(value, output = [], seen = new Set()) {
  if (Array.isArray(value)) for (const child of value) collectDisplayText(child, output, seen);
  else if (object(value)) for (const [key, child] of Object.entries(value)) {
    if (['text', 'primary', 'label', 'description', 'heading'].includes(key) && typeof child === 'string' && child.trim() && !seen.has(child)) { seen.add(child); output.push(child); }
    else if (!['analytics', 'egcsAnalytics', 'trackingData', 'tnlFields', 'action', 'clientAction'].includes(key)) collectDisplayText(child, output, seen);
  }
  return output;
}

export function checkoutPreview(checkout) {
  const price = checkout.prices?.find(value => typeof value.trackingData?.totalPriceAmount === 'number');
  const total = price?.trackingData;
  return {
    sessionId: checkout.sessionId, tripId: checkout.tripId, productLine: checkout.productLine,
    price: total ? { amount: total.totalPriceAmount, currency: total.totalPriceCurrencyCode, presentation: collectDisplayText(price.pricePresentation) } : null,
    itinerary: collectDisplayText(checkout.product),
    conditions: collectDisplayText([checkout.importantInfo, checkout.legal]),
    formTypes: checkout.forms?.map(form => form.type) ?? [],
    payment: {
      hasStoredCards: checkout.payment?.metaData?.paymentParameters?.hasStoredCards ?? null,
      payType: checkout.payment?.metaData?.paymentParameters?.paymentPayType ?? null,
      options: checkoutPaymentOptions(checkout),
    },
    bookButton: checkout.bookButton?.defaultButton?.content?.primary ?? null,
    trustRequirement: checkout.trustRequirement ?? { mode: 'unknown', allowsEmpty: false },
    paymentFlow: checkout.paymentFlow ?? 'UNKNOWN',
    paymentComponent: checkout.paymentComponent ?? 'UNKNOWN',
    readyToBook: false,
  };
}

export function checkoutFormFields(checkout, { type, billingCountry } = {}) {
  const forms = (checkout.forms ?? []).filter(form => !type || form.type === type);
  return forms.map(form => {
    const fields = new Map();
    function visit(value) {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!object(value) || value.hidden === true || value.disabled === true) return;
      if (value.__typename === 'SmartFormBillingAddressComponent') {
        visit(value.country); visit(value.addressLine1); visit(value.addressLine2);
        const country = billingCountry ?? value.country?.options?.find(option => option.selected)?.value;
        const templateId = value.countryToTemplateMapping?.find(mapping => mapping.countryCode === country)?.templateId;
        const config = value.fieldConfigTemplates?.find(template => template.templateId === templateId)?.config;
        if (config) {
          visit(config.city); visit(config.zipPostalCode);
          if (config.stateProvince) visit({ ...config.stateProvince, options: value.stateProvinceOptionsByCountry?.find(item => item.countryCode === country)?.options });
        }
        return;
      }
      const kind = value.__typename ?? '';
      if (text(value.inputId) && (kind.endsWith('InputComponent') || ['BillingFieldSpec', 'BillingStateFieldSpec'].includes(kind))) {
        const group = value.smartFormRadioGroup ?? value.smartFormCheckBoxGroup;
        const options = (value.options ?? value.radios ?? group?.options ?? []).filter(object).map(option => {
          const item = option.radioButton ?? option.checkbox ?? option;
          return { label: typeof item.label === 'string' ? item.label : item.label?.text ?? item.text ?? null, value: item.value,
            selected: item.selected === true || item.state === 'CHECKED' || (group?.selected !== null && group?.selected !== undefined && group.selected === item.value) };
        });
        fields.set(value.inputId, {
          inputId: value.inputId, key: value.inputId.split('||')[0], label: text(value.label), kind,
          required: value.required === true || group?.required === true || (value.validations ?? []).some(validation => /Required/i.test(validation.__typename ?? '')),
          value: value.value ?? (options.some(option => option.selected) ? options.filter(option => option.selected).map(option => option.value) : null),
          ...(options.length ? { options } : {}),
        });
        // Composite date values submit once as YYYY-MM-DD, not internal day/month controls.
        if (kind === 'SmartFormDateInputComponent') return;
      }
      for (const [key, child] of Object.entries(value)) if (!['options', 'radios', 'prefillDataList', 'fieldConfigTemplates', 'stateProvinceOptionsByCountry', 'analytics', 'analyticsData'].includes(key)) visit(child);
    }
    visit(form.view);
    return { type: form.type, fields: [...fields.values()] };
  });
}

export function checkoutInputTemplate(checkout, options = {}) {
  return {
    sessionId: checkout.sessionId,
    forms: checkoutFormFields(checkout, options).map(form => ({ ...form, userFieldInputs: form.fields.map(field => ({ inputId: field.inputId, value: field.value })) })),
  };
}

export function validateCheckoutInput(checkout, input, options = {}) {
  if (input?.sessionId !== checkout.sessionId || !Array.isArray(input.forms)) fail('CHECKOUT_SESSION_MISMATCH', 'The form file must belong to this checkout session.');
  const schema = checkoutFormFields(checkout, options), result = [], used = new Set();
  for (const form of input.forms) {
    const expected = schema.find(item => item.type === form.type);
    if (!expected || used.has(form.type) || !Array.isArray(form.userFieldInputs)) fail('INVALID_FORM_INPUT', 'The form file contains an unknown or duplicate form.');
    used.add(form.type);
    const ids = new Set(), values = new Map();
    for (const item of form.userFieldInputs) {
      const field = expected.fields.find(candidate => candidate.inputId === item?.inputId);
      if (!field || ids.has(item.inputId) || !Object.hasOwn(item, 'value')) fail('INVALID_FORM_INPUT', 'The form file contains an unknown or duplicate field.');
      ids.add(item.inputId);
      const value = item.value;
      const scalar = part => ['string', 'boolean'].includes(typeof part) || (typeof part === 'number' && Number.isFinite(part));
      if (!(value === null || scalar(value) || (Array.isArray(value) && value.every(scalar)))) fail('INVALID_FORM_INPUT', 'Form values must be text, finite numbers, booleans, or lists of those values.');
      if (value !== null && !(typeof value === 'string' && !value.trim()) && !(Array.isArray(value) && !value.length)) values.set(item.inputId, value);
    }
    const missing = expected.fields.filter(field => field.required && !values.has(field.inputId));
    if (missing.length) throw new ExpediaError('REQUIRED_FORM_FIELDS', 'The checkout form is incomplete.', { fields: missing.map(({ inputId, label }) => ({ inputId, label })) });
    result.push({ type: form.type, userFieldInputs: [...values].map(([inputId, value]) => ({ inputId, value })) });
  }
  if (schema.some(form => !used.has(form.type))) fail('REQUIRED_FORM_FIELDS', 'Include every form returned by this checkout.');
  return result;
}

export function checkoutPaymentOptions(checkout) {
  const found = new Map();
  function visit(value) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (object(value)) {
      if (value.__typename === 'PaymentInstrument' && text(value.fopId)) found.set(value.fopId, {
        id: value.fopId, label: text(value.fopText?.text), state: text(value.state),
        paymentMethod: text(value.paymentMethod), paymentMethodUrn: text(value.paymentMethodUrn),
        isStoredCard: value.isStoredCard === true, isExpired: value.isExpired === true,
        requiresCollector: value.isCollectorRequired === true,
      });
      Object.values(value).forEach(visit);
    }
  }
  visit(checkout.payment);
  return [...found.values()];
}

function sessionInfo(checkout) {
  if (!UUID.test(checkout?.sessionId ?? '') || !text(checkout?.sessionToken)) fail('INVALID_CHECKOUT_SESSION', 'A current checkout session and token are required.');
  return { sessionId: checkout.sessionId, sessionToken: checkout.sessionToken };
}

export function buildCheckoutSessionQuery(checkout, { isValidate = true } = {}) {
  const { sessionId } = sessionInfo(checkout);
  return { operationName: 'GetSessionInfo', variables: { context: checkout.context, sessionID: sessionId, isValidate } };
}

// Produces a request only. The command that submits it must enforce explicit
// purchase approval, validated forms/payment, price limits, and an operation journal.
export function buildFlightBookingMutation(checkout, { domainInfoList, clientId } = {}) {
  if (checkout?.productLine !== 'FLIGHT') fail('UNSUPPORTED_CHECKOUT_PRODUCT', 'Only flight checkout sessions are supported.');
  const checkoutSessionInfo = sessionInfo(checkout);
  if (domainInfoList !== undefined && (!Array.isArray(domainInfoList) || domainInfoList.some(value => !text(value?.name) || !text(value?.refId)))) fail('INVALID_BOOKING_INPUT', 'Checkout domain data must contain server-issued names and references.');
  if (!domainInfoList?.some(item => item.name === 'trustServicePayload' && item.refId) && checkout.trustRequirement?.allowsEmpty !== true) fail('CHECKOUT_TRUST_ACTION_REQUIRED', 'Expedia has not enabled an empty trust payload for this checkout. Complete its official verification before booking.');
  return { operationName: 'BookMutation', variables: {
    context: checkout.context, checkoutSessionInfo,
    ...(checkout.checkoutSessionMode ? { checkoutSessionMode: checkout.checkoutSessionMode } : {}),
    domainInfoList: domainInfoList ?? [], ...((clientId ?? checkout.bookClientId) ? { clientId: clientId ?? checkout.bookClientId } : {}),
  } };
}

export function buildSmartFormMutation(checkout, { type, userFieldInputs, timestamp = Date.now() } = {}) {
  sessionInfo(checkout);
  const form = checkout.forms?.find(form => form.type === type), ids = new Set();
  const visit = value => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (object(value)) { if (text(value.inputId)) ids.add(value.inputId); Object.values(value).forEach(visit); }
  };
  visit(form?.view);
  if (!form || !Array.isArray(userFieldInputs) || userFieldInputs.some(input => !ids.has(input?.inputId) || !Object.hasOwn(input, 'value'))) fail('INVALID_FORM_INPUT', 'Use field identifiers and a form type returned by this checkout.');
  if (!Number.isFinite(Number(timestamp))) fail('INVALID_FORM_INPUT', 'A valid form update timestamp is required.');
  return { operationName: 'SmartFormMutation', variables: {
    context: checkout.context, sessionId: checkout.sessionId, sessionToken: checkout.sessionToken, type,
    data: { timestamp: String(timestamp), userInput: { userFieldInputs: userFieldInputs.map(({ inputId, value }) => ({ inputId, value })) } },
  } };
}

export function normalizeFlightBookingResult(response) {
  const data = response?.data?.book?.data;
  if (!object(data)) fail('BOOKING_RESULT_UNCERTAIN', 'Expedia did not return a booking result. Reconcile this operation before attempting another purchase.');
  const signals = (data.signals ?? []).map(({ signal }) => signal).filter(Boolean);
  const failed = signals.some(signal => ['UNRECOVERABLE_FAILURE', 'GENERIC_DOWNSTREAM_ERROR', 'PAYMENT_ERROR', 'DUPLICATE_REQUEST'].includes(signal));
  const pending = signals.includes('PENDING_CONFIRMATION') || signals.includes('SUPPLIER_CONFIRMATION_PENDING');
  const success = signals.includes('BOOKING_SUCCESS') || signals.includes('BOOKING_ALREADY_BOOKED');
  return {
    status: failed ? 'requires_reconciliation' : pending ? 'pending' : success && data.orderId ? 'booked' : data.orderId ? 'order_created' : data.asyncResolution ? 'pending' : 'unresolved',
    orderId: text(data.orderId), orderNumber: text(data.orderNumber), itineraryNumber: text(data.itineraryNumber),
    ticketingStatus: 'unverified', signals,
    asyncResolution: data.asyncResolution ? {
      pollIntervalMs: data.asyncResolution.pollIntervalMs ?? null,
      pollBackoff: data.asyncResolution.pollBackoff ?? null,
      pollingTimeoutMs: data.asyncResolution.pollingTimeoutMs ?? null,
    } : null,
    message: text(data.feedbackMessage?.text),
  };
}

export function buildFlightBookingStatusQuery(checkout, { orderId, orderNumber } = {}) {
  sessionInfo(checkout);
  if (!text(orderId) || !text(orderNumber)) fail('INVALID_ORDER_ID', 'Both identifiers returned by the booking operation are required.');
  return { operationName: 'RedirectOrderStatusQuery', variables: {
    context: checkout.context, orderId,
    confirmationSummaryParams: { orderId, orderNumber, orderStatus: 'PENDING', sessionId: checkout.sessionId, domainUrl: new URL(validateFlightCheckoutUrl(checkout.checkoutUrl)).origin },
  } };
}

export function normalizeFlightBookingStatus(response) {
  const summary = response?.data?.confirmationSummary;
  if (!object(summary)) fail('BOOKING_STATUS_UNAVAILABLE', 'Expedia did not return order status. Do not resubmit this purchase.');
  return { status: summary.orderStatus === 'SUCCESS' ? 'booked' : summary.orderStatus === 'FAILED' ? 'failed' : summary.orderStatus === 'PENDING' ? 'pending' : 'unresolved', ticketingStatus: 'unverified' };
}

export function normalizeSmartFormResult(response) {
  const result = response?.data?.smartForm?.updateFormData;
  if (!object(result)) fail('FORM_UPDATE_UNCERTAIN', 'Expedia did not return form update results. Refresh the checkout before continuing.');
  return {
    success: result.success === true && !(result.validationErrors?.length),
    sessionToken: text(result.sessionToken),
    validationErrors: (result.validationErrors ?? []).map(error => ({ inputId: text(error.inputId), message: text(error.errorMessage) })),
    signals: result.signals ?? [], serverSignals: result.serverSignals ?? [],
  };
}

function paymentInstruments(checkout) {
  const found = new Map();
  function visit(value) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (object(value)) { if (value.__typename === 'PaymentInstrument' && text(value.fopId)) found.set(value.fopId, value); Object.values(value).forEach(visit); }
  }
  visit(checkout.payment);
  return found;
}

export function buildPaymentSelectionMutation(checkout, { paymentOptionId, clientId } = {}) {
  clientId ??= checkout.paymentClientDetails?.clientId;
  const checkoutIdentifier = sessionInfo(checkout), instruments = paymentInstruments(checkout), selected = instruments.get(paymentOptionId);
  if (!selected || selected.isExpired) fail('INVALID_PAYMENT_OPTION', 'Select an unexpired payment option returned by this checkout.');
  const previous = [...instruments.values()].find(option => option.state === 'STATE_SELECTED' && option.fopId !== selected.fopId);
  const item = (option, state) => ({ id: option.fopId, state, paymentMethod: option.paymentMethod,
    paymentMethodConfiguration: { storedCardInstrument: { id: option.storedCardConfig?.storedPaymentInstrumentId ?? '' }, subMethodUrn: option.paymentSubMethodUrn ?? '' },
  });
  return { operationName: 'SelectPaymentMethodMutation', variables: {
    context: checkout.context,
    selectPaymentMethodRequest: { checkoutIdentifier, ...(checkout.checkoutSessionMode ? { checkoutSessionMode: checkout.checkoutSessionMode } : {}),
      fopItems: [item(selected, 'STATE_SELECTED'), ...(previous ? [item(previous, 'STATE_UNSELECTED')] : [])] },
    ...(clientId !== undefined ? { clientId } : {}),
  } };
}

export function buildStoredCardTokenMutation(checkout, { paymentOptionId, paymentSessionId, billingAddress, cardExpirationMonth, cardExpirationYear, clientId } = {}) {
  clientId ??= checkout.paymentClientDetails?.clientId;
  sessionInfo(checkout);
  const selected = paymentInstruments(checkout).get(paymentOptionId), storedPaymentInstrumentId = selected?.storedCardConfig?.storedPaymentInstrumentId;
  if (!selected?.isStoredCard || !text(storedPaymentInstrumentId) || !text(paymentSessionId) || selected.isExpired) fail('INVALID_STORED_PAYMENT', 'A server-issued stored card and payment session are required.');
  return { operationName: 'CreatePaymentToken', variables: {
    context: checkout.context,
    paymentTokenRequest: { sessionId: paymentSessionId, storedPaymentInstrumentId,
      ...(billingAddress !== undefined ? { billingAddress } : {}), ...(cardExpirationMonth !== undefined ? { cardExpirationMonth } : {}), ...(cardExpirationYear !== undefined ? { cardExpirationYear } : {}) },
    ...(clientId !== undefined ? { clientId } : {}),
  } };
}

export function normalizePaymentSelection(response) {
  const result = response?.data?.selectPaymentMethod;
  if (!object(result)) fail('PAYMENT_SELECTION_UNCERTAIN', 'Expedia did not confirm payment selection. Refresh this checkout before continuing.');
  const actions = result.actions ?? [];
  const serverSignals = actions.flatMap(action => action.serverSignals ?? []);
  const failed = actions.some(action => action.__typename === 'PaymentMethodSwitchAction' && action.uiSignal === 'PAYMENT_METHOD_SELECT_FAILURE')
    || serverSignals.some(signal => /payment-error|abandon-booking|unrecoverable-failure/.test(signal.payload?.signalUrn ?? ''));
  return { state: failed ? 'blocked' : actions.length ? 'selected' : 'unresolved', checkoutIdentifier: result.checkoutIdentifier ?? null,
    paymentCheckoutElement: result.paymentCheckoutElement ?? null, actions, serverSignals };
}

function findTyped(value, typename) {
  if (Array.isArray(value)) {
    for (const child of value) { const found = findTyped(child, typename); if (found) return found; }
  } else if (object(value)) {
    if (value.__typename === typename) return value;
    for (const child of Object.values(value)) { const found = findTyped(child, typename); if (found) return found; }
  }
  return null;
}

export function buildNewCardTokenizationRequest(checkout, card, { paymentOptionId } = {}) {
  sessionInfo(checkout);
  const instrument = paymentInstruments(checkout).get(paymentOptionId);
  if (!instrument || instrument.paymentMethod !== 'CREDIT_CARD' || instrument.isStoredCard) fail('INVALID_PAYMENT_OPTION', 'Select the new card option returned by this checkout.');
  const collector = findTyped(checkout.payment, 'PaymentCardDetailsTokenizationField');
  let endpoint;
  try { endpoint = new URL(collector?.cardTokenizationServiceURI); } catch { /* fail below */ }
  if (!endpoint || endpoint.protocol !== 'https:' || endpoint.hostname !== 'api.expedia.com' || endpoint.port || endpoint.username || endpoint.password || endpoint.pathname !== '/v2/edge-tokens/instruments' || endpoint.search || endpoint.hash || !text(collector.accessTokenForCardTokenization)) fail('PAYMENT_TOKENIZATION_UNAVAILABLE', 'Expedia did not return its supported card tokenization endpoint.');
  const number = typeof card?.number === 'string' ? card.number.replace(/[ -]/g, '') : '';
  const cvv = typeof card?.cvv === 'string' ? card.cvv : '';
  const month = Number(card?.expirationMonth), year = Number(card?.expirationYear);
  let sum = 0, double = false;
  for (let i = number.length - 1; i >= 0; i--) { let digit = Number(number[i]); if (double && (digit *= 2) > 9) digit -= 9; sum += digit; double = !double; }
  if (!/^\d{12,19}$/.test(number) || sum % 10 || !/^\d{3,4}$/.test(cvv) || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2000 || year > 2199 || !text(card?.firstName)?.trim() || !text(card?.lastName)?.trim()) fail('INVALID_CARD_INPUT', 'Card number, security code, cardholder name, and expiration are required.');
  const address = card.billingAddress ?? {}, country = address.countryCode ?? checkout.payment?.metaData?.countryCode;
  if (!/^[A-Z]{3}$/.test(country ?? '')) fail('INVALID_CARD_INPUT', 'Use the billing country code returned by Expedia.');
  const details = {
    customer_first_name: card.firstName, customer_last_name: card.lastName,
    card_number: number, card_verification_value: cvv, card_expiration_month: String(month), card_expiration_year: String(year),
    customer_address_country_code: country, payment_instrument_type: instrument.paymentInstrumentType ?? 'BANK_ISSUED_CARD',
    ...(address.postalCode !== undefined ? { customer_address_postal_code: address.postalCode } : {}),
    ...(address.state !== undefined ? { customer_address_state_province_name: address.state } : {}),
    ...(address.addressLine1 !== undefined ? { customer_address_first_line: address.addressLine1 } : {}),
    ...(address.addressLine2 !== undefined ? { customer_address_second_line: address.addressLine2 } : {}),
    ...(address.city !== undefined ? { customer_address_city_name: address.city } : {}),
  };
  // Sensitive transient request: never serialize this object into a journal/output.
  return { url: endpoint.href, method: 'POST', headers: { authorization: `Bearer ${collector.accessTokenForCardTokenization}`, 'content-type': 'application/json', accept: 'application/json' }, body: details };
}

export function normalizeCardTokenizationResult(response) {
  if (!text(response?.id)) fail('PAYMENT_TOKENIZATION_FAILED', 'Expedia did not return a card token. No booking was submitted.');
  return { edgeToken: response.id };
}

// The checkout's modern-checkout service adapter maps even its new SDK
// component to legacy CPM. Generic OneCPM APIs use a different wire contract.
export function buildCardPaymentUpdateMutation(checkout, { paymentOptionId, edgeToken, encodedBrowserMetadata = '', billingCountry, bookingParameters, clientId } = {}) {
  clientId ??= checkout.paymentClientDetails?.clientId;
  const checkoutIdentifier = sessionInfo(checkout), instrument = paymentInstruments(checkout).get(paymentOptionId);
  if (!instrument || instrument.paymentMethod !== 'CREDIT_CARD' || !text(edgeToken)) fail('INVALID_PAYMENT_INPUT', 'A returned card option and scoped card token are required.');
  if (typeof encodedBrowserMetadata !== 'string') fail('INVALID_PAYMENT_INPUT', 'Payment metadata must come from the official payment flow.');
  return { operationName: 'UpdatePaymentMethodMutation', variables: {
    context: checkout.context,
    updatePaymentMethodRequest: { checkoutIdentifier,
      fopItems: [{ id: instrument.fopId, state: 'STATE_SELECTED', paymentMethod: 'CREDIT_CARD', paymentMethodConfiguration: {
        etzToken: edgeToken, providerConfirmationStatus: null, encodedBrowserMetadata,
        ...(billingCountry ? { billingAddress: { countryCode: billingCountry } } : {}),
        ...(instrument.isStoredCard && instrument.storedCardConfig?.storedPaymentInstrumentId ? { storedCardInstrument: { id: instrument.storedCardConfig.storedPaymentInstrumentId } } : {}),
      } }],
      ...(bookingParameters ? { bookingParameters } : {}),
    }, ...(clientId !== undefined ? { clientId } : {}),
  } };
}

export function normalizeCardPaymentUpdate(response) {
  const result = response?.data?.updatePaymentMethod;
  if (!object(result)) fail('PAYMENT_UPDATE_UNCERTAIN', 'Expedia did not return the card update result. Refresh payment state before continuing.');
  const card = result.updatedFops?.find(fop => fop.__typename === 'CreditCardPaymentFop');
  const attributes = card?.paymentMethodAttribute ?? {};
  const authenticationSpec = attributes.authenticationSpec ?? null;
  const resources = findTyped(result.updatedPaymentCheckoutElement, 'PaymentThreeDSResourceWeb');
  const challenge = resources?.challengeConfig ? resources : null;
  const actions = result.actions ?? [];
  const serverSignals = actions.flatMap(action => action.serverSignals ?? []);
  const blocked = actions.some(action => action.__typename === 'PaymentShowErrorMessageAction' && action.error)
    || serverSignals.some(signal => /payment-error|abandon-booking|unrecoverable-failure/.test(signal.payload?.signalUrn ?? ''));
  const challengeRequired = Boolean(challenge) || Boolean(authenticationSpec?.pasSessionId && authenticationSpec?.encodedInitConfig) || actions.some(action => /3DS|CHALLENGE|AUTHENTICATION/i.test(action.__typename ?? ''));
  return {
    state: blocked ? 'blocked' : challengeRequired ? 'requires_action' : card ? 'updated' : 'unresolved',
    checkoutIdentifier: result.checkoutIdentifier ?? null, card,
    authenticationSpec, challenge, actions, serverSignals,
  };
}
