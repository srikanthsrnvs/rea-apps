import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createPayments } from '../src/payment.mjs';

const clone = value => structuredClone(value);
const cash = amount => ({ amount, currency: 'USD' });
const CARD = { id: 'card-000000000000000000000001', productName: 'Test Card', ending: '••10001' };
const BINDING = { cardId: 'test-native-card', sortedIndex: 3, accountToken: 'test-account-secret' };
function sourceInquiry(requestId = 'test-server-request') { return { status: { success: true }, data: {
  type: 'MAKE_PAYMENT', paymentRequestId: requestId,
  paymentMethods: { type: 'AVAILABLE', options: [{ type: 'ACTIVE', paymentMethodId: 'test-native-bank', paymentAccountToken: 'test-bank-secret', name: 'Test Bank', detail: '••0001' }], termsAndConditions: { text: 'Test bank terms' } },
  paymentAmounts: { defaultOptions: { minimumPaymentAmount: { value: cash('1.00') }, maximumPaymentAmount: { value: cash('1000.00') }, amountOptions: [
    { optionType: 'DEFAULT', identifier: 'test-option-minimum', type: 'MINIMUM', label: 'Minimum', value: cash('25.00'), isEnabled: true, isEditable: false },
    { optionType: 'DEFAULT', type: 'OTHER', label: 'Other amount', value: cash('0.00'), isEnabled: true, isEditable: true },
  ] } },
  paymentDates: { options: [{ type: 'FIXED_DATE', value: '2026-10-21', isEnabledForMakePayment: true }], range: { minimumDate: '2026-10-21', maximumDate: '2026-11-21' } },
  paymentScreens: { makePayment: { title: 'Test payment terms' }, cancelPayment: { message: 'Cancel this test scheduled payment?' } },
  scheduledPayments: { type: 'CLASSIC', payments: [{ paymentID: 'test-native-payment', paymentMethodId: 'test-native-bank', paymentAmount: { value: '$25.00' }, paymentDate: { value: '2026-10-22' }, deletePayment: { title: 'Cancel', message: 'Test cancellation terms' } }] },
} }; }
function harness({ outcome, onSubmit, requestId, failSave } = {}) {
  const state = new Map([
    ['session', { ownerId: 'owner-test', validated: true, validatedAt: '2026-10-21T18:00:00Z' }],
    ['account-cache', { ownerId: 'owner-test', records: [{ id: CARD.id, card: CARD, binding: clone(BINDING) }] }],
  ]);
  let timestamp = Date.parse('2026-10-21T18:00:00Z'); let sequence = 0;
  const scope = new AsyncLocalStorage(); let tail = Promise.resolve();
  const calls = [];
  const tools = createPayments({
    read: async name => clone(state.get(name) ?? null), save: async (name, value) => { if (failSave?.(name, value)) throw new Error('Test durable write failure'); state.set(name, clone(value)); },
    lock: async operation => {
      assert.notEqual(scope.getStore(), 'locked', 'No nested global lock');
      const previous = tail; let release; tail = new Promise(resolve => { release = resolve; });
      await previous; try { return await scope.run('locked', operation); } finally { release(); }
    },
    now: () => timestamp, uuid: () => `00000000-0000-4000-9000-${String(++sequence).padStart(12, '0')}`,
    selectCard: async card => { assert.notEqual(scope.getStore(), 'locked', 'Resolve cards outside the global lock'); if (card !== undefined) assert.equal(card, CARD.id); return { session: clone(state.get('session')), card: clone(CARD), binding: clone(state.get('account-cache').records[0].binding) }; },
    clientFactory: async ({ session }) => ({
      request: async spec => { calls.push(clone(spec)); return sourceInquiry(typeof requestId === 'function' ? requestId() : requestId); },
      response: async spec => {
        assert.equal(scope.getStore(), 'locked', 'Financial requests hold the global journal lock');
        const intent = [...state.entries()].find(([name]) => name.includes('-intent-'));
        assert.ok(intent, 'Durable semantic intent exists before the mutation');
        assert.equal(intent[1].outcome.phase, 'unknown');
        const review = state.get(`${intent[1].type}-review-${intent[1].reviewId}`);
        assert.equal(review.phase, 'unknown');
        assert.equal(review.request.method, spec.method);
        assert.equal(session.ownerId, 'owner-test'); calls.push(clone(spec));
        if (onSubmit) return onSubmit(spec, state);
        return outcome ?? { status: 200, headers: {}, body: spec.method === 'DELETE'
          ? { status: { success: true }, data: { type: 'SUCCESS', body: 'Test cancelled' } }
          : { status: { success: true }, data: { type: 'PAYMENT', title: 'Test accepted', paymentRows: [{ label: 'Amount', value: '$25.00' }] } } };
      },
    }),
  });
  return { tools, state, calls, advance: duration => { timestamp += duration; } };
}
async function paymentReview(h, options = {}) {
  const available = await h.tools.paymentOptions({ card: CARD.id });
  const review = await h.tools.previewPayment({ inquiryId: available.inquiryId, method: 'method-1', amountOption: 'amount-1', date: '2026-10-21', ...options });
  return { available, review };
}
function approval(review) { return { reviewId: review.reviewId, amount: review.amount.amount, currency: review.amount.currency, date: review.date, acceptTerms: review.termsHash, confirm: true }; }
const finalCalls = h => h.calls.filter(spec => ['PUT', 'DELETE'].includes(spec.method));

