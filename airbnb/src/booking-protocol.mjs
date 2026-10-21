// Pure request preparation. No network calls, retries, payment selection, or messages.
// Evidence: docs/booking-protocol.md; private/airbnb/evidence/account*-*.json.
export const BOOKING_OPERATIONS = Object.freeze({
  preview: ['CheckoutFlowQuery', '35ffb268179fd31d3689d0c5e87bb38ac2e50bc2797d5bd816c71ae792597cf0'],
  staysCheckout: ['stayCheckout', 'c7aec46319d9f29fdec4ba1a497aba15faadb7949680e7e60c8ef447b4ce78cf'],
  placeOrder: ['CheckoutFulfillmentMutation', 'fdd6516a5bb21d1b4a22febc2e847ef5f3fbcc5e0751c951b6be233dc748e31c'],
  cancellationPreview: ['UnifiedCancellation', '42271cd752a79f017157e51a50aae79ad53cd6ef73c4c03d48c8f3d5e630cde4'],
  confirmCancellation: ['ConfirmCancellationMutation', '2beddb12162c9801f283a7546658f9008016b1833e2002953d6d9a38f383ba11'],
  confirmation: ['CheckoutConfirmationQuery', '225ce1feaddeefe9615f576978c9ae27ea95472a14d2041cc4e431c70b771ea6'],
  billPolling: ['billPayinInfoForQuickPayPolling', '8f0e2556eb5877d14c92ed6f932d0e2bb5ef55897bccb4e0a378093e91cca849'],
  cancelledReservations: ['CancelledReservationsQuery', '1e08e6bdf413896856cb0a68d78a06e25455c9b26e6634696aa8a3d37bcb53f8'],
});

