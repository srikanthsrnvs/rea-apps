import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opentable-reservations-test-'));
process.env.OPENTABLE_CLI_STATE_DIR = stateRoot;
const api = await import('../src/reservations.mjs');
const { OpenTableError } = await import('../src/errors.mjs');
const { readState, saveState } = await import('../src/state.mjs');
test.after(async () => { await fs.rm(stateRoot, { recursive: true, force: true }); });
const clone = value => structuredClone(value);
const dt = '2027-04-20T19:00';
const slot = () => ({ dateTime: dt, available: true, requiresCreditCard: false, priceAmount: 0, token: 'native-slot-token', slotHash: '123456', points: 100, type: 'Standard', attributes: ['default', 'outdoor'] });
function venue() {
  return { id: 123, name: 'Synthetic Restaurant', currencyCode: 'USD', termsAndConditions: { message: 'Arrive on time.' }, availability: { dateTime: dt, availability: { id: '123', dateTime: dt, timeslots: [slot()], noTimesReasons: [], dateMessages: [{ message: 'Tables held for 15 minutes.', type: 'policies' }] } } };
}
const booking = () => ({ id: 17, confirmationNumber: 808, token: 'private-reservation-token', restaurant: { id: 123, name: 'Synthetic Restaurant', currencyCode: 'USD' }, dateTime: dt, partySize: 2, creditCard: false, reservationStatus: 'Upcoming' });
class Client {
  constructor() { this.token = 'synthetic-session-token'; this.user = { globalPersonId: 'synthetic-account', diners: [{ id: '456' }], reservations: { history: [] } }; this.venue = venue(); this.calls = []; this.onRequest = null; }
  async me() { this.calls.push({ endpoint: '/api/v3/user', method: 'GET' }); return clone(this.user); }
  async request(endpoint, options = {}) {
    const call = { endpoint, method: options.method ?? 'GET', ...clone(options) }; this.calls.push(call);
    const overridden = await this.onRequest?.(call);
    if (overridden !== undefined) return clone(overridden);
    if (endpoint === '/api/v3/restaurant/123') return clone(this.venue);
    if (endpoint.startsWith('/api/v5/personalize/search/')) return { results: [{ restaurant: clone(this.venue) }], total: 5, totalAvailable: 5 };
    if (endpoint === '/api/configuration/android_feature_config_v11.json') return clone(this.config ?? { shouldPromptForToS: 0 });
    if (endpoint.startsWith('/api/v3/user/history/')) return { history: [], totalCount: 0 };
    if (endpoint === '/api/v3/user/reservation') return clone(this.currentReservation ?? booking());
    if (endpoint === '/api/v3/reservation/123/lock' && call.method === 'POST') return clone(this.hold ?? { id: 'native-id-for-booking', lockId: 'different-lock-field', rid: '123', partySize: 2, date: dt });
    if (endpoint === '/api/v3/reservation/123/lock' && call.method === 'DELETE') return null;
    if (endpoint === '/api/v3/reservation/123' && call.method === 'POST') return clone(this.booked ?? booking());
    if (endpoint === '/api/v3/reservation/123/808' && call.method === 'DELETE') { this.currentReservation = { ...booking(), reservationStatus: 'Cancelled' }; return null; }
    throw new Error(`Unexpected synthetic request: ${call.method} ${endpoint}`);
  }
}
const writes = client => client.calls.filter(call => call.endpoint.startsWith('/api/v3/reservation/'));
async function prepare(client = new Client()) {
  const result = await api.availability(client, { restaurantId: '123', dateTime: dt });
  const plan = await api.prepareBooking(client, { restaurantId: '123', slotCursor: result.slots[0].slotId });
  return { client, result, plan };
}
async function cancelPlan(client = new Client()) {
  client.user.reservations.history = [booking()];
  const listed = await api.reservations(client);
  const plan = await api.prepareCancellation(client, { reservationId: listed.reservations[0].reservationId });
  return { client, listed, plan };
}
function uniqueClient() { const c = new Client(); c.user.globalPersonId = `account-${crypto.randomUUID()}`; return c; }

