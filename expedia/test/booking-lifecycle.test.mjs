import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'expedia-booking-test-'));
process.env.EXPEDIA_CLI_STATE_DIR = directory;
const { saveState, readState, removeState } = await import('../src/state.mjs');
const { checkoutFromApolloState, parseCheckoutApolloState } = await import('../src/checkout-protocol.mjs');
const { prepareBooking, confirmBooking, inspectOperation, updateCardPayment } = await import('../src/booking.mjs');
const { recordOwner, flightDetails, selectFare } = await import('../src/flights.mjs');
const { prepareCheckout, inspectCheckout, submitCheckoutForm } = await import('../src/checkout.mjs');
const originalFetch = globalThis.fetch;
test.after(async () => { globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); });
function fixture({ id = randomUUID(), amount = 123.45 } = {}) {
  const context = { locale: 'en_US', siteId: 1, device: { type: 'APP_PHONE' }, identity: { duaid: 'local-test-only' } };
  const state = { ROOT_QUERY: {
    [`checkout(${JSON.stringify({ context })})`]: { [`getSession(${JSON.stringify({ sessionID: id })})`]: { token: 'test-session-token', productLine: 'FLIGHT' } },
    [`priceDetails(${JSON.stringify({ context, sessionId: id })})`]: { pricePresentation: { text: 'Flight total' }, trackingData: { totalPriceAmount: amount, totalPriceCurrencyCode: 'USD' } },
    [`smartForm(${JSON.stringify({ sessionId: id, type: 'CONTACT_INFORMATION' })})`]: { view: { __typename: 'SmartFormTextInputComponent', inputId: 'traveler-name||checkout-private-suffix', label: 'Traveler name', value: 'Old prefill', required: true } },
    [`paymentModule(${JSON.stringify({ sessionId: id })})`]: { instruments: [{ __typename: 'PaymentInstrument', fopId: 'card', state: 'STATE_SELECTED', paymentMethod: 'CREDIT_CARD' }] },
    'productSummary({})': { text: 'Example Flight 10 LAX to SFO October 22, 2026, 10:00am' },
  } };
  const url = `https://www.expedia.com/checkout/session/${id}?productLine=FLIGHT`;
  const plugins = { context: { context: { deviceId: 'local-test-only' } }, 'experiment-store': { experimentStore: { exposures: { HYBRID_CHECKOUT_PASS_EMPTY_TRUST_PAYLOAD: { bucket: 1 } } } } };
  const html = `<script>window.__APOLLO_STATE__ = JSON.parse(${JSON.stringify(JSON.stringify(state))}); window.__PLUGIN_STATE__ = JSON.parse(${JSON.stringify(JSON.stringify(plugins))});</script>`;
  return { state, checkout: checkoutFromApolloState(parseCheckoutApolloState(html), url), html };
}
async function record(f) {
  await removeState('session');
  await saveState('anonymous', { context: f.checkout.context, cookies: [] });
  const id = randomUUID();
  await saveState(`checkout-${id}`, { id, owner: recordOwner(f.checkout.context), detailId: randomUUID(), checkout: f.checkout, expiresAt: new Date(Date.now() + 600000).toISOString(), validatedForms: ['CONTACT_INFORMATION'], formValues: { CONTACT_INFORMATION: { 'traveler-name||checkout-private-suffix': 'Test Traveler' } }, paymentReceipt: { state: 'updated', paymentOptionId: 'card', last4: '4242' } });
  return id;
}
function mock(f, { loseBook = false, pending = false } = {}) {
  const counts = { book: 0, status: 0, all: 0 };
  globalThis.fetch = async (url, options) => {
    counts.all++;
    if (options.method === 'GET') return new Response(f.html, { headers: { 'content-type': 'text/html' } });
    const request = JSON.parse(options.body);
    if (request.operationName === 'GetSessionInfo') return Response.json({ data: { checkout: { getSession: { token: 'new-token' } } } });
    if (request.operationName === 'BookMutation') {
      counts.book++;
      if (loseBook) throw new Error('Connection dropped after server may have purchased');
      return Response.json({ data: { book: { data: { orderId: 'order-id', orderNumber: 'order-number', signals: [{ signal: pending ? 'PENDING_CONFIRMATION' : 'BOOKING_SUCCESS' }] } } } });
    }
    if (request.operationName === 'RedirectOrderStatusQuery') { counts.status++; return Response.json({ data: { confirmationSummary: { orderStatus: 'SUCCESS' } } }); }
    throw new Error('Unexpected request');
  };
  return counts;
}
test('incomplete checkout and missing explicit confirmation cannot submit a purchase', async () => {
  const f = fixture(), id = await record(f), counts = mock(f);
  const saved = await readState(`checkout-${id}`); saved.validatedForms = [];
  await saveState(`checkout-${id}`, saved);
  assert.equal((await prepareBooking({ checkoutId: id })).status, 'input_required');
  await assert.rejects(confirmBooking({ planId: randomUUID() }), { code: 'APPROVAL_REQUIRED' });
  assert.equal(counts.all, 0);
});
test('a changed live fare requires a new review and sends no purchase request', async () => {
  const f = fixture(), id = await record(f);
  const plan = await prepareBooking({ checkoutId: id });
  const counts = mock(fixture({ id: f.checkout.sessionId, amount: 125.00 }));
  assert.equal((await confirmBooking({ planId: plan.planId, confirm: true })).status, 'review_required');
  assert.equal(counts.book, 0);
});
test('uncertain purchases are durably recorded and never replayed, including a second checkout', async () => {
  const f = fixture(), id = await record(f), plan = await prepareBooking({ checkoutId: id });
  const counts = mock(f, { loseBook: true });
  const [first, concurrent] = await Promise.all([
    confirmBooking({ planId: plan.planId, confirm: true }),
    confirmBooking({ planId: plan.planId, confirm: true }),
  ]);
  assert.equal(first.status, 'outcome_unknown');
  assert.equal(concurrent.operationId, first.operationId);
  assert.equal((await readState(`checkout-${id}`)).bookingPhase, 'outcome_unknown');
  assert.equal((await confirmBooking({ planId: plan.planId, confirm: true })).operationId, first.operationId);
  const second = fixture(), secondId = await record(second), secondPlan = await prepareBooking({ checkoutId: secondId });
  mock(second, { loseBook: true });
  const duplicate = await confirmBooking({ planId: secondPlan.planId, confirm: true });
  assert.equal(duplicate.operationId, first.operationId);
  assert.equal(counts.book, 1);
  assert.equal((await inspectOperation({ operationId: first.operationId, refresh: true })).status, 'outcome_unknown');
});