const STAY_FIELDS = new Set(('addOn attestations bookingAttemptId bookingQuoteId businessTravel checkinDate checkoutDate ' +
  'checkoutPaymentErrorToken china clientPaymentErrorContext confirmationCode couponCode expectedPlacementType guestAges ' +
  'guestCheckinTime guestCounts guestCurrencyOverride insuranceCode isWaitToPay listingDetail lux marsSessionToken metadata ' +
  'numberOfInstallments numberOfRooms orderId org partnerData previousPlacement productId quickPayData ratePlanId ' +
  'selectedCancellationPolicyId signupDetails specialOfferId splitStays thirdPartyBookingData tripType').split(' '));

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a nonempty string`);
  return value;
}
function number(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be an integer >= ${minimum}`);
  return value;
}
function positiveInt64(value, name) {
  if (typeof value === 'number') return number(value, name, 1);
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new TypeError(`${name} must be a positive signed-64-bit integer or decimal string`);
  }
  // Preserve decimal strings. The transport owns lossless GraphQL Long encoding.
  return value;
}
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}
function clone(value) {
  return JSON.parse(JSON.stringify(value, (_key, entry) => {
    if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint' ||
        (typeof entry === 'number' && !Number.isFinite(entry))) throw new TypeError('Request must contain only JSON values');
    return entry;
  }));
}
function date(value, name) {
  text(value, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new TypeError(`${name} must be a valid YYYY-MM-DD date`);
  return value;
}
function descriptor(key, variables, mutation = false) {
  const [operationName, hash] = BOOKING_OPERATIONS[key];
  return { operationName, hash, variables, ...(mutation ? { method: 'POST' } : {}) };
}
function add(target, source, keys) {
  for (const key of keys) if (source[key] !== undefined) target[key] = clone(source[key]);
}

export function stayProductId(listingId) {
  const id = typeof listingId === 'number' ? String(number(listingId, 'listingId', 1)) : text(listingId, 'listingId');
  if (!/^[1-9]\d*$/.test(id)) throw new TypeError('listingId must be a positive decimal ID');
  return Buffer.from(`StayListing:${id}`, 'utf8').toString('base64');
}

export function prepareStayInput(options = {}) {
  if (options.stay !== undefined) {
    const stay = clone(object(options.stay, 'stay'));
    for (const key of Object.keys(stay)) if (!STAY_FIELDS.has(key)) throw new TypeError(`Unsupported stay field: ${key}`);
    for (const key of ['china', 'partnerData', 'splitStays']) {
      if (stay[key] !== undefined && stay[key] !== null) throw new TypeError(`Non-null ${key} is unsupported by the recovered native serializer`);
    }
    text(stay.productId, 'stay.productId');
    date(stay.checkinDate, 'stay.checkinDate');
    date(stay.checkoutDate, 'stay.checkoutDate');
    if (stay.checkoutDate <= stay.checkinDate) throw new TypeError('checkoutDate must follow checkinDate');
    object(stay.guestCounts, 'stay.guestCounts');
    number(stay.guestCounts.numberOfAdults, 'numberOfAdults', 1);
    for (const key of ['numberOfChildren', 'numberOfInfants', 'numberOfPets']) {
      if (stay.guestCounts[key] !== undefined && stay.guestCounts[key] !== null) number(stay.guestCounts[key], key);
    }
    return stay;
  }
  const stay = {
    productId: stayProductId(options.listingId),
    checkinDate: date(options.checkin, 'checkin'),
    checkoutDate: date(options.checkout, 'checkout'),
    guestCounts: {
      numberOfAdults: number(options.adults ?? 1, 'adults', 1),
      numberOfChildren: number(options.children ?? 0, 'children'),
      numberOfInfants: number(options.infants ?? 0, 'infants'),
      numberOfPets: number(options.pets ?? 0, 'pets'),
    },
  };
  if (stay.checkoutDate <= stay.checkinDate) throw new TypeError('checkout must follow checkin');
  if (options.currency !== undefined) {
    if (!/^[A-Z]{3}$/.test(options.currency)) throw new TypeError('currency must be a three-letter uppercase code');
    stay.guestCurrencyOverride = options.currency;
  }
  if (options.bookingAttemptId !== undefined) stay.bookingAttemptId = text(options.bookingAttemptId, 'bookingAttemptId');
  if (options.guestAges !== undefined) {
    if (!Array.isArray(options.guestAges)) throw new TypeError('guestAges must be an array');
    stay.guestAges = options.guestAges.map((age) => number(age, 'guestAge'));
  }
  return stay;
}

export function buildCheckoutPreview(options = {}) {
  const stay = prepareStayInput(options);
  const input = { staysV1: [stay] };
  if (stay.guestCurrencyOverride !== undefined) input.guestCurrencyOverride = stay.guestCurrencyOverride;
  // orderId/quickPayData/previousPlacement are optional native fields for a later refresh.
  add(input, options, ['orderId', 'quickPayData', 'previousPlacement', 'checkoutPaymentErrorToken']);
  return descriptor('preview', { input });
}

export function buildStaysCheckout(options = {}) {
  // Native code uses this mutation to refresh checkout state. Keep it explicitly POST.
  return descriptor('staysCheckout', { input: prepareStayInput(options) }, true);
}

export function prepareSavedCardPaymentOption(paymentOption) {
  const option = object(paymentOption, 'paymentOption');
  if ((option.__typename !== undefined && option.__typename !== 'QuickPayPaymentOption') ||
      option.gibraltarInstrumentType !== 'CREDIT_CARD' || option.isExistingInstrument !== true ||
      option.isCvvRequiredForPayment !== false || option.isValidForCurrency !== true) {
    throw new TypeError('Only an existing CREDIT_CARD valid for the quote currency with no required CVV is supported');
  }
  const card = object(option.creditCardDetails, 'creditCardDetails');
  if (card.expired !== false) throw new TypeError('The saved card must explicitly be unexpired');
  if (card.threeDSecure2Details != null || option.paymentOptionInputInfo != null || option.errorDetail != null ||
      option.alipayDetails != null) {
    throw new TypeError('Saved-card CVV, 3DS, trust-input, error, or alternate-payment branches require a separate reviewed flow');
  }
  // lf32.m37018 -> kc22.m32655 -> x901/i9n. z790.m65120 omits null
  // values; kc22.m32664(..., false) explicitly includes the two null branches.
  const input = {
    alipayDetails: null,
    creditCardDetails: {},
    errorDetail: {},
    gibraltarInstrumentToken: text(option.gibraltarInstrumentToken, 'gibraltarInstrumentToken'),
    gibraltarInstrumentType: 'CREDIT_CARD',
    netBankingDetails: null,
  };
  if (option.businessEntityGroupId != null) input.businessEntityGroupId = positiveInt64(option.businessEntityGroupId, 'businessEntityGroupId');
  for (const key of ['displayName', 'localizedSubtitle']) {
    if (option[key] != null) {
      if (typeof option[key] !== 'string') throw new TypeError(`${key} must be a string`);
      input[key] = option[key];
    }
  }
  for (const key of ['isCvvRequiredForPayment', 'isDefault', 'isExistingInstrument', 'isNewlyVaulted', 'isValidForCurrency']) {
    if (option[key] != null) {
      if (typeof option[key] !== 'boolean') throw new TypeError(`${key} must be a boolean`);
      input[key] = option[key];
    }
  }
  for (const key of ['bin', 'cardType', 'countryOfIssuance', 'lastFour']) {
    if (card[key] != null) {
      if (typeof card[key] !== 'string') throw new TypeError(`creditCardDetails.${key} must be a string`);
      input.creditCardDetails[key] = card[key];
    }
  }
  input.creditCardDetails.expired = false;
  return input;
}

export function prepareStayProductDetails({ airbnbOrgParams, businessTravelDetails, cubaAttestation, messageToHost } = {}) {
  // The generated native wrapper is {stayDetails}; listing/dates belong to the quote.
  const stayDetails = {};
  for (const [key, value] of Object.entries({ airbnbOrgParams, businessTravelDetails, cubaAttestation })) {
    if (value !== undefined) stayDetails[key] = value === null ? null : clone(object(value, key));
  }
  if (messageToHost !== undefined) {
    if (messageToHost !== null && typeof messageToHost !== 'string') throw new TypeError('messageToHost must be a string or null');
    stayDetails.messageToHost = messageToHost;
  }
  return { stayDetails };
}

export function buildStayProductDetails(options = {}) {
  return [prepareStayProductDetails(options)];
}

export function buildPlaceOrder({ placeOrder } = {}) {
  const order = clone(object(placeOrder, 'placeOrder'));
  for (const key of Object.keys(order)) {
    if (!['bookingQuoteId', 'marsSessionToken', 'orderId', 'paymentParams', 'productDetails'].includes(key)) {
      throw new TypeError(`Unsupported placeOrder field: ${key}`);
    }
  }
  // These values must come from the reviewed checkout, never from listing/search prices.
  text(order.bookingQuoteId, 'bookingQuoteId');
  text(order.orderId, 'orderId');
  const payment = object(order.paymentParams, 'paymentParams');
  positiveInt64(payment.paymentQuoteId, 'paymentQuoteId');
  object(payment.selectedPaymentOption, 'selectedPaymentOption');
  if (!Array.isArray(order.productDetails) || !order.productDetails.length) throw new TypeError('productDetails must contain reviewed product data');
  if (order.marsSessionToken !== undefined && order.marsSessionToken !== null) text(order.marsSessionToken, 'marsSessionToken');
  return descriptor('placeOrder', { input: { placeOrder: order } }, true);
}

export function buildCancellationPreview({ confirmationCode, selectedReasonId, selectedSubReasonId } = {}) {
  const variables = { productIdentifier: { identifier: text(confirmationCode, 'confirmationCode'), productType: 'STAY' } };
  const state = {};
  if (selectedReasonId !== undefined) state.selectedReasonId = text(selectedReasonId, 'selectedReasonId');
  if (selectedSubReasonId !== undefined) state.selectedSubReasonId = text(selectedSubReasonId, 'selectedSubReasonId');
  if (Object.keys(state).length) variables.state = state;
  return descriptor('cancellationPreview', variables);
}

export function buildConfirmCancellation({ confirmationCode, reasonId, reasonIdValue, selectedRefundMethodType } = {}) {
  const request = { cancellationType: 'CANCEL_BY_CUSTOMER', productId: { identifier: text(confirmationCode, 'confirmationCode'), productType: 'STAY' } };
  if (reasonId !== undefined) request.reasonId = text(reasonId, 'reasonId');
  if (reasonIdValue !== undefined) request.reasonIdValue = text(reasonIdValue, 'reasonIdValue');
  if (!request.reasonId && !request.reasonIdValue) throw new TypeError('A reviewed cancellation reason is required');
  if (selectedRefundMethodType !== undefined) {
    if (!['REFUND_METHOD_OPTION_CREDIT', 'REFUND_METHOD_OPTION_DEFAULT'].includes(selectedRefundMethodType)) throw new TypeError('Unknown refund method');
    request.selectedRefundMethodType = selectedRefundMethodType;
  }
  return descriptor('confirmCancellation', { request }, true);
}

export function buildCheckoutConfirmation({ confirmationCode } = {}) {
  return descriptor('confirmation', { confirmationCode: text(confirmationCode, 'confirmationCode') });
}
export function buildBillPolling({ billToken, userId } = {}) {
  return descriptor('billPolling', { billToken: text(billToken, 'billToken'), userId: number(userId, 'userId', 1) });
}

export function buildCancelledReservations({ userId, first, after, order } = {}) {
  // userId is the account's existing GlobalID. Do not reinterpret it as a listing ID.
  const variables = { userId: text(userId, 'userId'), type: 'CANCELED' };
  if (first !== undefined) variables.first = first === null ? null : number(first, 'first', 1);
  if (after !== undefined) variables.after = after === null ? null : text(after, 'after');
  if (order !== undefined) {
    if (!['CHRONOLOGICAL', 'REVERSE_CHRONOLOGICAL'].includes(order)) throw new TypeError('Unknown trip order');
    variables.order = order;
  }
  return descriptor('cancelledReservations', variables);
}

function data(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response) ||
      !response.data || typeof response.data !== 'object' || Array.isArray(response.data)) throw new TypeError('GraphQL response has no data');
  if (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length)) throw new Error('GraphQL response contains errors');
  return response.data;
}
export function parseCheckoutPreview(response) {
  const sections = object(data(response).checkoutFlow?.sections, 'checkoutFlow.sections');
  if (sections.metadata?.errorMetadata?.errorSection || sections.metadata?.errorMetadata?.errorRedirect) {
    const error = new Error('Airbnb could not prepare this checkout. No booking was made.');
    error.code = 'CHECKOUT_UNAVAILABLE';
    throw error;
  }
  return { metadata: sections.metadata ?? null, quickPayData: sections.quickPayData ?? null,
    sectionConfiguration: sections.sectionConfiguration ?? null, checkoutServiceContext: sections.checkoutServiceContext ?? null,
    preparation: checkoutPreparation(sections, sections.quickPayData?.bootstrapPayments), sections, raw: response };
}

