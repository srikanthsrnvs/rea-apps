import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airbnb-booking-'));
process.env.AIRBNB_STATE_DIR = directory;
const { prepareBooking, confirmBooking, bookingStatus } = await import('../src/booking.mjs');
const { saveState, readState } = await import('../src/state.mjs');
const originalFetch = globalThis.fetch;
const card = { __typename: 'QuickPayPaymentOption', gibraltarInstrumentToken: 'private-instrument', gibraltarInstrumentType: 'CREDIT_CARD',
  displayName: 'Visa ending 0123', isExistingInstrument: true, isCvvRequiredForPayment: false, isValidForCurrency: true,
  creditCardDetails: { expired: false, lastFour: '0123', cardType: 'VISA', threeDSecure2Details: null }, paymentOptionInputInfo: null, errorDetail: null };
const quote = () => ({ data: { startStayCheckoutFlow: { stayCheckout: { sections: {
  metadata: { bookingQuoteId: 'quote', orderId: 'order', bookingAttemptId: 'attempt', confirmationCode: 'DRAFTCODE' },
  sectionMetadata: { errorData: null },
  temporaryQuickPayData: { bootstrapPayments: { billData: { paymentQuoteId: '1801580046660776048' },
    paymentOptions: { paymentOptions: [card] }, productPriceBreakdown: { priceBreakdown: { priceItems: [], total: { total: { amountMicros: '653660000', currency: 'USD', amountFormatted: '$653.66' } } } } } },
  sectionConfiguration: { data: [{ sectionData: { __typename: 'CheckoutProductDetailSection', productListingDetails: { title: 'Example stay' } } },
    { sectionData: { __typename: 'TermsAndConditionsSection', cancellationModalData: { title: 'Non-refundable reservation' } } },
    { sectionData: { __typename: 'FirstMessageSection', title: 'Message the host', subtitle: 'Tell the host about your stay.' } }] },
} } } } });
const options = { listingId: '123', checkin: '2027-01-10', checkout: '2027-01-12', adults: 2, currency: 'USD' };
async function reset() {
  for (const file of await fs.readdir(directory)) await fs.rm(path.join(directory, file), { recursive: true, force: true });
  await saveState('session', { token: 'session', userId: '123' });
  await saveState('request-context', { everestDeviceId: 'device', everestExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
}
test('booking review and guarded submission', async t => {
  try {
    await t.test('review uses checkout totals and only an approved exact submission can be sent once', async () => {
      await reset(); let posts = 0;
      globalThis.fetch = async (_url, wire) => {
        const body = JSON.parse(wire.body);
        if (body.operationName === 'stayCheckout') return Response.json(quote());
        posts++;
        assert.equal(body.operationName, 'CheckoutFulfillmentMutation');
        assert.match(wire.body, /"paymentQuoteId":1801580046660776048/);
        assert.equal(body.variables.input.placeOrder.productDetails[0].stayDetails.messageToHost, 'Approved host note.');
        return Response.json({ data: { checkoutFulfillment: { result: { __typename: 'CheckoutFulfillmentPlaceOrderResult', orderId: 'order', error: null, bookingOutcome: { status: 'SUCCESS' } } } } });
      };
      const review = await prepareBooking(options);
      assert.equal(review.total.amountMicros, '653660000');
      assert.equal(review.paymentOptions[0].supported, true);
      assert.ok(!JSON.stringify(review).includes('private-instrument'));
      const args = { reviewId: review.reviewId, paymentOption: 'payment-1', maxTotal: '653.66', currency: 'USD', acceptTerms: review.termsHash, messageToHost: 'Approved host note.', confirm: true };
      for (const [patch, code] of [[{ confirm: false }, 'CONFIRMATION_REQUIRED'], [{ maxTotal: '653.65' }, 'PRICE_LIMIT_EXCEEDED'], [{ currency: 'EUR' }, 'PRICE_LIMIT_EXCEEDED'], [{ acceptTerms: 'wrong' }, 'TERMS_REVIEW_REQUIRED'], [{ paymentOption: 'payment-2' }, 'PAYMENT_ACTION_REQUIRED'], [{ messageToHost: undefined }, 'HOST_MESSAGE_REQUIRED']]) {
        await assert.rejects(confirmBooking({ ...args, ...patch }), { code });
      }
      assert.equal(posts, 0);
      const result = await confirmBooking(args);
      assert.equal(result.confirmed, true);
      assert.deepEqual(await confirmBooking(args), result);
      assert.equal(posts, 1);
      assert.equal((await bookingStatus({ reviewId: review.reviewId })).confirmed, true);
      assert.equal((await fs.stat(path.join(directory, `booking-review-${review.reviewId}.json`))).mode & 0o777, 0o600);
      const duplicate = await prepareBooking(options);
      await assert.rejects(confirmBooking({ ...args, reviewId: duplicate.reviewId, acceptTerms: duplicate.termsHash }), { code: 'BOOKING_ALREADY_ATTEMPTED' });
      assert.equal(posts, 1);
    });
    await t.test('expired quotes and account changes cannot place orders', async () => {
      await reset(); let posts = 0;
      globalThis.fetch = async () => { posts++; return Response.json(quote()); };
      const review = await prepareBooking(options), name = `booking-review-${review.reviewId}`;
      const args = { reviewId: review.reviewId, paymentOption: 'payment-1', maxTotal: '653.66', currency: 'USD', acceptTerms: review.termsHash, messageToHost: 'Approved host note.', confirm: true };
      const state = await readState(name); state.expiresAt = Date.now() - 1; await saveState(name, state);
      await assert.rejects(confirmBooking(args), { code: 'REVIEW_EXPIRED' });
      await saveState('session', { token: 'different', userId: '456' });
      await assert.rejects(confirmBooking(args), { code: 'REVIEW_NOT_FOUND' });
      assert.equal(posts, 1);
    });
    await t.test('lost fulfillment responses remain unknown and cannot be replayed', async () => {
      await reset(); let posts = 0;
      globalThis.fetch = async (_url, wire) => {
        if (JSON.parse(wire.body).operationName === 'stayCheckout') return Response.json(quote());
        posts++; throw Error('connection lost');
      };
      const review = await prepareBooking(options);
      const args = { reviewId: review.reviewId, paymentOption: 'payment-1', maxTotal: '653.66', currency: 'USD', acceptTerms: review.termsHash, messageToHost: 'Approved host note.', confirm: true };
      await assert.rejects(confirmBooking(args), { code: 'NETWORK_UNCERTAIN' });
      assert.equal((await confirmBooking(args)).outcome, 'unknown');
      assert.equal((await bookingStatus({ reviewId: review.reviewId })).outcome, 'unknown');
      assert.equal(posts, 1);
    });
    await t.test('unknown or frozen checkout sections cannot submit payment', async () => {
      for (const section of [{ __typename: 'FutureIdentitySection' }, { __typename: 'ConfirmAndPaySection', freezeDetails: { title: 'Identity required' } }]) {
        await reset(); let posts = 0;
        globalThis.fetch = async (_url, wire) => {
          assert.equal(JSON.parse(wire.body).operationName, 'stayCheckout'); posts++;
          const body = quote(); body.data.startStayCheckoutFlow.stayCheckout.sections.sectionConfiguration.data.push({ sectionData: section });
          return Response.json(body);
        };
        const review = await prepareBooking(options);
        await assert.rejects(confirmBooking({ reviewId: review.reviewId, paymentOption: 'payment-1', maxTotal: '653.66', currency: 'USD', acceptTerms: review.termsHash, messageToHost: 'Approved note.', confirm: true }), { code: 'CHECKOUT_ACTION_REQUIRED' });
        assert.equal(posts, 1);
      }
    });
  } finally { globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); }
});