test('payment options use local aliases and keep server tokens, IDs and idempotency private', async () => {
  const h = harness(); const { available, review } = await paymentReview(h);
  assert.equal(available.methods[0].id, 'method-1'); assert.equal(available.methods[0].amountOptions[0].id, 'amount-1');
  assert.equal(available.scheduledPayments[0].id, 'payment-1'); assert.equal(review.phase, 'review_required'); assert.deepEqual(review.amount, cash('25.00'));
  const output = JSON.stringify({ available, review });
  for (const privateValue of ['test-account-secret', 'test-native-card', 'test-native-bank', 'test-bank-secret', 'test-native-payment', 'test-server-request', 'test-option-minimum']) assert.equal(output.includes(privateValue), false);
  const stored = h.state.get(`payment-review-${review.reviewId}`);
  assert.equal(stored.prepared.body.idempotencyKey, 'test-server-request'); assert.equal(stored.prepared.body.methodId, 'test-native-bank'); assert.equal(finalCalls(h).length, 0);
});

test('final payment requires the exact approved values, explicit confirm and exact terms', async () => {
  const h = harness(); const { review } = await paymentReview(h);
  for (const patch of [{ amount: '25.01' }, { currency: 'EUR' }, { date: '2026-10-22' }, { confirm: false }, { acceptTerms: 'other' }]) await assert.rejects(h.tools.confirmPayment({ ...approval(review), ...patch }));
  assert.equal(finalCalls(h).length, 0);
  const result = await h.tools.confirmPayment(approval(review));
  assert.equal(result.phase, 'submitted'); assert.equal(result.settled, false); assert.equal(result.statusSource, 'local_journal');
  assert.equal(finalCalls(h).length, 1); assert.equal(finalCalls(h)[0].body.idempotencyKey, 'test-server-request');
  assert.deepEqual(finalCalls(h)[0].body.value, cash('25.00'));
  const again = await h.tools.confirmPayment(approval(review)); assert.equal(again.phase, 'submitted'); assert.equal(finalCalls(h).length, 1);
  assert.equal((await h.tools.paymentStatus({ reviewId: review.reviewId })).phase, 'submitted');
});

test('semantic duplicate guard spans new inquiries, server request IDs and decimal spellings', async () => {
  let request = 0; const h = harness({ requestId: () => `test-server-request-${++request}` });
  const first = await paymentReview(h, { amountOption: 'amount-2', amount: '25.00' });
  await h.tools.confirmPayment(approval(first.review));
  const second = await paymentReview(h, { amountOption: 'amount-2', amount: '25.0' });
  await assert.rejects(h.tools.confirmPayment(approval(second.review)), error => error.code === 'AMEX_DUPLICATE_FINANCIAL_ACTION' && error.details.originalReviewId === first.review.reviewId);
  assert.equal(finalCalls(h).length, 1);
});