export function parseStayCheckoutPreview(response) {
  const sections = object(data(response).startStayCheckoutFlow?.stayCheckout?.sections, 'startStayCheckoutFlow.stayCheckout.sections');
  if (sections.metadata?.errorData != null || sections.sectionMetadata?.errorData != null) {
    const error = new Error('Airbnb could not prepare this checkout. No booking was made.');
    error.code = 'CHECKOUT_UNAVAILABLE';
    throw error;
  }
  const preparation = checkoutPreparation(sections, sections.temporaryQuickPayData?.bootstrapPayments);
  return { metadata: sections.metadata ?? null, sectionMetadata: sections.sectionMetadata ?? null,
    stateMutation: sections.stateMutation ?? null, initialState: sections.initialState ?? null,
    temporaryQuickPayData: sections.temporaryQuickPayData ?? null,
    sectionConfiguration: sections.sectionConfiguration ?? null, checkoutServiceContext: sections.checkoutServiceContext ?? null,
    preparation, sectionData: preparation.sectionData, sectionDataEntries: preparation.sectionDataEntries, sections, raw: response };
}

function checkoutPreparation(sections, payments) {
  const metadata = sections.metadata;
  const prices = payments?.productPriceBreakdown;
  const total = prices?.priceBreakdown?.total ?? prices?.total ?? null;
  const sectionDataEntries = Array.isArray(sections.sectionConfiguration?.data) ? sections.sectionConfiguration.data : null;
  // These are the requested source paths, not recursive guesses from section titles.
  // Keep native ID/Long values and money micros intact; no floating-point conversion.
  return {
    bookingQuoteId: metadata?.bookingQuoteId ?? null,
    orderId: metadata?.orderId ?? null,
    confirmationCodes: metadata?.confirmationCodes ?? null,
    confirmationCode: metadata?.confirmationCode ?? null,
    bookingAttemptId: metadata?.bookingAttemptId ?? null,
    paymentQuoteId: payments?.billData?.paymentQuoteId ?? null,
    billData: payments?.billData ?? null,
    checkoutTokens: payments?.checkoutTokens ?? null,
    paymentOptions: payments?.paymentOptions?.paymentOptions ?? null,
    selectedPaymentOption: payments?.paymentOptions?.selectedPaymentOption ?? null,
    visiblePaymentOptions: payments?.paymentOptions?.visiblePaymentOptions ?? null,
    productPriceBreakdown: prices ?? null,
    total,
    totalAmount: total?.total ?? null,
    priceItems: prices?.priceBreakdown?.priceItems ?? null,
    subtotalItems: prices?.priceBreakdown?.subtotalItems ?? null,
    informationalPriceItems: prices?.priceBreakdown?.informationalPriceItems ?? null,
    pricingDisclaimer: payments?.pricingDisclaimer ?? null,
    sectionDataEntries,
    sectionData: sectionDataEntries?.map((entry) => entry?.sectionData ?? null) ?? null,
  };
}

