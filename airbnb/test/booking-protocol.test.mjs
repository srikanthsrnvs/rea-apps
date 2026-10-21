import test from 'node:test';
import assert from 'node:assert/strict';
import { stayProductId, buildCheckoutPreview, buildStaysCheckout, buildPlaceOrder,
  buildCancellationPreview, buildConfirmCancellation, parseCheckoutPreview,
  parsePlaceOrderResult, parseCancellationResult, extractCheckoutPreparation,
  buildCheckoutConfirmation, buildBillPolling, buildCancelledReservations,
  parseCheckoutConfirmation, parseBillPolling, parseCancelledReservationsPage,
  parseStayCheckoutPreview, prepareSavedCardPaymentOption, buildStayProductDetails } from '../src/booking-protocol.mjs';

test('preview uses native StayListing GlobalID and validates the complete travel interval', () => {
  const spec = buildCheckoutPreview({ listingId: '123456', checkin: '2027-03-01', checkout: '2027-03-04', adults: 2, children: 1, currency: 'USD' });
  assert.equal(Buffer.from(stayProductId('123456'), 'base64').toString(), 'StayListing:123456');
  assert.equal(spec.operationName, 'CheckoutFlowQuery');
  assert.equal(spec.variables.input.staysV1[0].guestCounts.numberOfChildren, 1);
  assert.equal(spec.variables.input.staysV1[0].bookingQuoteId, undefined);
  assert.throws(() => buildCheckoutPreview({ listingId: 1, checkin: '2027-02-30', checkout: '2027-03-04' }));
  assert.throws(() => buildCheckoutPreview({ listingId: 1, checkin: '2027-03-04', checkout: '2027-03-04' }));
  assert.throws(() => stayProductId('DemandStayListing:123'));
  assert.throws(() => buildCheckoutPreview({ stay: { ...spec.variables.input.staysV1[0], partnerData: {} } }), /unsupported/);
});

test('commit descriptors require reviewed quote/payment data and cannot become GETs', () => {
  assert.throws(() => buildPlaceOrder({ placeOrder: { bookingQuoteId: 'q' } }));
  const order = { bookingQuoteId: '42', orderId: '43', paymentParams: { paymentQuoteId: 44,
    selectedPaymentOption: { gibraltarInstrumentId: 45, isExistingInstrument: true } }, productDetails: [{}] };
  const spec = buildPlaceOrder({ placeOrder: order });
  assert.equal(spec.method, 'POST');
  assert.equal(spec.operationName, 'CheckoutFulfillmentMutation');
  order.paymentParams.paymentQuoteId = 99;
  assert.equal(spec.variables.input.placeOrder.paymentParams.paymentQuoteId, 44);
  assert.equal(buildStaysCheckout({ listingId: 1, checkin: '2027-03-01', checkout: '2027-03-04' }).operationName, 'stayCheckout');
});

test('native Long payment quote IDs preserve all decimal digits and reject rounded numbers', () => {
  const order = { bookingQuoteId: '42', orderId: '43', paymentParams: {
    paymentQuoteId: '123456789012345678', selectedPaymentOption: { gibraltarInstrumentToken: 'synthetic' },
  }, productDetails: buildStayProductDetails() };
  assert.equal(buildPlaceOrder({ placeOrder: order }).variables.input.placeOrder.paymentParams.paymentQuoteId, '123456789012345678');
  for (const id of [123456789012345678, '9223372036854775808', '-1', '1.0', '1e18', '01', '0']) {
    assert.throws(() => buildPlaceOrder({ placeOrder: { ...order, paymentParams: { ...order.paymentParams, paymentQuoteId: id } } }));
  }
});

