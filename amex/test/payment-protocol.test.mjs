import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentInquiry, parsePaymentInquiry, preparePayment, buildPaymentSubmit, parsePaymentSubmission, preparePaymentCancellation, buildPaymentCancellation, parsePaymentCancellation, decimalMoney } from '../src/payment-protocol.mjs';
const money = amount => ({ amount, currency: 'USD' });
function inquiry() { return { status: { success: true }, data: {
  type: 'MAKE_PAYMENT', paymentRequestId: 'test-server-idempotency',
  paymentMethods: { type: 'AVAILABLE', options: [{ type: 'ACTIVE', paymentMethodId: 'test-bank', name: 'Test Bank', detail: '••0001', minimumDate: '2026-10-21', maximumDate: '2026-11-21' }], termsAndConditions: { text: 'Test bank terms' } },
  paymentAmounts: { defaultOptions: { minimumPaymentAmount: { value: money('1.00') }, maximumPaymentAmount: { value: money('1000.00') }, amountOptions: [{ optionType: 'DEFAULT', identifier: 'test-minimum', type: 'MINIMUM', label: 'Minimum payment', value: money('25.00'), isEnabled: true, isEditable: false }, { optionType: 'DEFAULT', type: 'OTHER', label: 'Other amount', value: money('0.00'), isEnabled: true, isEditable: true }] }, termsAndConditions: { text: 'Test amount terms' } },
  paymentDates: { options: [{ type: 'FIXED_DATE', value: '2026-10-21', isEnabledForMakePayment: true }, { type: 'CUSTOM_DATE', isEnabledForMakePayment: true }], range: { minimumDate: '2026-10-21', maximumDate: '2026-11-21' } },
  paymentScreens: { makePayment: { title: 'Make a Payment', termsAndConditions: { text: 'Test payment terms' } }, cancelPayment: { message: 'Cancel this test scheduled payment?' } },
  scheduledPayments: { type: 'CLASSIC', payments: [{ paymentID: 'test-scheduled', paymentMethodId: 'test-bank', paymentAmount: { value: '$25.00' }, paymentDate: { value: '2026-10-22' }, deletePayment: { title: 'Cancel payment', message: 'Test cancellation terms' } }] },
} }; }
const args = () => ({ accountToken: 'test-account', inquiry: inquiry(), methodId: 'test-bank', amountOptionId: 'test-minimum', date: '2026-10-21' });
test('payment inquiry uses exact native account header', () => {
  const spec = buildPaymentInquiry({ accountToken: 'test-account' });
  assert.equal(spec.path, '/services/payment/v3/inquiry'); assert.deepEqual(spec.headers, { 'x-axp-account-token': 'test-account' });
  assert.equal(parsePaymentInquiry(inquiry()).phase, 'ready');
  assert.equal(parsePaymentInquiry({ status: { success: true }, data: { type: 'INELIGIBLE_CARD' } }).phase, 'action_required');
});
test('native payment body uses server idempotency ID and exact amount option lineage', () => {
  const prepared = preparePayment(args());
  assert.equal(prepared.phase, 'review_required');
  assert.deepEqual(prepared.body, { type: 'PAYMENT', accountToken: 'test-account', date: '2026-10-21', idempotencyKey: 'test-server-idempotency', methodId: 'test-bank', optionIdentifier: { type: 'OPTION_ID', value: 'test-minimum' }, value: money('25.00') });
  const spec = buildPaymentSubmit({ prepared, confirm: true, acceptTerms: prepared.termsHash });
  assert.equal(spec.method, 'PUT'); assert.equal(spec.path, '/services/payment/v3/submit'); assert.equal(spec.retry, false); assert.equal(spec.financialMutation, true);
  const fallback = preparePayment({ ...args(), amountOptionId: 'OTHER', amount: '12.34' });
  assert.deepEqual(fallback.body.optionIdentifier, { type: 'OPTION_TYPE', value: 'OTHER' });
});
test('selection, enabled state, real date and amount bounds fail closed', () => {
  assert.throws(() => preparePayment({ ...args(), methodId: 'other-bank' }));
  const duplicate = args(); duplicate.inquiry.data.paymentMethods.options.push(structuredClone(duplicate.inquiry.data.paymentMethods.options[0])); assert.throws(() => preparePayment(duplicate));
  const expired = args(); expired.inquiry.data.paymentMethods.options[0].type = 'EXPIRED'; assert.equal(preparePayment(expired).phase, 'action_required');
  const disabled = args(); disabled.inquiry.data.paymentAmounts.defaultOptions.amountOptions[0].isEnabled = false; assert.equal(preparePayment(disabled).phase, 'action_required');
  assert.throws(() => preparePayment({ ...args(), date: '2026-02-30' }));
  assert.throws(() => preparePayment({ ...args(), date: '2026-10-20' }));
  assert.throws(() => preparePayment({ ...args(), amount: '30.00' }));
  assert.throws(() => preparePayment({ ...args(), amountOptionId: 'OTHER', amount: '1000.01' }));
  assert.throws(() => preparePayment({ ...args(), amountOptionId: 'OTHER', amount: money('0.00') }));
});
test('money never passes through binary floating point or accepts exponents', () => {
  assert.deepEqual(decimalMoney(money('123456789012345678.123456')), money('123456789012345678.123456'));
  for (const value of [1, 0.1, '1e3', '-1.00', '1.0000001', '01.00']) assert.throws(() => decimalMoney(money(value)));
  assert.throws(() => preparePayment({ ...args(), amountOptionId: 'OTHER', amount: { amount: '20.00', currency: 'EUR' } }));
});
test('no synthetic idempotency and no final call without matching exact review', () => {
  const missing = args(); delete missing.inquiry.data.paymentRequestId; assert.throws(() => preparePayment(missing));
  const prepared = preparePayment(args());
  assert.throws(() => buildPaymentSubmit({ prepared, acceptTerms: prepared.termsHash }));
  assert.throws(() => buildPaymentSubmit({ prepared, confirm: true, acceptTerms: 'other' }));
  const tampered = structuredClone(prepared); tampered.body.value.amount = '900.00'; assert.throws(() => buildPaymentSubmit({ prepared: tampered, confirm: true, acceptTerms: prepared.termsHash }));
});
test('unknown, step-up, partial and failed payment results never become submitted', () => {
  assert.equal(parsePaymentSubmission({ status: { success: true }, data: { type: 'PAYMENT', title: 'Test result', paymentRows: [] } }).phase, 'submitted');
  assert.equal(parsePaymentSubmission({ status: { success: true }, data: { type: 'PAYMENT', title: 'Test result', paymentRows: [] } }).settled, false);
  assert.equal(parsePaymentSubmission({ status: { success: true }, data: { type: 'PAYMENT', title: 'Test result' } }).phase, 'unknown');
  assert.equal(parsePaymentSubmission({ status: { success: true, secondaryAuthenticationV4: { type: 'OTP' } }, data: { type: 'PAYMENT', title: 'Test', paymentRows: [] } }).phase, 'action_required');
  assert.equal(parsePaymentSubmission({ status: { success: false }, data: { type: 'PAYMENT', title: 'Test', paymentRows: [] } }).phase, 'failed');
});
test('cancellation binds one source-offered scheduled payment and exact terms', () => {
  const prepared = preparePaymentCancellation({ accountToken: 'test-account', inquiry: inquiry(), paymentID: 'test-scheduled' });
  const spec = buildPaymentCancellation({ prepared, confirm: true, acceptTerms: prepared.termsHash });
  assert.equal(spec.method, 'DELETE'); assert.equal(spec.path, '/services/payment/v1/payments/test-scheduled');
  assert.equal(spec.headers['x-axp-account-token'], 'test-account');
  assert.throws(() => buildPaymentCancellation({ prepared, confirm: true, acceptTerms: 'wrong' }));
  const changed = inquiry(); delete changed.data.scheduledPayments.payments[0].deletePayment; changed.data.scheduledPayments.payments[0].managePayment = { actions: [{ actionType: 'CANCEL' }] };
  assert.equal(preparePaymentCancellation({ accountToken: 'test-account', inquiry: changed, paymentID: 'test-scheduled' }).phase, 'action_required');
});
test('cancellation requires the exact success snackbar union', () => {
  assert.equal(parsePaymentCancellation({ status: { success: true }, data: { type: 'SUCCESS', body: 'Test payment cancelled' } }).phase, 'cancellation_accepted');
  for (const data of [{}, { type: 'NEUTRAL', body: 'Error' }, { type: 'WARNING', body: 'Review' }]) assert.equal(parsePaymentCancellation({ status: { success: true }, data }).phase, 'unknown');
  assert.equal(parsePaymentCancellation({ status: { success: false }, data: { type: 'SUCCESS', body: 'Test' } }).phase, 'failed');
});