test('approval presents submitted traveler values rather than stale checkout prefills', async () => {
  const f = fixture(), id = await record(f);
  const saved = await readState(`checkout-${id}`);
  saved.checkout.forms[0].view = { fields: [
    saved.checkout.forms[0].view,
    { __typename: 'SmartFormSelectInputComponent', inputId: 'traveler-gender||private', label: 'Gender', options: [{ label: 'Female', value: 'F' }, { label: 'Male', value: 'M' }] },
    { __typename: 'SmartFormTextInputComponent', inputId: 'contact-email||private', label: 'Email' },
  ] };
  saved.formValues.CONTACT_INFORMATION['traveler-gender||private'] = ['F'];
  saved.formValues.CONTACT_INFORMATION['contact-email||private'] = 'traveler@example.test';
  await saveState(`checkout-${id}`, saved);
  const result = await prepareBooking({ checkoutId: id });
  const fields = result.review.travelerContact[0].fields;
  assert.deepEqual(fields, [
    { key: 'traveler-name', label: 'Traveler name', value: 'Test Traveler' },
    { key: 'traveler-gender', label: 'Gender', value: ['Female'] },
    { key: 'contact-email', label: 'Email', value: 'traveler@example.test' },
  ]);
  assert.equal(JSON.stringify(result.review).includes('Old prefill'), false);
  assert.equal(JSON.stringify(result.review).includes('checkout-private-suffix'), false);
  assert.equal(JSON.stringify(result.review).includes('session-token'), false);
});

test('a changed login cannot reuse offers, details, checkouts, approvals or booking results', async () => {
  const f = fixture(), id = await record(f), saved = await readState(`checkout-${id}`);
  const plan = await prepareBooking({ checkoutId: id });
  const offerId = randomUUID(), detailId = randomUUID(), operationId = randomUUID();
  const bound = { owner: saved.owner, expiresAt: saved.expiresAt };
  await saveState(`offer-${offerId}`, bound);
  await saveState(`detail-${detailId}`, bound);
  await saveState(`operation-${operationId}`, { owner: saved.owner, checkoutId: id, status: 'outcome_unknown' });
  await saveState('session', { context: { ...f.checkout.context, identity: { ...f.checkout.context.identity, authState: 'AUTHENTICATED', tuid: 'another-account', expUserId: 'another-user' } }, cookies: [] });
  const inputFile = path.join(directory, 'form.json'), cardFile = path.join(directory, 'card.json');
  await fs.writeFile(inputFile, '[]'); await fs.writeFile(cardFile, '{}');
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Cross-account request escaped'); };
  const actions = [
    () => flightDetails({ offerId }), () => selectFare({ detailId, fareIndex: 0 }),
    () => prepareCheckout({ detailId }), () => inspectCheckout({ checkoutId: id }),
    () => submitCheckoutForm({ checkoutId: id, type: 'CONTACT_INFORMATION', inputFile }),
    () => updateCardPayment({ checkoutId: id, paymentOptionId: 'card', cardFile }),
    () => prepareBooking({ checkoutId: id }), () => confirmBooking({ planId: plan.planId, confirm: true }),
    () => inspectOperation({ operationId, refresh: true }),
  ];
  for (const action of actions) await assert.rejects(action, { code: 'SELECTION_OWNER_CHANGED' });
  assert.equal(requests, 0);
  await removeState('session');
  // Unbound historical records also fail closed instead of adopting a new owner.
  delete saved.owner; await saveState(`checkout-${id}`, saved);
  await assert.rejects(inspectCheckout({ checkoutId: id }), { code: 'SELECTION_OWNER_CHANGED' });
});