test('saved card conversion matches the recovered native input and rejects further payment actions', () => {
  const card = { __typename: 'QuickPayPaymentOption', gibraltarInstrumentType: 'CREDIT_CARD',
    gibraltarInstrumentToken: 'synthetic-opaque-token', isExistingInstrument: true, isCvvRequiredForPayment: false,
    isValidForCurrency: true, isDefault: false, isNewlyVaulted: null, displayName: 'Synthetic saved card',
    localizedSubtitle: null, creditCardDetails: { __typename: 'CreditCardDetail', bin: '123456', cardType: 'VISA',
      countryOfIssuance: 'US', lastFour: '1234', expired: false, debitCard: true, threeDSecure2Details: null },
    paymentOptionInputInfo: null, errorDetail: null, alipayDetails: null,
    availableCardNetworks: ['VISA'], paymentMethodWithProvider: { paymentMethod: 'CREDIT_CARD' },
  };
  const input = prepareSavedCardPaymentOption(card);
  assert.deepEqual(input, { alipayDetails: null, netBankingDetails: null, errorDetail: {},
    gibraltarInstrumentType: 'CREDIT_CARD', gibraltarInstrumentToken: 'synthetic-opaque-token',
    isExistingInstrument: true, isCvvRequiredForPayment: false, isValidForCurrency: true, isDefault: false,
    displayName: 'Synthetic saved card', creditCardDetails: {
      bin: '123456', cardType: 'VISA', countryOfIssuance: 'US', lastFour: '1234', expired: false,
    } });
  assert.equal(input.__typename, undefined);
  assert.equal(input.paymentOptionInputInfo, undefined);
  assert.equal(input.creditCardDetails.debitCard, undefined);
  card.creditCardDetails.lastFour = '9999';
  assert.equal(input.creditCardDetails.lastFour, '1234');
  for (const patch of [
    { gibraltarInstrumentType: 'ANDROID_PAY' }, { isExistingInstrument: false }, { isCvvRequiredForPayment: true },
    { isValidForCurrency: false }, { paymentOptionInputInfo: {} }, { errorDetail: {} },
    { creditCardDetails: { ...card.creditCardDetails, expired: true } },
    { creditCardDetails: { ...card.creditCardDetails, expired: null } },
    { creditCardDetails: { ...card.creditCardDetails, threeDSecure2Details: { authenticationRequired: true } } },
  ]) assert.throws(() => prepareSavedCardPaymentOption({ ...card, ...patch }));
});

test('stay product details use the exact wrapper and only include an explicitly supplied host message', () => {
  assert.deepEqual(buildStayProductDetails(), [{ stayDetails: {} }]);
  const business = { isOpenHomes: false, isTrackingOnly: false };
  const result = buildStayProductDetails({ businessTravelDetails: business, messageToHost: 'Synthetic user-approved note' });
  assert.deepEqual(result, [{ stayDetails: { businessTravelDetails: business, messageToHost: 'Synthetic user-approved note' } }]);
  assert.equal(result[0].stayDetails.listingId, undefined);
  assert.equal(result[0].stayDetails.checkinDate, undefined);
  business.isOpenHomes = true;
  assert.equal(result[0].stayDetails.businessTravelDetails.isOpenHomes, false);
  assert.throws(() => buildStayProductDetails({ messageToHost: 123 }));
});

test('cancellation preview and commit keep their distinct state and reason schemas', () => {
  const preview = buildCancellationPreview({ confirmationCode: 'INVENTED', selectedReasonId: 'SOURCE_REASON' });
  assert.equal(preview.operationName, 'UnifiedCancellation');
  assert.deepEqual(preview.variables.state, { selectedReasonId: 'SOURCE_REASON' });
  assert.equal(preview.variables.productIdentifier.productType, 'STAY');
  assert.throws(() => buildConfirmCancellation({ confirmationCode: 'INVENTED' }));
  assert.throws(() => buildConfirmCancellation({ confirmationCode: 'INVENTED', reasonId: 'SOURCE_REASON', selectedRefundMethodType: 'guessed' }));
  const commit = buildConfirmCancellation({ confirmationCode: 'INVENTED', reasonId: 'SOURCE_REASON' });
  assert.equal(commit.method, 'POST');
  assert.equal(commit.variables.request.cancellationType, 'CANCEL_BY_CUSTOMER');
  assert.equal(commit.variables.request.messaging, undefined);
});

