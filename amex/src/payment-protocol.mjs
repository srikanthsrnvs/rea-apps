// Native Amex Android 7.34.1 payment DTOs. No network or persistence here.
// This supports the app's existing-method, non-PCI-DSS PAYMENT branch only.
import { createHash } from 'node:crypto';
import { calendarDate, requiredText, responseGate } from './account-protocol.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const action = reason => ({ phase: 'action_required', reason });
export function decimalMoney(value, name = 'money') {
  if (!object(value) || typeof value.amount !== 'string' || !/^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/u.test(value.amount) || typeof value.currency !== 'string' || !/^[A-Z]{3}$/u.test(value.currency)) throw new TypeError(`Invalid ${name}; decimal strings and ISO currency are required`);
  return { amount: value.amount, currency: value.currency };
}
function units(money) { const [whole, part = ''] = money.amount.split('.'); return BigInt(whole) * 1000000n + BigInt(part.padEnd(6, '0')); }
function atLeastZero(money) { if (units(money) <= 0n) throw new RangeError('Payment amount must be positive'); }
function compareBound(amount, bound, direction) {
  if (bound === undefined || bound === null) return;
  const limit = decimalMoney(bound.value, `${direction} payment amount`);
  if (limit.currency !== amount.currency) throw new TypeError('Payment bound currency mismatch');
  if (direction === 'minimum' ? units(amount) < units(limit) : units(amount) > units(limit)) throw new RangeError(`Payment amount violates the ${direction}`);
}
export function buildPaymentInquiry({ accountToken, payItAmount, scheduledPaymentId } = {}) {
  const query = {};
  if (payItAmount !== undefined) query.payItAmount = requiredText(payItAmount, 'Pay It amount', 40);
  if (scheduledPaymentId !== undefined) query.scheduledPaymentId = requiredText(scheduledPaymentId, 'scheduled payment ID');
  return { method: 'GET', path: '/services/payment/v3/inquiry', query, headers: { 'x-axp-account-token': requiredText(accountToken, 'account token') }, sensitive: true, retry: false };
}
export function parsePaymentInquiry(response) {
  const gate = responseGate(response); if (gate.phase !== 'ready') return gate;
  if (!object(response.data) || typeof response.data.type !== 'string') return { phase: 'unknown', reason: 'unrecognized_payment_inquiry' };
  if (response.data.type !== 'MAKE_PAYMENT') return { ...action(`payment_inquiry_${response.data.type}`), data: copy(response.data) };
  const data = copy(response.data);
  const methods = Array.isArray(data.paymentMethods?.options) ? data.paymentMethods.options : [];
  return { phase: 'ready', data, methods: copy(methods), paymentAmounts: copy(data.paymentAmounts), paymentDates: copy(data.paymentDates), scheduledPayments: copy(data.scheduledPayments), paymentScreens: copy(data.paymentScreens) };
}
function sourceInquiry(inquiry) {
  const parsed = parsePaymentInquiry(inquiry);
  if (parsed.phase !== 'ready') throw new TypeError(`Payment inquiry cannot be used: ${parsed.reason ?? parsed.phase}`);
  return parsed.data;
}
function single(items, test, name) {
  const matches = items.filter(item => object(item) && test(item));
  if (matches.length !== 1) throw new TypeError(`Select exactly one offered ${name}`);
  return matches[0];
}
function amountOptions(data, method) {
  if (Array.isArray(method.amountOptions)) return method.amountOptions;
  return Array.isArray(data.paymentAmounts?.defaultOptions?.amountOptions) ? data.paymentAmounts.defaultOptions.amountOptions : [];
}
function offeredDate(data, method, value) {
  calendarDate(value, 'payment date');
  const options = Array.isArray(data.paymentDates?.options) ? data.paymentDates.options : [];
  const fixed = options.some(item => object(item) && item.type === 'FIXED_DATE' && item.value === value && item.isEnabledForMakePayment === true);
  const custom = options.some(item => object(item) && item.type === 'CUSTOM_DATE' && item.isEnabledForMakePayment === true);
  if (!fixed && !custom) throw new TypeError('Payment date is not offered and enabled by this inquiry');
  const range = data.paymentDates?.range;
  for (const source of [range, method]) {
    if (!object(source)) continue;
    if (source.minimumDate !== undefined && source.minimumDate !== null && value < calendarDate(source.minimumDate, 'minimum payment date')) throw new RangeError('Payment date precedes the offered minimum');
    if (source.maximumDate !== undefined && source.maximumDate !== null && value > calendarDate(source.maximumDate, 'maximum payment date')) throw new RangeError('Payment date exceeds the offered maximum');
  }
  return value;
}
export function paymentTerms(data) {
  return copy({ amount: data.paymentAmounts?.termsAndConditions ?? null,
    dates: data.paymentDates?.termsAndConditions ?? null,
    methods: data.paymentMethods?.termsAndConditions ?? null,
    makePayment: data.paymentScreens?.makePayment ?? null,
    confirmPayment: data.paymentScreens?.confirmPayment ?? null,
    amountWarnings: data.paymentAmounts?.warnings ?? null,
    permissions: data.paymentAmounts?.paymentPermissionsBanner ?? null,
    scheduledPaymentDisclaimer: data.scheduledPayments?.labels ?? null });
}
export function termsDigest(terms) { return createHash('sha256').update(JSON.stringify(terms)).digest('hex'); }
export function preparePayment({ accountToken, inquiry, methodId, amountOptionId, date, amount } = {}) {
  requiredText(accountToken, 'account token'); requiredText(methodId, 'payment method ID'); requiredText(amountOptionId, 'amount option ID');
  const data = sourceInquiry(inquiry);
  if (data.paymentMethods?.type !== 'AVAILABLE') return action('unsupported_payment_methods_branch');
  const method = single(Array.isArray(data.paymentMethods.options) ? data.paymentMethods.options : [], item => item.paymentMethodId === methodId, 'payment method');
  if (method.type !== 'ACTIVE') return action('payment_method_not_active');
  const option = single(amountOptions(data, method), item => (item.identifier ?? item.type) === amountOptionId, 'amount option');
  // PAY_AND_PLAN, HSA and reward conversion need their own DTOs and approvals.
  if (option.optionType !== 'DEFAULT') return action('unsupported_amount_option_branch');
  if (option.isEnabled !== true) return action('amount_option_disabled');
  let money = decimalMoney(option.value, 'offered amount');
  if (amount !== undefined) {
    if (option.isEditable !== true) throw new TypeError('This amount option is not editable');
    money = decimalMoney(typeof amount === 'string' ? { amount, currency: money.currency } : amount, 'payment amount');
    if (money.currency !== option.value.currency) throw new TypeError('Payment currency differs from the offered amount');
  }
  atLeastZero(money);
  for (const source of [data.paymentAmounts?.defaultOptions, method]) {
    compareBound(money, source?.minimumPaymentAmount, 'minimum');
    compareBound(money, source?.maximumPaymentAmount, 'maximum');
  }
  const paymentDate = offeredDate(data, method, date);
  // This is the server's request ID, used by the shipped non-PCI submit caller.
  const idempotencyKey = requiredText(data.paymentRequestId, 'server payment request ID');
  const optionIdentifier = option.identifier !== undefined && option.identifier !== null
    ? { type: 'OPTION_ID', value: requiredText(option.identifier, 'offered amount identifier') }
    : { type: 'OPTION_TYPE', value: requiredText(option.type, 'offered amount type') };
  const terms = paymentTerms(data);
  const body = { type: 'PAYMENT', accountToken, date: paymentDate, idempotencyKey, methodId, optionIdentifier, value: money };
  return { phase: 'review_required', version: 1, body, requestHash: termsDigest(body), terms, termsHash: termsDigest(terms),
    review: { amount: copy(money), date: paymentDate,
      method: { name: method.name ?? null, detail: method.detail ?? null, selectedDetail: method.selectedDetail ?? null },
      amountOption: { label: option.label ?? null, identifier: amountOptionId },
      scheduledPayments: copy(data.scheduledPayments ?? null), terms: copy(terms) } };
}
export function buildPaymentSubmit({ prepared, confirm = false, acceptTerms } = {}) {
  if (confirm !== true) throw new TypeError('Explicit payment confirmation is required');
  if (!object(prepared) || prepared.phase !== 'review_required' || prepared.version !== 1 || !object(prepared.body) || prepared.body.type !== 'PAYMENT') throw new TypeError('A prepared native payment review is required');
  if (acceptTerms !== prepared.termsHash || acceptTerms !== termsDigest(prepared.terms)) throw new TypeError('Exact reviewed payment terms must be accepted');
  if (prepared.requestHash !== termsDigest(prepared.body)) throw new TypeError('The prepared payment request changed');
  const body = copy(prepared.body);
  for (const key of ['accountToken', 'date', 'idempotencyKey', 'methodId']) requiredText(body[key], key);
  calendarDate(body.date, 'payment date'); decimalMoney(body.value); atLeastZero(body.value);
  if (!object(body.optionIdentifier) || !['OPTION_ID', 'OPTION_TYPE'].includes(body.optionIdentifier.type)) throw new TypeError('Missing native amount option identifier');
  requiredText(body.optionIdentifier.value, 'amount option value');
  return { method: 'PUT', path: '/services/payment/v3/submit', body, sensitive: true, retry: false, financialMutation: true };
}
export function parsePaymentSubmission(response) {
  const gate = responseGate(response); if (gate.phase !== 'ready') return gate;
  if (!object(response.data) || response.data.type !== 'PAYMENT') return { phase: 'unknown', reason: 'unrecognized_payment_submission', data: copy(response.data ?? null) };
  if (typeof response.data.title !== 'string' || !Array.isArray(response.data.paymentRows)) return { phase: 'unknown', reason: 'missing_native_payment_result', data: copy(response.data) };
  // Accepted by the payment endpoint is not a claim that funds have settled.
  return { phase: 'submitted', submitted: true, settled: false, data: copy(response.data) };
}
export function preparePaymentCancellation({ accountToken, inquiry, paymentID } = {}) {
  requiredText(accountToken, 'account token'); requiredText(paymentID, 'scheduled payment ID');
  const data = sourceInquiry(inquiry);
  if (!['CLASSIC', 'UPLIFTED'].includes(data.scheduledPayments?.type) || !Array.isArray(data.scheduledPayments?.payments)) return action('unsupported_scheduled_payments_branch');
  const payment = single(data.scheduledPayments.payments, item => item.paymentID === paymentID, 'scheduled payment');
  // A dismiss/CANCEL button alone does not establish cancellation eligibility.
  const deleteAction = object(payment.deletePayment)
    || (Array.isArray(payment.managePayment?.actions) && payment.managePayment.actions.some(item => item?.actionType === 'DELETE'));
  if (!deleteAction) return action('no_offered_delete_payment_action');
  const terms = copy({ payment, cancelPayment: data.paymentScreens?.cancelPayment ?? null });
  return { phase: 'review_required', version: 1, accountToken, paymentID, requestHash: termsDigest({ accountToken, paymentID }), terms, termsHash: termsDigest(terms), review: copy(terms) };
}
export function buildPaymentCancellation({ prepared, confirm = false, acceptTerms } = {}) {
  if (confirm !== true || prepared?.phase !== 'review_required' || prepared?.version !== 1) throw new TypeError('An explicitly confirmed cancellation review is required');
  if (acceptTerms !== prepared.termsHash || acceptTerms !== termsDigest(prepared.terms)) throw new TypeError('Exact reviewed cancellation terms must be accepted');
  if (prepared.requestHash !== termsDigest({ accountToken: prepared.accountToken, paymentID: prepared.paymentID })) throw new TypeError('The prepared cancellation target changed');
  return { method: 'DELETE', path: `/services/payment/v1/payments/${encodeURIComponent(requiredText(prepared.paymentID, 'scheduled payment ID'))}`,
    headers: { 'x-axp-account-token': requiredText(prepared.accountToken, 'account token') }, sensitive: true, retry: false, financialMutation: true };
}
export function parsePaymentCancellation(response) {
  const gate = responseGate(response); if (gate.phase !== 'ready') return gate;
  if (!object(response.data) || response.data.type !== 'SUCCESS' || typeof response.data.body !== 'string') return { phase: 'unknown', reason: 'missing_native_cancellation_result', data: copy(response.data ?? null) };
  return { phase: 'cancellation_accepted', cancelled: true, data: copy(response.data) };
}
