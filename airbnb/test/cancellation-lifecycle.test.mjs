import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airbnb-cancel-'));
process.env.AIRBNB_STATE_DIR = directory;
const { prepareCancellation, confirmCancellation, cancellationStatus, cancellationTerms, mergeCancellationRead } = await import('../src/cancellation.mjs');
const { saveState, readState } = await import('../src/state.mjs');
const originalFetch = globalThis.fetch;
const reasonId = 'DECLINE_REASON_GUEST_OTHER';
function fixture(amount = '$10.00') {
  return { data: { presentation: { cancellation: { title: 'Cancel reservation',
    callToActionButtons: [{ __typename: 'CancellationPrimaryButton', ctaText: 'Cancel reservation', action: null }],
    sections: { mainSectionPlacement: [{ sectionData: { __typename: 'CancellationProductOverviewSection', title: 'Synthetic stay' } },
      { sectionData: { __typename: 'CancellationReasonsSelectionSection', reasons: [{ reasonId, reasonText: 'Plans changed' }] } }],
    refundSectionPlacement: [{ sectionData: { __typename: 'CancellationPriceBreakdownSection', title: 'Refund',
      priceItems: [{ localizedTitle: 'Your refund', total: { amountFormatted: amount } }] } }] },
  } } } };
}
async function reset() {
  for (const file of await fs.readdir(directory)) await fs.rm(path.join(directory, file), { recursive: true, force: true });
  await saveState('session', { token: 'session', userId: '123' });
  await saveState('request-context', { everestDeviceId: 'device', everestExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
}
test('cancellation review only supports complete native reason/refund placements', () => {
  const terms = cancellationTerms(fixture(), reasonId);
  assert.equal(terms.eligible, true);
  assert.equal(terms.terms.refundSections[0].priceItems[0].total.amountFormatted, '$10.00');
  assert.equal(terms.refundAmountMicros, undefined);
  assert.throws(() => cancellationTerms(fixture(), 'GUESSED_REASON'), { code: 'INVALID_CANCELLATION_REASON' });
  assert.equal(cancellationTerms(fixture()).eligible, false);
  for (const change of [
    x => x.sections.mainSectionPlacement.push({ sectionData: { __typename: 'CancellationInterventionSection' } }),
    x => x.sections.refundSectionPlacement.push({ sectionData: { __typename: 'FutureRefundChoice' } }),
    x => { x.callToActionButtons[0].action = { url: 'https://example.invalid/support' }; },
    x => { x.callToActionButtons[0].__typename = 'FutureButton'; },
  ]) {
    const f = fixture(); change(f.data.presentation.cancellation);
    assert.equal(cancellationTerms(f, reasonId).eligible, false);
  }
});
test('refund-only reason refreshes merge with the current product review and empty or failed refreshes never enable confirm', () => {
  const initial = fixture(), refresh = fixture('$9.00');
  const cancellation = refresh.data.presentation.cancellation;
  delete cancellation.title; delete cancellation.callToActionButtons;
  cancellation.sections.mainSectionPlacement = [];
  const merged = cancellationTerms(mergeCancellationRead(initial, refresh), reasonId);
  assert.equal(merged.eligible, true);
  assert.equal(merged.terms.refundSections[0].priceItems[0].total.amountFormatted, '$9.00');
  assert.equal(merged.terms.mainSections[0].title, 'Synthetic stay');
  assert.equal(initial.data.presentation.cancellation.sections.refundSectionPlacement[0].sectionData.priceItems[0].total.amountFormatted, '$10.00');
  cancellation.sections.refundSectionPlacement = [];
  assert.throws(() => mergeCancellationRead(initial, refresh), { code: 'CANCELLATION_UNAVAILABLE' });
  assert.throws(() => mergeCancellationRead(initial, { ...fixture(), errors: [{ message: 'partial' }] }));
});
test('durable cancellation lifecycle', async t => {
  try {
    await t.test('explicit approval submits the exact offered reason once, with no invented refund choice', async () => {
      await reset(); let posts = 0;
      globalThis.fetch = async (_url, wire) => {
        if (!wire.body) return Response.json(fixture());
        posts++;
        assert.deepEqual(JSON.parse(wire.body).variables.request, { cancellationType: 'CANCEL_BY_CUSTOMER',
          productId: { identifier: 'SYNTHETIC', productType: 'STAY' }, reasonId });
        return Response.json({ data: { cancelProduct: { __typename: 'CancelProductSuccessResponse', success: true } } });
      };
      assert.equal((await prepareCancellation({ confirmationCode: 'SYNTHETIC' })).status, 'reason_required');
      const review = await prepareCancellation({ confirmationCode: 'SYNTHETIC', reasonId });
      const args = { reviewId: review.reviewId, acceptTerms: review.termsHash, confirm: true };
      await assert.rejects(confirmCancellation({ ...args, confirm: false }), { code: 'CONFIRMATION_REQUIRED' });
      await assert.rejects(confirmCancellation({ ...args, acceptTerms: 'wrong' }), { code: 'TERMS_REVIEW_REQUIRED' });
      assert.equal(posts, 0);
      const bookingId = '00000000-0000-0000-0000-000000000001';
      await saveState(`booking-review-${bookingId}`, { id: bookingId, owner: '123', preparation: { confirmationCode: 'SYNTHETIC' }, intent: 'booking-intent-synthetic' });
      await saveState('booking-intent-synthetic', { reviewId: bookingId, phase: 'confirmed' });
      const result = await confirmCancellation(args);
      assert.equal(result.confirmed, true);
      assert.deepEqual(await confirmCancellation(args), result);
      assert.equal((await cancellationStatus({ reviewId: review.reviewId })).confirmed, true);
      assert.equal((await readState('booking-intent-synthetic')).phase, 'cancelled');
      const next = await prepareCancellation({ confirmationCode: 'SYNTHETIC', reasonId });
      await assert.rejects(confirmCancellation({ ...args, reviewId: next.reviewId, acceptTerms: next.termsHash }), { code: 'CANCELLATION_ALREADY_ATTEMPTED' });
      assert.equal(posts, 1);
    });
    await t.test('changed refund terms, expired reviews and different accounts cannot cancel', async () => {
      await reset(); let changed = false, posts = 0;
      globalThis.fetch = async (_url, wire) => { if (wire.body) posts++; return Response.json(fixture(changed ? '$0.00' : '$10.00')); };
      const review = await prepareCancellation({ confirmationCode: 'SYNTHETIC', reasonId });
      const args = { reviewId: review.reviewId, acceptTerms: review.termsHash, confirm: true };
      changed = true;
      await assert.rejects(confirmCancellation(args), { code: 'CANCELLATION_TERMS_CHANGED' });
      const saved = await readState(`cancellation-review-${review.reviewId}`);
      saved.expiresAt = Date.now() - 1; await saveState(`cancellation-review-${review.reviewId}`, saved);
      await assert.rejects(confirmCancellation(args), { code: 'REVIEW_EXPIRED' });
      await saveState('session', { token: 'other', userId: '456' });
      await assert.rejects(confirmCancellation(args), { code: 'REVIEW_NOT_FOUND' });
      assert.equal(posts, 0);
    });
    await t.test('a lost cancellation response cannot be replayed from the same or another review', async () => {
      await reset(); let posts = 0;
      globalThis.fetch = async (_url, wire) => { if (!wire.body) return Response.json(fixture()); posts++; throw Error('lost response'); };
      const review = await prepareCancellation({ confirmationCode: 'SYNTHETIC', reasonId });
      const args = { reviewId: review.reviewId, acceptTerms: review.termsHash, confirm: true };
      await assert.rejects(confirmCancellation(args), { code: 'NETWORK_UNCERTAIN' });
      assert.equal((await confirmCancellation(args)).outcome, 'unknown');
      assert.equal((await cancellationStatus({ reviewId: review.reviewId })).confirmed, false);
      const next = await prepareCancellation({ confirmationCode: 'SYNTHETIC', reasonId });
      await assert.rejects(confirmCancellation({ ...args, reviewId: next.reviewId, acceptTerms: next.termsHash }), { code: 'CANCELLATION_ALREADY_ATTEMPTED' });
      assert.equal(posts, 1);
    });
    await t.test('a nonretryable rejection blocks fresh reviews while a retryable rejection still needs a fresh approval', async () => {
      for (const retryable of [false, true]) {
        await reset(); let posts = 0;
        globalThis.fetch = async (_url, wire) => {
          if (!wire.body) return Response.json(fixture());
          posts++;
          return Response.json({ data: { cancelProduct: { __typename: 'ProductCannotBeCanceledError', retryable, errorMessage: 'Synthetic rejection' } } });
        };
        const review = await prepareCancellation({ confirmationCode: 'SYNTHETIC', reasonId });
        const args = { reviewId: review.reviewId, acceptTerms: review.termsHash, confirm: true };
        assert.equal((await confirmCancellation(args)).outcome, 'failed');
        await confirmCancellation(args); assert.equal(posts, 1);
        const fresh = await prepareCancellation({ confirmationCode: 'SYNTHETIC', reasonId });
        const again = { ...args, reviewId: fresh.reviewId, acceptTerms: fresh.termsHash };
        if (retryable) assert.equal((await confirmCancellation(again)).outcome, 'failed');
        else await assert.rejects(confirmCancellation(again), { code: 'CANCELLATION_ALREADY_ATTEMPTED' });
        assert.equal(posts, retryable ? 2 : 1);
      }
    });
  } finally { globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); }
});