test('search uses observed native V5 read and returns paginated restaurants with private table selections', async () => {
  const c = new Client();
  const result = await api.search(c, { query: 'Synthetic', lat: 34, lon: -118, dateTime: dt, partySize: 3, page: 2, limit: 2 });
  assert.equal(c.calls[0].endpoint, '/api/v5/personalize/search/2');
  assert.equal(c.calls[0].method, 'POST'); assert.deepEqual(c.calls[0].query, { forcebannercheck: true });
  assert.equal(c.calls[0].json.covers, 3); assert.equal(c.calls[0].json.page, 2);
  assert.deepEqual(c.calls[0].json.location, { latitude: 34, longitude: -118 });
  assert.equal(result.nextPage, 3); assert.equal(result.restaurants[0].slots.length, 2);
  assert.equal(result.restaurants[0].slots[0].tableType, 'default');
  assert.equal(JSON.stringify(result).includes('native-slot-token'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-session-token'), false);
  const stored = await readState(`selection-${result.restaurants[0].slots[0].slotId}`);
  assert.equal(stored.slot.token, 'native-slot-token'); assert.equal(stored.context.partySize, 3);
});

test('table read uses proven restaurant GET, covers local datetime and distinguishes dining areas', async () => {
  const c = new Client();
  c.venue.availability.availability.timeslots[0].diningAreas = [{ id: '22', localizedName: 'Garden', environment: 'Outdoor', isDefaultArea: false, availableAttributes: ['outdoor'] }];
  const result = await api.availability(c, { restaurantId: '123', dateTime: dt, partySize: 4 });
  assert.equal(c.calls[0].method, 'GET'); assert.equal(c.calls[0].query.partySize, 4); assert.equal(c.calls[0].query.dateTime, dt);
  assert.equal(result.slots.length, 1); assert.equal(result.slots[0].diningArea.diningAreaId, '22'); assert.equal(result.slots[0].diningArea.name, 'Garden');
  assert.equal(result.slots[0].monetaryDivisor, null);
});

test('invalid IDs, dates, coordinates, parties, pages and malformed server responses fail safely', async () => {
  const c = new Client();
  for (const args of [{ restaurantId: '../123', dateTime: dt }, { restaurantId: '123', dateTime: '2027-02-30T19:00' }, { restaurantId: '123', dateTime: dt, partySize: 0 }]) await assert.rejects(api.availability(c, args), { code: 'INVALID_ARGUMENT' });
  assert.equal(c.calls.length, 0);
  await assert.rejects(api.search(c, { query: 'x', lat: 91, lon: 0, dateTime: dt }), { code: 'INVALID_ARGUMENT' });
  c.venue.availability.availability.id = '999';
  await assert.rejects(api.availability(c, { restaurantId: '123', dateTime: dt }), { code: 'PROTOCOL_CHANGED' });
});

test('reservation reads return proxy UUIDs, protect tokens and preserve high precision confirmation IDs', async () => {
  const c = new Client(), raw = booking(); raw.confirmationNumber = '900719925474099312345';
  c.user.reservations.history = [raw];
  c.onRequest = call => call.endpoint === '/api/v3/user/history/2' ? { history: [raw], totalCount: 41 } : undefined;
  const result = await api.reservations(c, { page: 2 });
  assert.equal(result.history[0].confirmationNumber, raw.confirmationNumber); assert.equal(result.nextPage, 3);
  assert.equal(result.totalHistoryCount, 41);
  assert.equal(JSON.stringify(result).includes('private-reservation-token'), false);
  const record = await readState(`reservation-${result.reservations[0].reservationId}`);
  assert.equal(record.securityToken, 'private-reservation-token');
});

test('booking preparation never holds inventory and binds restaurant, account, session, diner and local context', async () => {
  const { client: c, plan, result } = await prepare(uniqueClient());
  assert.equal(writes(c).length, 0); assert.equal(plan.review.dinerId, '456');
  assert.equal(plan.review.price.amount, 0); assert.equal(plan.review.price.divisor, null);
  await assert.rejects(api.prepareBooking(c, { restaurantId: '999', slotCursor: result.slots[0].slotId }), { code: 'INVALID_ARGUMENT' });
  c.token = 'different-token';
  await assert.rejects(api.prepareBooking(c, { restaurantId: '123', slotCursor: result.slots[0].slotId }), { code: 'ACCOUNT_MISMATCH' });
  c.token = 'synthetic-session-token'; c.user.diners.push({ id: '789' });
  await assert.rejects(api.prepareBooking(c, { restaurantId: '123', slotCursor: result.slots[0].slotId }), { code: 'DINER_SELECTION_REQUIRED' });
  const selected = await api.prepareBooking(c, { restaurantId: '123', slotCursor: result.slots[0].slotId, dinerId: '789' });
  assert.equal(selected.review.dinerId, '789');
  await assert.rejects(api.prepareBooking(c, { restaurantId: '123', slotCursor: result.slots[0].slotId, dinerId: '999' }), { code: 'INVALID_ARGUMENT' });
});

test('paid, card guarantee, experience and privileged inventory is explicit and never silently booked', async () => {
  for (const patch of [{ requiresCreditCard: true, creditCardPolicyType: 'DEPOSIT' }, { priceAmount: 1000 }, { ticketExperienceId: 'ticket' }, { requiresOffer: true }, { privilegedAccessRules: [{}] }]) {
    const c = uniqueClient(); Object.assign(c.venue.availability.availability.timeslots[0], patch);
    const selected = await api.availability(c, { restaurantId: '123', dateTime: dt });
    assert.equal(selected.slots[0].bookingSupported, false);
    await assert.rejects(api.prepareBooking(c, { restaurantId: '123', slotCursor: selected.slots[0].slotId }), { code: 'UNSUPPORTED_PAYMENT_FLOW' });
    assert.equal(writes(c).length, 0);
  }
});

test('price, restaurant policy and table changes prevent confirmation before holds', async () => {
  for (const change of [c => { c.venue.termsAndConditions.message = 'Changed terms.'; }, c => { c.venue.availability.availability.timeslots[0].priceAmount = 2000; }, c => { c.venue.availability.availability.timeslots[0].slotHash = 'different'; }]) {
    const { client: c, plan } = await prepare(uniqueClient()); change(c);
    await assert.rejects(api.confirmBooking(c, { planId: plan.planId }), error => ['PLAN_CHANGED', 'UNSUPPORTED_PAYMENT_FLOW', 'TABLE_UNAVAILABLE'].includes(error.code));
    assert.equal(writes(c).length, 0);
  }
});

test('confirmation holds once and submits chosen Standard table with id, slot token and own diner', async () => {
  const { client: c, plan } = await prepare(uniqueClient());
  const result = await api.confirmBooking(c, { planId: plan.planId });
  const calls = writes(c); assert.equal(calls.length, 2);
  assert.equal(calls[0].endpoint, '/api/v3/reservation/123/lock'); assert.equal(calls[0].json.attribute, 'default');
  assert.equal(calls[1].json.lockId, 'native-id-for-booking'); assert.notEqual(calls[1].json.lockId, 'different-lock-field');
  assert.equal(calls[1].json.slotAvailabilityToken, 'native-slot-token'); assert.equal(calls[1].json.tableAttribute, 'default'); assert.equal(calls[1].json.dinerId, '456');
  assert.equal(result.status, 'completed'); assert.equal(result.holdRelease, 'consumed');
  assert.equal(JSON.stringify(result).includes('private-reservation-token'), false);
  assert.match(result.result.reservationId, /^[0-9a-f-]{36}$/);
  await assert.rejects(api.confirmBooking(c, { planId: plan.planId }), { code: 'PLAN_ALREADY_USED' });
});

test('concurrent confirmations dispatch a single booking', async () => {
  const { client: c, plan } = await prepare(uniqueClient());
  const results = await Promise.allSettled([api.confirmBooking(c, { planId: plan.planId }), api.confirmBooking(c, { planId: plan.planId })]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(writes(c).filter(x => x.endpoint === '/api/v3/reservation/123').length, 1);
});

test('account switches and expired plans cannot submit', async () => {
  const { client: c, plan } = await prepare(uniqueClient());
  const original = c.user.globalPersonId; c.user.globalPersonId = 'another-account';
  await assert.rejects(api.confirmBooking(c, { planId: plan.planId }), { code: 'ACCOUNT_MISMATCH' });
  c.user.globalPersonId = original;
  const stored = await readState(`plan-${plan.planId}`); stored.expiresAt = '2020-01-01T00:00:00Z'; await saveState(`plan-${plan.planId}`, stored);
  await assert.rejects(api.confirmBooking(c, { planId: plan.planId }), { code: 'PLAN_EXPIRED' });
  assert.equal(writes(c).length, 0);
});

test('new hold requirements stop booking and release the unused lock', async () => {
  const { client: c, plan } = await prepare(uniqueClient());
  c.onRequest = call => call.endpoint.endsWith('/lock') && call.method === 'POST' ? { id: 'hold-to-release', creditCardPolicyType: 'HOLD' } : undefined;
  await assert.rejects(api.confirmBooking(c, { planId: plan.planId }), { code: 'OPERATION_REJECTED' });
  const calls = writes(c); assert.equal(calls.length, 2); assert.equal(calls[1].method, 'DELETE'); assert.equal(calls[1].query.slotLockId, 'hold-to-release');
  const stored = await readState(`plan-${plan.planId}`); const op = await api.inspectOperation({ operationId: stored.operationId, client: c });
  assert.equal(op.holdRelease, 'released'); assert.equal(op.error.code, 'PLAN_CHANGED');
});

test('failed hold release remains visible and blocks additional operations', async () => {
  const { client: c, plan, result } = await prepare(uniqueClient());
  c.onRequest = call => {
    if (call.endpoint.endsWith('/lock') && call.method === 'POST') return { id: 'hold-release-failed', creditCardPolicyType: 'DEPOSIT' };
    if (call.endpoint.endsWith('/lock') && call.method === 'DELETE') throw new OpenTableError('NETWORK_ERROR', 'Simulated response lost.');
  };
  await assert.rejects(api.confirmBooking(c, { planId: plan.planId }), error => error.code === 'OPERATION_REJECTED' && error.details.holdRelease === 'failed');
  c.onRequest = null;
  const next = await api.prepareBooking(c, { restaurantId: '123', slotCursor: result.slots[0].slotId });
  await assert.rejects(api.confirmBooking(c, { planId: next.planId }), { code: 'OPERATION_UNRESOLVED' });
});

test('ambiguous booking is durable, never retried and never releases a potentially consumed hold', async () => {
  const { client: c, plan, result } = await prepare(uniqueClient());
  c.onRequest = call => { if (call.endpoint === '/api/v3/reservation/123' && call.method === 'POST') throw new OpenTableError('NETWORK_ERROR', 'Synthetic timeout.'); };
  await assert.rejects(api.confirmBooking(c, { planId: plan.planId }), { code: 'OPERATION_UNCERTAIN' });
  assert.equal(writes(c).some(x => x.method === 'DELETE'), false);
  const saved = await readState(`plan-${plan.planId}`); assert.equal((await api.inspectOperation({ operationId: saved.operationId, client: c })).status, 'uncertain');
  const next = await api.prepareBooking(c, { restaurantId: '123', slotCursor: result.slots[0].slotId });
  await assert.rejects(api.confirmBooking(c, { planId: next.planId }), { code: 'OPERATION_UNRESOLVED' });
  assert.equal(writes(c).filter(x => x.endpoint === '/api/v3/reservation/123').length, 1);
});

test('ambiguous hold acquisition blocks replay even without a returned hold ID', async () => {
  const { client: c, plan } = await prepare(uniqueClient());
  c.onRequest = call => { if (call.endpoint.endsWith('/lock') && call.method === 'POST') throw new OpenTableError('NETWORK_ERROR', 'Lost hold response.'); };
  await assert.rejects(api.confirmBooking(c, { planId: plan.planId }), { code: 'OPERATION_UNCERTAIN' });
  assert.equal(writes(c).length, 1);
});

test('definitive server booking rejection releases hold without retrying', async () => {
  const { client: c, plan } = await prepare(uniqueClient());
  c.onRequest = call => { if (call.endpoint === '/api/v3/reservation/123' && call.method === 'POST') throw new OpenTableError('API_ERROR', 'Rejected.', { httpStatus: 409 }); };
  await assert.rejects(api.confirmBooking(c, { planId: plan.planId }), { code: 'OPERATION_REJECTED' });
  assert.equal(writes(c).length, 3); assert.equal(writes(c)[2].method, 'DELETE');
});

test('booking result missing restaurant is ambiguous rather than a safe retry', async () => {
  const { client: c, plan } = await prepare(uniqueClient());
  c.onRequest = call => call.endpoint === '/api/v3/reservation/123' && call.method === 'POST' ? { confirmationNumber: 808, token: 'private-token' } : undefined;
  await assert.rejects(api.confirmBooking(c, { planId: plan.planId }), { code: 'OPERATION_UNCERTAIN' });
  assert.equal(writes(c).length, 2);
});

test('cancellation proxy requires account ownership and exact native reservation metadata', async () => {
  const { client: c, listed, plan } = await cancelPlan(uniqueClient());
  assert.equal(writes(c).length, 0); assert.equal(plan.review.cancellationCharge.amount, 0);
  const lookup = c.calls.find(x => x.endpoint === '/api/v3/user/reservation');
  assert.equal(lookup.query.securityToken, 'private-reservation-token'); assert.equal(lookup.query.confirmationNumber, '808');
  c.user.globalPersonId = 'switched';
  await assert.rejects(api.prepareCancellation(c, { reservationId: listed.reservations[0].reservationId }), { code: 'ACCOUNT_MISMATCH' });
});

test('unknown and paid cancellation states are rejected before DELETE', async () => {
  for (const patch of [{ creditCard: true }, { creditCard: null }, { depositDetails: {} }, { experienceInvoiceSummary: {} }, { creditCardCancellationPolicy: { cancellable: false } }]) {
    const c = uniqueClient(); Object.assign(c.currentReservation = booking(), patch); c.user.reservations.history = [clone(c.currentReservation)];
    const listed = await api.reservations(c);
    await assert.rejects(api.prepareCancellation(c, { reservationId: listed.reservations[0].reservationId }), error => ['UNSUPPORTED_CANCELLATION_POLICY', 'CANCELLATION_NOT_ALLOWED'].includes(error.code));
    assert.equal(writes(c).length, 0);
  }
});

test('cancellation confirms with exact DELETE and verifies server Cancelled state', async () => {
  const { client: c, plan } = await cancelPlan(uniqueClient());
  const result = await api.confirmCancellation(c, { planId: plan.planId });
  const calls = writes(c); assert.equal(calls.length, 1); assert.equal(calls[0].method, 'DELETE'); assert.equal(calls[0].endpoint, '/api/v3/reservation/123/808');
  assert.deepEqual(calls[0].query, { token: 'private-reservation-token' }); assert.equal(result.status, 'completed');
});

test('cancellation cutoff changes reject before submission even when policy text is unchanged', async () => {
  const { client: c, plan } = await cancelPlan(uniqueClient());
  const stored = await readState(`plan-${plan.planId}`);
  const cutoff = new Date(Date.now() - 1000).toISOString();
  stored.createdAt = new Date(Date.now() - 5000).toISOString();
  stored.review.cancellationPolicy = { cancellable: true, cancellationCutoffDate: null, cancellationCutoffUtcDate: cutoff };
  c.currentReservation = { ...booking(), creditCardCancellationPolicy: { cancellable: true, cancellationCutoffUtcDate: cutoff } };
  await saveState(`plan-${plan.planId}`, stored);
  await assert.rejects(api.confirmCancellation(c, { planId: plan.planId }), { code: 'PLAN_CHANGED' });
  assert.equal(writes(c).length, 0);
});

test('unconfirmed cancellation becomes uncertain and prevents replay', async () => {
  const { client: c, plan } = await cancelPlan(uniqueClient());
  c.onRequest = call => call.method === 'DELETE' ? null : undefined;
  await assert.rejects(api.confirmCancellation(c, { planId: plan.planId }), { code: 'OPERATION_UNCERTAIN' });
  await assert.rejects(api.confirmCancellation(c, { planId: plan.planId }), { code: 'PLAN_ALREADY_USED' });
  assert.equal(writes(c).length, 1);
});

test('native primitive omissions retain documented false/zero defaults while explicit null is unknown', async () => {
  const c = uniqueClient(), rawSlot = c.venue.availability.availability.timeslots[0];
  delete rawSlot.requiresCreditCard; delete rawSlot.requiresOffer; delete rawSlot.priceAmount;
  const result = await api.availability(c, { restaurantId: '123', dateTime: dt });
  assert.equal(result.slots[0].requiresCreditCard, false); assert.equal(result.slots[0].priceAmount, 0); assert.equal(result.slots[0].bookingSupported, true);
  const plan = await api.prepareBooking(c, { restaurantId: '123', slotCursor: result.slots[0].slotId });
  assert.equal(plan.review.price.chargedNow, 0);
  rawSlot.requiresCreditCard = null;
  await assert.rejects(api.prepareBooking(c, { restaurantId: '123', slotCursor: result.slots[0].slotId }), { code: 'UNSUPPORTED_PAYMENT_FLOW' });
  const raw = booking(); delete raw.creditCard;
  c.user.reservations.history = [raw]; c.currentReservation = raw;
  const listed = await api.reservations(c);
  assert.equal(listed.reservations[0].creditCard, false);
  assert.equal((await api.prepareCancellation(c, { reservationId: listed.reservations[0].reservationId })).review.cancellationSupported, true);
  assert.equal(writes(c).length, 0);
});

test('safe numeric native identities normalize consistently and unnecessary saved-card selection is rejected', async () => {
  const c = uniqueClient(); c.user.globalPersonId = 987654; c.user.diners = [{ id: 456 }];
  const { plan, result } = await prepare(c);
  assert.equal(plan.review.dinerId, '456');
  const privatePlan = await readState(`plan-${plan.planId}`); assert.equal(privatePlan.accountId, '987654');
  await assert.rejects(api.prepareBooking(c, { restaurantId: '123', slotCursor: result.slots[0].slotId, paymentMethodId: '999' }), { code: 'INVALID_ARGUMENT' });
});

function guaranteeClient() {
  const c = uniqueClient();
  c.user.wallet = { cards: [{ id: 'card-1', token: 'private-wallet-customer-token', last4: '4242', type: 'VISA', default: true, expiryMonth: '12', expiryYear: '2099' }] };
  Object.assign(c.venue.availability.availability.timeslots[0], { requiresCreditCard: true, creditCardPolicyType: 'HOLD' });
  c.venue.termsAndConditions.message = 'A $25 per-person late-cancellation card guarantee applies.';
  c.hold = { id: 'synthetic-guarantee-hold', rid: '123', partySize: 2, date: dt, creditCardPolicyType: 'HOLD', creditCardMessage: 'A $25 per-person guarantee applies. Cancel 24 hours before dining.', creditCardCancellationPolicy: { cancellable: true, cancellationCutoffUtcDate: '2027-04-19T19:00:00Z' }, paymentProviderSummary: { paymentProcessor: 'STRIPE', shouldDisableWallet: false } };
  c.booked = { ...booking(), creditCard: true, creditCardLastFour: '4242', creditCardMessage: c.hold.creditCardMessage, creditCardCancellationPolicy: c.hold.creditCardCancellationPolicy };
  return c;
}

test('wallet listing masks stored tokens and global users need no fabricated diner ID', async () => {
  const c = guaranteeClient(); delete c.user.diners;
  const list = await api.payments(c); assert.equal(list.paymentMethods[0].lastFour, '4242'); assert.equal(JSON.stringify(list).includes('private-wallet-customer-token'), false);
  const { plan } = await prepare(c); assert.equal(plan.review.dinerId, null); assert.equal(plan.review.paymentMethod.paymentMethodId, 'card-1'); assert.equal(plan.review.paymentMethod.provider, 'STRIPE');
  assert.equal(writes(c).length, 0);
});

test('HOLD confirmation returns exact new terms, releases inventory and books only after another reviewed confirmation', async () => {
  const c = guaranteeClient(); delete c.user.diners;
  const { plan } = await prepare(c);
  const first = await api.confirmBooking(c, { planId: plan.planId });
  assert.equal(first.status, 'review_required'); assert.equal(first.holdRelease, 'released');
  assert.equal(first.nextPlan.review.guaranteePolicy.creditCardMessage, c.hold.creditCardMessage);
  assert.equal(writes(c).length, 2); assert.equal(writes(c)[1].method, 'DELETE');
  assert.equal(JSON.stringify(first).includes('private-wallet-customer-token'), false);
  const second = await api.confirmBooking(c, { planId: first.nextPlan.planId });
  assert.equal(second.status, 'completed');
  const submitted = writes(c).find(call => call.endpoint === '/api/v3/reservation/123');
  assert.deepEqual(submitted.json.creditCardLock, { customerId: 'private-wallet-customer-token', last4: '4242', paymentProviderType: 'STRIPE', tokenizationMethod: 'CREDIT_CARD' });
  assert.equal(submitted.json.gpid, c.user.globalPersonId); assert.equal('dinerId' in submitted.json, false);
  assert.equal(submitted.json.requiresCreditCard, true);
  assert.equal(writes(c).filter(call => call.endpoint === '/api/v3/reservation/123').length, 1);
});

test('native config controls saved-card provider and changes stop submission', async () => {
  const c = guaranteeClient(); c.config = { android_alternate_payment_processor_v3: 1 };
  const { plan } = await prepare(c); assert.equal(plan.review.paymentMethod.provider, 'SPREEDLY');
  c.config.android_alternate_payment_processor_v3 = 0;
  await assert.rejects(api.confirmBooking(c, { planId: plan.planId }), { code: 'PLAN_CHANGED' }); assert.equal(writes(c).length, 0);
  const next = await api.prepareBooking(c, { restaurantId: '123', slotCursor: (await api.availability(c, { restaurantId: '123', dateTime: dt })).slots[0].slotId });
  assert.equal(next.review.paymentMethod.provider, 'STRIPE');
  c.user.wallet.cards[0].token = 'a-replaced-private-token';
  await assert.rejects(api.confirmBooking(c, { planId: next.planId }), { code: 'PLAN_CHANGED' }); assert.equal(writes(c).length, 0);
});

test('another hold policy change requires another review without booking', async () => {
  const c = guaranteeClient(), { plan } = await prepare(c);
  const first = await api.confirmBooking(c, { planId: plan.planId });
  c.hold.creditCardMessage = 'The current guarantee is now $50 per person.';
  const second = await api.confirmBooking(c, { planId: first.nextPlan.planId });
  assert.equal(second.status, 'review_required'); assert.equal(second.nextPlan.review.guaranteePolicy.creditCardMessage, c.hold.creditCardMessage);
  assert.equal(writes(c).filter(call => call.method === 'DELETE').length, 2);
  assert.equal(writes(c).some(call => call.endpoint === '/api/v3/reservation/123'), false);
});

test('wallet-disabled, third-party and new-payment holds are released and cannot use a stored customer token', async () => {
  for (const patch of [{ paymentProviderSummary: { shouldDisableWallet: true } }, { paymentProviderSummary: { paymentProcessor: 'FREEDOMPAY2' } }, { thirdPartyCreditCardFormUrl: 'https://payment.example.test/' }, { depositTotalSummary: {} }, { ageVerificationGate: {} }]) {
    const c = guaranteeClient(); Object.assign(c.hold, patch); const { plan } = await prepare(c);
    await assert.rejects(api.confirmBooking(c, { planId: plan.planId }), { code: 'OPERATION_REJECTED' });
    assert.equal(writes(c).length, 2); assert.equal(writes(c)[1].method, 'DELETE');
  }
});

test('review-required hold release failure is attempted once and blocks account replay', async () => {
  const c = guaranteeClient(), { plan, result } = await prepare(c);
  c.onRequest = call => { if (call.endpoint.endsWith('/lock') && call.method === 'DELETE') throw new OpenTableError('NETWORK_ERROR', 'Synthetic failed release.'); };
  await assert.rejects(api.confirmBooking(c, { planId: plan.planId }), error => error.code === 'OPERATION_REJECTED' && error.details.holdRelease === 'failed');
  assert.equal(writes(c).filter(call => call.method === 'DELETE').length, 1);
  const next = await api.prepareBooking(c, { restaurantId: '123', slotCursor: result.slots[0].slotId });
  await assert.rejects(api.confirmBooking(c, { planId: next.planId }), { code: 'OPERATION_UNRESOLVED' });
});

test('saved card must belong to this account; Google Pay and absent wallets are explicit unsupported selections', async () => {
  const c = guaranteeClient(), selected = await api.availability(c, { restaurantId: '123', dateTime: dt });
  await assert.rejects(api.prepareBooking(c, { restaurantId: '123', slotCursor: selected.slots[0].slotId, paymentMethodId: 'other-card' }), { code: 'PAYMENT_METHOD_NOT_FOUND' });
  c.user.wallet.cards[0].type = 'GOOGLE_PAY';
  await assert.rejects(api.prepareBooking(c, { restaurantId: '123', slotCursor: selected.slots[0].slotId }), { code: 'PAYMENT_REQUIRED' });
  delete c.user.wallet;
  await assert.rejects(api.prepareBooking(c, { restaurantId: '123', slotCursor: selected.slots[0].slotId }), { code: 'PAYMENT_REQUIRED' });
  assert.equal(writes(c).length, 0);
});

test('HOLD cancellation preserves native terms and requires explicit unknown-fee approval', async () => {
  const c = guaranteeClient(); c.currentReservation = clone(c.booked); c.user.reservations.history = [clone(c.booked)];
  const listed = await api.reservations(c), plan = await api.prepareCancellation(c, { reservationId: listed.reservations[0].reservationId });
  assert.equal(plan.review.cancellationCharge.amount, null); assert.equal(plan.review.cancellationCharge.feeKnown, false); assert.equal(plan.review.requiresExplicitFeeAcceptance, true);
  await assert.rejects(api.confirmCancellation(c, { planId: plan.planId }), { code: 'FEE_APPROVAL_REQUIRED' }); assert.equal(writes(c).length, 0);
  const result = await api.confirmCancellation(c, { planId: plan.planId, acceptUnknownFee: true });
  assert.equal(result.status, 'completed'); assert.equal(writes(c).length, 1);
});

test('unlocatable successful hold response is uncertain and blocks further holds', async () => {
  for (const hold of [{}, { id: '' }, { id: 'bad\nidentifier' }]) {
    const c = uniqueClient(), { plan, result } = await prepare(c); c.hold = hold;
    await assert.rejects(api.confirmBooking(c, { planId: plan.planId }), { code: 'OPERATION_UNCERTAIN' });
    assert.equal(writes(c).length, 1); assert.equal(writes(c)[0].method, 'POST');
    const next = await api.prepareBooking(c, { restaurantId: '123', slotCursor: result.slots[0].slotId });
    await assert.rejects(api.confirmBooking(c, { planId: next.planId }), { code: 'OPERATION_UNRESOLVED' });
    assert.equal(writes(c).length, 1);
  }
});

test('booking bounds native integer restaurant IDs before any request or rounding', async () => {
  const c = uniqueClient();
  await assert.rejects(api.prepareBooking(c, { restaurantId: '900719925474099312345', slotCursor: crypto.randomUUID() }), { code: 'INVALID_ARGUMENT' });
  assert.equal(c.calls.length, 0);
});

test('fulfilled and past reservations cannot prepare cancellation', async () => {
  for (const patch of [{ reservationStatus: 'Seated' }, { reservationStatus: 'PickedUp' }, { utcDateTime: '2020-01-01T01:00' }]) {
    const c = uniqueClient(); c.currentReservation = { ...booking(), ...patch }; c.user.reservations.history = [clone(c.currentReservation)];
    const listed = await api.reservations(c);
    await assert.rejects(api.prepareCancellation(c, { reservationId: listed.reservations[0].reservationId }), { code: 'CANCELLATION_NOT_ALLOWED' });
    assert.equal(writes(c).length, 0);
  }
});

test('a visible reservation owned by another gpid cannot be cancelled', async () => {
  const c = uniqueClient(); c.currentReservation = { ...booking(), gpid: 'another-owner' }; c.user.reservations.history = [clone(c.currentReservation)];
  const listed = await api.reservations(c);
  await assert.rejects(api.prepareCancellation(c, { reservationId: listed.reservations[0].reservationId }), { code: 'RESERVATION_NOT_OWNED' });
  assert.equal(writes(c).length, 0);
});