export function extractCheckoutPreparation(response) {
  return parseCheckoutPreview(response).preparation;
}
export function parseCancellationPreview(response) {
  const cancellation = object(data(response).presentation?.cancellation, 'presentation.cancellation');
  return { title: cancellation.title ?? null, callToActionButtons: cancellation.callToActionButtons ?? null,
    sections: cancellation.sections ?? null, cancellation, raw: response };
}
export function parsePlaceOrderResult(response) {
  const result = object(data(response).checkoutFulfillment?.result, 'checkoutFulfillment.result');
  const type = typeof result.__typename === 'string' ? result.__typename : null;
  const status = result.bookingOutcome?.status ?? null;
  const error = result.error ?? null;
  let outcome = 'unknown';
  // The native union resolver recognizes this place-order variant separately from
  // reservation alteration results. Extra/future variants must not look successful.
  if (type === 'CheckoutFulfillmentPlaceOrderResult') {
    if (status === 'FAILURE') outcome = 'failed';
    else if (error?.__typename === 'CheckoutFulfillmentPlaceOrderError' &&
             status !== 'SUCCESS' && status !== 'PENDING_PAYMENT' && status !== 'PENDING_IDENTITY_VERIFICATION') outcome = 'failed';
    else if (error === null) {
      if (status === 'PENDING_PAYMENT' || status === 'PENDING_IDENTITY_VERIFICATION') outcome = 'pending';
      // Missing IDs or error coverage leave a partial SUCCESS response unresolved.
      else if (status === 'SUCCESS' && typeof result.orderId === 'string' && result.orderId.trim() &&
               Object.hasOwn(result, 'error') && result.error === null) outcome = 'succeeded';
    }
  }
  return { type, orderId: result.orderId ?? null, status, outcome,
    confirmed: outcome === 'succeeded', terminal: outcome === 'succeeded' || outcome === 'failed',
    ...(outcome === 'succeeded' || outcome === 'failed' ? { success: outcome === 'succeeded' } : {}),
    altoIdempotencyKey: result.altoIdempotencyKey ?? null,
    error, checkoutActions: result.checkoutActions ?? null, paymentDetails: result.paymentDetails ?? null,
    productTokens: result.productTokens ?? null, result, raw: response };
}
export function parseCancellationResult(response) {
  const result = object(data(response).cancelProduct, 'cancelProduct');
  const type = typeof result.__typename === 'string' ? result.__typename : null;
  let outcome = 'unknown';
  if (type === 'CancelProductSuccessResponse' && typeof result.success === 'boolean') {
    outcome = result.success ? 'succeeded' : 'failed';
  } else if (type === 'ProductCannotBeCanceledError' && typeof result.retryable === 'boolean') outcome = 'failed';
  return { type, outcome, confirmed: outcome === 'succeeded',
    terminal: outcome === 'succeeded' || outcome === 'failed',
    ...(outcome === 'succeeded' || outcome === 'failed' ? { success: outcome === 'succeeded' } : {}),
    errorMessage: type === 'ProductCannotBeCanceledError' ? result.errorMessage ?? null : null,
    retryable: type === 'ProductCannotBeCanceledError' && typeof result.retryable === 'boolean' ? result.retryable : null,
    redirectUrl: type === 'ProductCannotBeCanceledError' ? result.redirectUrl ?? null : null,
    actionText: type === 'ProductCannotBeCanceledError' ? result.actionText ?? null : null,
    result, raw: response };
}