test('review parsers preserve dynamic prices and never turn an ambiguous result into success', () => {
  const quote = { data: { checkoutFlow: { sections: { metadata: { bookingQuoteId: 1 }, sectionConfiguration: { feeLines: ['server supplied'] } } } } };
  assert.equal(parseCheckoutPreview(quote).raw, quote);
  assert.deepEqual(parseCheckoutPreview(quote).sectionConfiguration.feeLines, ['server supplied']);
  assert.throws(() => parseCheckoutPreview({ data: { checkoutFlow: { sections: { metadata: { errorMetadata: { errorSection: { error: {} } } } } } } }), { code: 'CHECKOUT_UNAVAILABLE' });
  const pending = { data: { checkoutFulfillment: { result: { orderId: '1', bookingOutcome: { status: 'PENDING_PAYMENT' }, checkoutActions: ['action'] } } } };
  assert.equal(parsePlaceOrderResult(pending).status, 'PENDING_PAYMENT');
  assert.deepEqual(parsePlaceOrderResult(pending).checkoutActions, ['action']);
  const cancelled = parseCancellationResult({ data: { cancelProduct: { __typename: 'UnrecognizedResult' } } });
  assert.equal(cancelled.success, undefined);
  assert.throws(() => parsePlaceOrderResult({ data: pending.data, errors: [{ message: 'partial' }] }));
});

test('place-order terminal results require the exact union type and complete success evidence', () => {
  const wrap = (result) => ({ data: { checkoutFulfillment: { result } } });
  const known = { __typename: 'CheckoutFulfillmentPlaceOrderResult', orderId: 'synthetic-order',
    bookingOutcome: { status: 'SUCCESS' }, error: null, checkoutActions: [{ __typename: 'PlaceOrderSuccessRedirectAction' }] };
  const success = parsePlaceOrderResult(wrap(known));
  assert.equal(success.outcome, 'succeeded');
  assert.equal(success.confirmed, true);
  assert.equal(success.terminal, true);
  assert.deepEqual(success.checkoutActions, known.checkoutActions);
  assert.equal(parsePlaceOrderResult(wrap({ ...known, __typename: 'FutureResult' })).outcome, 'unknown');
  assert.equal(parsePlaceOrderResult(wrap({ ...known, orderId: null })).outcome, 'unknown');
  const { error: _error, ...partial } = known;
  assert.equal(parsePlaceOrderResult(wrap(partial)).outcome, 'unknown');
  assert.equal(parsePlaceOrderResult(wrap({ ...known, error: { __typename: 'CheckoutFulfillmentPlaceOrderError' } })).confirmed, false);
  for (const status of ['PENDING_PAYMENT', 'PENDING_IDENTITY_VERIFICATION']) {
    const pending = parsePlaceOrderResult(wrap({ ...known, bookingOutcome: { status } }));
    assert.equal(pending.outcome, 'pending');
    assert.equal(pending.terminal, false);
    assert.equal(pending.success, undefined);
  }
  assert.equal(parsePlaceOrderResult(wrap({ ...known, bookingOutcome: { status: 'FAILURE' } })).success, false);
  assert.equal(parsePlaceOrderResult(wrap({ ...known, bookingOutcome: { status: 'FUTURE_STATUS' } })).outcome, 'unknown');
  assert.throws(() => parsePlaceOrderResult({ data: [] }));
});