test('all submission phases freeze traveler and payment mutations without another request', async () => {
  const f = fixture(), id = await record(f);
  const inputFile = path.join(directory, 'frozen-form.json'), cardFile = path.join(directory, 'frozen-card.json');
  await fs.writeFile(inputFile, '[]'); await fs.writeFile(cardFile, '{}');
  let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('Frozen checkout mutated'); };
  for (const phase of ['submission_pending', 'submitted', 'outcome_unknown']) {
    const saved = await readState(`checkout-${id}`); saved.bookingPhase = phase;
    await saveState(`checkout-${id}`, saved);
    await assert.rejects(submitCheckoutForm({ checkoutId: id, type: 'CONTACT_INFORMATION', inputFile }), { code: 'BOOKING_ALREADY_SUBMITTED' });
    await assert.rejects(updateCardPayment({ checkoutId: id, paymentOptionId: 'card', cardFile }), { code: 'BOOKING_ALREADY_SUBMITTED' });
    await assert.rejects(prepareBooking({ checkoutId: id }), { code: 'BOOKING_ALREADY_SUBMITTED' });
  }
  assert.equal(requests, 0);
});

test('checkout preparation rejects partial validation errors and required server actions', async () => {
  const f = fixture(), id = await record(f), saved = await readState(`checkout-${id}`);
  const detailId = randomUUID();
  await saveState(`detail-${detailId}`, { owner: saved.owner, expiresAt: saved.expiresAt,
    priceSummary: { priceSummary: { buttonAction: { relativeURI: { value: '/checkout-redirect?action=UnifiedDetailsWidget%40statelessBook&offerToken=test-only' } } } },
  });
  for (const validation of [
    { data: { checkout: { getSession: { token: 'partial-token' } } }, errors: [{ message: 'Validation incomplete' }] },
    { data: { checkout: { getSession: { token: 'action-token', serverSignals: [{ signal: 'USER_ACTION_REQUIRED' }] } } } },
  ]) {
    globalThis.fetch = async (url, options) => options.method === 'GET'
      ? new URL(url).pathname === '/checkout-redirect'
        ? new Response(null, { status: 302, headers: { location: f.checkout.checkoutUrl } })
        : new Response(f.html, { headers: { 'content-type': 'text/html' } })
      : Response.json(validation);
    await assert.rejects(prepareCheckout({ detailId }), { code: validation.errors ? 'CHECKOUT_VALIDATION_FAILED' : 'CHECKOUT_ACTION_REQUIRED' });
  }
});

test('form signals and missing session confirmation cannot mark traveler details validated', async () => {
  const f = fixture(), id = await record(f);
  const inputFile = path.join(directory, 'action-form.json');
  await fs.writeFile(inputFile, JSON.stringify([{ inputId: 'traveler-name||checkout-private-suffix', value: 'Test Traveler' }]));
  for (const result of [
    { success: true, sessionToken: 'rotated-token', signals: [{ signal: 'USER_ACTION_REQUIRED' }] },
    { success: true },
  ]) {
    globalThis.fetch = async () => Response.json({ data: { smartForm: { updateFormData: result } } });
    const response = await submitCheckoutForm({ checkoutId: id, type: 'CONTACT_INFORMATION', inputFile });
    assert.equal(response.status, result.signals ? 'action_required' : 'validation_required');
    const saved = await readState(`checkout-${id}`);
    assert.equal(saved.validatedForms.includes('CONTACT_INFORMATION'), false);
    assert.equal((await prepareBooking({ checkoutId: id })).status, 'input_required');
  }
});
test('pending orders use the status query, and accepted bookings do not claim issued tickets', async () => {
  const f = fixture(), id = await record(f);
  // Distinct passenger avoids intentionally triggering the previous duplicate-intent guard.
  const saved = await readState(`checkout-${id}`); saved.formValues.CONTACT_INFORMATION['traveler-name||checkout-private-suffix'] = 'Second Test Traveler'; await saveState(`checkout-${id}`, saved);
  const plan = await prepareBooking({ checkoutId: id }), counts = mock(f, { pending: true });
  const result = await confirmBooking({ planId: plan.planId, confirm: true });
  assert.equal(result.status, 'pending');
  const refreshed = await inspectOperation({ operationId: result.operationId, refresh: true });
  assert.equal(refreshed.status, 'booked'); assert.equal(refreshed.ticketingStatus, 'unverified');
  assert.equal(counts.book, 1); assert.equal(counts.status, 1);
});