test('transport timeout is recorded unknown and cannot be replayed through a fresh review', async () => {
  const h = harness({ onSubmit: () => { const error = new Error('Test timeout'); error.code = 'NETWORK_UNCERTAIN'; throw error; } });
  const first = await paymentReview(h); const result = await h.tools.confirmPayment(approval(first.review));
  assert.equal(result.phase, 'unknown'); assert.equal(result.reason, 'financial_transport_outcome_unknown');
  await h.tools.confirmPayment(approval(first.review)); assert.equal(finalCalls(h).length, 1);
  const second = await paymentReview(h);
  await assert.rejects(h.tools.confirmPayment(approval(second.review)), { code: 'AMEX_DUPLICATE_FINANCIAL_ACTION' });
  assert.equal(finalCalls(h).length, 1);
});

test('inquiry and review expire after five minutes, and card/owner changes never submit', async () => {
  const h = harness(); const { available, review } = await paymentReview(h);
  h.advance(300_001);
  await assert.rejects(h.tools.previewPayment({ inquiryId: available.inquiryId, method: 'method-1', amountOption: 'amount-1', date: '2026-10-21' }), { code: 'AMEX_INQUIRY_EXPIRED' });
  await assert.rejects(h.tools.confirmPayment(approval(review)), { code: 'AMEX_REVIEW_EXPIRED' });
  const other = harness(); const fresh = await paymentReview(other);
  other.state.get('account-cache').records[0].binding.accountToken = 'test-new-account-binding';
  await assert.rejects(other.tools.confirmPayment(approval(fresh.review)), { code: 'AMEX_PAYMENT_BINDING_CHANGED' });
  other.state.get('session').ownerId = 'owner-other';
  await assert.rejects(other.tools.paymentStatus({ reviewId: fresh.review.reviewId }), { code: 'AMEX_ACCOUNT_CHANGED' });
  assert.equal(finalCalls(h).length + finalCalls(other).length, 0);
});

test('financial HTTP, native step-up and unknown unions never become submitted', async () => {
  for (const [outcome, expected] of [
    [{ status: 503, headers: {}, body: { status: { success: true }, data: { type: 'PAYMENT', title: 'Test', paymentRows: [] } } }, 'unknown'],
    [{ status: 200, headers: {}, body: { status: { success: true, secondaryAuthenticationV4: { type: 'OTP' } }, data: { type: 'PAYMENT', title: 'Test', paymentRows: [] } } }, 'action_required'],
    [{ status: 200, headers: {}, body: { status: { success: true }, data: { type: 'UNKNOWN' } } }, 'unknown'],
    [{ status: 200, headers: {}, body: { status: { success: false }, data: {} } }, 'failed'],
  ]) {
    const h = harness({ outcome }); const { review } = await paymentReview(h);
    assert.equal((await h.tools.confirmPayment(approval(review))).phase, expected);
    await h.tools.confirmPayment(approval(review)); assert.equal(finalCalls(h).length, 1);
  }
});

test('the authoritative intent journal survives a crash before review outcome is saved', async () => {
  const h = harness(); const { review } = await paymentReview(h);
  const record = h.state.get(`payment-review-${review.reviewId}`);
  h.state.set(`payment-intent-${record.intentKey}`, { version: 1, type: 'payment', ownerId: 'owner-test', reviewId: review.reviewId, sentAt: Date.parse('2026-10-21T18:00:00Z'), request: { method: 'PUT' }, outcome: { phase: 'unknown', reason: 'submission_started_outcome_not_recorded' } });
  assert.equal((await h.tools.paymentStatus({ reviewId: review.reviewId })).phase, 'unknown');
  await h.tools.confirmPayment(approval(review)); assert.equal(finalCalls(h).length, 0);
});