test('cancellation distinguishes explicit rejection, false success, missing fields, and future variants', () => {
  const wrap = (result) => ({ data: { cancelProduct: result } });
  assert.equal(parseCancellationResult(wrap({ __typename: 'CancelProductSuccessResponse', success: true })).confirmed, true);
  assert.equal(parseCancellationResult(wrap({ __typename: 'CancelProductSuccessResponse', success: false })).outcome, 'failed');
  for (const result of [
    { __typename: 'CancelProductSuccessResponse' },
    { __typename: 'CancelProductSuccessResponse', success: 'true' },
    { __typename: 'FutureCancellationResponse', success: true },
    { success: true },
    { __typename: 'ProductCannotBeCanceledError', errorMessage: 'synthetic' },
  ]) {
    const parsed = parseCancellationResult(wrap(result));
    assert.equal(parsed.outcome, 'unknown');
    assert.equal(parsed.terminal, false);
  }
  const result = { __typename: 'ProductCannotBeCanceledError', errorMessage: 'synthetic rejection',
    retryable: true, redirectUrl: 'https://example.invalid/review', actionText: 'Review', extra: 1 };
  const rejected = parseCancellationResult(wrap(result));
  assert.equal(rejected.outcome, 'failed');
  assert.equal(rejected.retryable, true);
  assert.equal(rejected.result.extra, 1);
  assert.equal(rejected.confirmed, false);
});

test('checkout extraction follows the canonical quote/payment/money paths without choosing a payment', () => {
  const selected = { gibraltarInstrumentToken: 'invented-token', displayName: 'Synthetic payment' };
  const amount = { amountFormatted: '$12.34', amountMicros: '12340000', currency: 'USD', newField: 'kept' };
  const total = { localizedTitle: 'Total', total: amount };
  const response = { data: { checkoutFlow: { sections: {
    metadata: { bookingQuoteId: 12, orderId: 13, confirmationCodes: [] },
    quickPayData: { bootstrapPayments: {
      billData: { paymentQuoteId: 14, billQuoteToken: 'invented-quote' },
      checkoutTokens: { paymentCheckoutId: 'invented-checkout', stepstonesToken: 'invented-stepstones' },
      paymentOptions: { paymentOptions: [selected], selectedPaymentOption: selected, visiblePaymentOptions: [selected] },
      productPriceBreakdown: { total, priceBreakdown: { priceItems: [{ type: 'SERVER_FEE' }], subtotalItems: [] } },
    } },
    sectionConfiguration: { paymentQuoteId: 'wrong-path', total: '$999' },
  } } } };
  const preparation = extractCheckoutPreparation(response);
  assert.equal(preparation.paymentQuoteId, 14);
  assert.equal(preparation.selectedPaymentOption, selected);
  assert.equal(preparation.totalAmount, amount);
  assert.equal(preparation.totalAmount.amountMicros, '12340000');
  assert.equal(preparation.totalAmount.newField, 'kept');
  assert.equal(preparation.priceItems[0].type, 'SERVER_FEE');
  assert.equal(preparation.readyToBook, undefined);
  const missing = extractCheckoutPreparation({ data: { checkoutFlow: { sections: { sectionConfiguration: { paymentQuoteId: 99 } } } } });
  assert.equal(missing.paymentQuoteId, null);
  assert.equal(missing.totalAmount, null);
});