export function parseBillPolling(response) {
  const payment = object(data(response).payments?.billPayinInfoForQuickPayPolling, 'payments.billPayinInfoForQuickPayPolling');
  return {
    // A false payin flag is not a source-backed terminal booking failure.
    isBookingPayinSucceeded: typeof payment.isBookingPayinSucceeded === 'boolean' ? payment.isBookingPayinSucceeded : null,
    shouldTriggerFovFlow: typeof payment.shouldTriggerFovFlow === 'boolean' ? payment.shouldTriggerFovFlow : null,
    freezeReason: payment.freezeReason ?? null,
    transactionErrorMessage: payment.transactionErrorMessage ?? null,
    afterBookingRedirectUrl: payment.afterBookingRedirectUrl ?? null,
    payment, raw: response,
  };
}

export function parseCheckoutConfirmation(response) {
  const confirmation = object(data(response).presentation?.checkoutConfirmation, 'presentation.checkoutConfirmation');
  // This is presentation data fetched by confirmation code, not a generic status API.
  return { sectionConfiguration: confirmation.sectionConfiguration ?? null,
    presentationData: confirmation.presentationData ?? null, confirmation, raw: response };
}

export function parseCancelledReservationsPage(response) {
  const node = data(response).node;
  const type = typeof node?.__typename === 'string' ? node.__typename : null;
  const connection = type === 'User' ? node.tripItems : null;
  return { type, edges: Array.isArray(connection?.edges) ? connection.edges : null,
    pageInfo: connection?.pageInfo && typeof connection.pageInfo === 'object' && !Array.isArray(connection.pageInfo) ? connection.pageInfo : null,
    node: node ?? null, raw: response };
}