test('cancellation reviews bind offered scheduled IDs and send one exact DELETE', async () => {
  const h = harness(); const available = await h.tools.paymentOptions({ card: CARD.id });
  const review = await h.tools.previewCancellation({ inquiryId: available.inquiryId, payment: 'payment-1' });
  assert.equal(review.phase, 'review_required'); assert.equal(JSON.stringify(review).includes('test-native-payment'), false);
  await assert.rejects(h.tools.confirmCancellation({ reviewId: review.reviewId, acceptTerms: review.termsHash, confirm: false }));
  const result = await h.tools.confirmCancellation({ reviewId: review.reviewId, acceptTerms: review.termsHash, confirm: true });
  assert.equal(result.phase, 'cancellation_accepted'); assert.equal(result.cancelled, true);
  assert.equal(finalCalls(h)[0].path, '/services/payment/v1/payments/test-native-payment');
  assert.equal(finalCalls(h)[0].headers['x-axp-account-token'], 'test-account-secret');
  await h.tools.confirmCancellation({ reviewId: review.reviewId, acceptTerms: review.termsHash, confirm: true }); assert.equal(finalCalls(h).length, 1);
  assert.equal((await h.tools.cancellationStatus({ reviewId: review.reviewId })).phase, 'cancellation_accepted');
  const next = await h.tools.previewCancellation({ inquiryId: available.inquiryId, payment: 'payment-1' });
  await assert.rejects(h.tools.confirmCancellation({ reviewId: next.reviewId, acceptTerms: next.termsHash, confirm: true }), { code: 'AMEX_DUPLICATE_FINANCIAL_ACTION' });
});


test('two concurrent confirmations serialize to a single financial request', async () => {
  const h = harness(); const { review } = await paymentReview(h);
  const [first, second] = await Promise.all([h.tools.confirmPayment(approval(review)), h.tools.confirmPayment(approval(review))]);
  assert.equal(first.phase, 'submitted'); assert.equal(second.phase, 'submitted'); assert.equal(finalCalls(h).length, 1);
});

test('a durable intent blocks replay even when writing the review journal fails before send', async () => {
  const h = harness({ failSave: (name, value) => name.startsWith('payment-review-') && value.phase === 'unknown' });
  const { review } = await paymentReview(h);
  await assert.rejects(h.tools.confirmPayment(approval(review)), /durable write failure/u);
  assert.equal(finalCalls(h).length, 0);
  assert.equal((await h.tools.paymentStatus({ reviewId: review.reviewId })).phase, 'unknown');
  const retry = await h.tools.confirmPayment(approval(review)); assert.equal(retry.phase, 'unknown'); assert.equal(finalCalls(h).length, 0);
});

test('stored HTTP response recovers native outcome without a new request', async () => {
  const h = harness(); const { review } = await paymentReview(h);
  const record = h.state.get(`payment-review-${review.reviewId}`);
  h.state.set(`payment-intent-${record.intentKey}`, { version: 1, type: 'payment', ownerId: 'owner-test', reviewId: review.reviewId, sentAt: Date.parse('2026-10-21T18:00:00Z'), response: { status: 200, headers: {}, body: { status: { success: true }, data: { type: 'PAYMENT', title: 'Test accepted', paymentRows: [] } } } });
  assert.equal((await h.tools.paymentStatus({ reviewId: review.reviewId })).phase, 'submitted');
  assert.equal((await h.tools.confirmPayment(approval(review))).phase, 'submitted'); assert.equal(finalCalls(h).length, 0);
});

test('native IDs cannot replace aliases, and post-review request tampering is rejected', async () => {
  const h = harness(); const { available, review } = await paymentReview(h);
  await assert.rejects(h.tools.previewPayment({ inquiryId: available.inquiryId, method: 'test-native-bank', amountOption: 'amount-1', date: '2026-10-21' }), { code: 'AMEX_SELECTION_REQUIRED' });
  h.state.get(`payment-review-${review.reviewId}`).prepared.body.value.amount = '900.00';
  await assert.rejects(h.tools.confirmPayment({ ...approval(review), amount: '900.00' }), /prepared payment request changed/u);
  assert.equal(finalCalls(h).length, 0);
});