test('stayCheckout parser follows its legacy sections, current total, quote IDs and policy envelopes', () => {
  const amount = { amountFormatted: 'USD 123.45', amountMicros: '123450000', currency: 'USD' };
  const selected = { gibraltarInstrumentToken: 'synthetic-card' };
  const terms = { __typename: 'TermsAndConditionsSection', typedSplitTextByLinks: ['Synthetic policy'] };
  const response = { data: { startStayCheckoutFlow: { stayCheckout: { sections: {
    metadata: { bookingQuoteId: '123456789012345678', orderId: '123456789012345679',
      bookingAttemptId: 'synthetic-attempt', confirmationCode: 'SYNTHETIC-DRAFT', errorData: null },
    sectionMetadata: { errorData: null },
    temporaryQuickPayData: { bootstrapPayments: {
      billData: { paymentQuoteId: '123456789012345680' },
      paymentOptions: { selectedPaymentOption: selected, paymentOptions: [selected] },
      productPriceBreakdown: { total: null, priceBreakdown: { total: { total: amount }, priceItems: [] } },
    } },
    sectionConfiguration: { data: [{ sectionId: 'TERMS_AND_CONDITIONS', sectionData: terms }] },
  } } } } };
  const parsed = parseStayCheckoutPreview(response);
  assert.equal(parsed.preparation.totalAmount, amount);
  assert.equal(parsed.preparation.paymentQuoteId, '123456789012345680');
  assert.equal(parsed.preparation.bookingAttemptId, 'synthetic-attempt');
  assert.equal(parsed.preparation.confirmationCode, 'SYNTHETIC-DRAFT');
  assert.equal(parsed.preparation.selectedPaymentOption, selected);
  assert.equal(parsed.sectionData[0], terms);
  assert.equal(parsed.sectionDataEntries[0].sectionId, 'TERMS_AND_CONDITIONS');
  assert.equal(parsed.preparation.confirmed, undefined);
  assert.equal(parsed.raw, response);
  assert.throws(() => parseCheckoutPreview(response), /checkoutFlow/);
  for (const key of ['metadata', 'sectionMetadata']) {
    const bad = structuredClone(response);
    bad.data.startStayCheckoutFlow.stayCheckout.sections[key].errorData = {};
    assert.throws(() => parseStayCheckoutPreview(bad), { code: 'CHECKOUT_UNAVAILABLE' });
  }
});

test('lookup parsers preserve source payment flags and confirmation presentation without inventing reservation status', () => {
  assert.deepEqual(buildBillPolling({ billToken: 'invented', userId: 123 }).variables, { billToken: 'invented', userId: 123 });
  assert.equal(buildCheckoutConfirmation({ confirmationCode: 'INVENTED' }).variables.confirmationCode, 'INVENTED');
  const cancelled = buildCancelledReservations({ userId: 'opaque-user-global-id', first: 10, after: 'opaque/+cursor' });
  assert.equal(cancelled.variables.after, 'opaque/+cursor');
  assert.equal(cancelled.variables.type, 'CANCELED');
  assert.equal(cancelled.method, undefined);
  assert.throws(() => buildCancelledReservations({ userId: 'x', first: 0 }));
  const body = { data: { payments: { billPayinInfoForQuickPayPolling: {
    isBookingPayinSucceeded: false, shouldTriggerFovFlow: true, freezeReason: 'synthetic-freeze', transactionErrorMessage: 'synthetic message',
  } } } };
  const polling = parseBillPolling(body);
  assert.equal(polling.isBookingPayinSucceeded, false);
  assert.equal(polling.shouldTriggerFovFlow, true);
  assert.equal(polling.confirmed, undefined);
  assert.equal(polling.outcome, undefined);
  assert.equal(polling.raw, body);
  const confirmation = parseCheckoutConfirmation({ data: { presentation: { checkoutConfirmation: { sectionConfiguration: { type: 'server-section' } } } } });
  assert.equal(confirmation.sectionConfiguration.type, 'server-section');
  assert.equal(confirmation.confirmed, undefined);
});

test('canceled-trip lookup keeps pagination and never treats an unknown user variant as an empty page', () => {
  const response = { data: { node: { __typename: 'User', tripItems: {
    pageInfo: { totalCount: 2, hasNextPage: true, endCursor: 'opaque-page-2' },
    edges: [{ node: { __typename: 'SourceTripItem', id: 'synthetic-item' } }],
  } } } };
  const page = parseCancelledReservationsPage(response);
  assert.equal(page.pageInfo.hasNextPage, true);
  assert.equal(page.edges[0].node.id, 'synthetic-item');
  assert.equal(page.confirmed, undefined);
  assert.equal(page.raw, response);
  assert.equal(parseCancelledReservationsPage({ data: { node: { __typename: 'FutureNode', tripItems: { edges: [] } } } }).edges, null);
  assert.equal(parseCancelledReservationsPage({ data: { node: null } }).edges, null);
  assert.deepEqual(parseCancelledReservationsPage({ data: { node: { __typename: 'User', tripItems: { edges: [] } } } }).edges, []);
});
