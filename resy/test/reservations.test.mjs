import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'resy-reservations-test-'));
process.env.RESY_CLI_STATE_DIR = directory;
const api = await import('../src/reservations.mjs');
const { ResyError } = await import('../src/errors.mjs');
const { readState, saveState } = await import('../src/state.mjs');
after(() => fs.rm(directory, { recursive: true, force: true }));

let nextAccountId = 10;
const clone = value => structuredClone(value);
const baseVenue = {
  id: { resy: 123 }, name: 'Example Bistro', locale: { currency: 'USD' },
  config: { allow_bypass_payment_method: 1 },
  location: { address_1: '100 Example St', locality: 'Los Angeles', region: 'CA' },
};
const baseQuote = {
  venue: baseVenue, config: { type: 'Dining Room', date: { start: '2026-12-01 18:00:00' } },
  cancellation: { fee: null, display: { policy: ['Please cancel before noon.'] } },
  payment: { config: { type: 'free' }, amounts: { total: 0, subtotal: 0, tax: 0, quantity: 2, items: [] } },
};
const context = { slotToken: 'example-slot-token', day: '2026-12-01', partySize: 2, venueId: '123' };
const baseReservation = {
  reservation_id: '9007199254740993', resy_token: 'example-reservation-token',
  day: context.day, time_slot: '18:00:00', num_seats: 2, venue: { id: 123, currency: 'USD' },
  config: { type: 'Dining Room' }, payment: { invoice: { total: 0 } },
  cancellation: { fee: null }, cancellation_policy: ['Please cancel before noon.'],
};

function mock(overrides = {}) {
  const calls = [];
  const accountId = String(nextAccountId++);
  const client = {
    token: 'fake-session', calls, accountId,
    async me() { return { id: this.accountId, payment_methods: [{ id: 12, display: '1234', type: 'Visa', is_default: 1 }] }; },
    async request(endpoint, options = {}) {
      calls.push({ endpoint, options: clone(options) });
      if (overrides[endpoint]) return overrides[endpoint](options, calls);
      if (endpoint === '/4/find') return { results: { venues: [{ venue: clone(baseVenue), slots: [{ config: { token: context.slotToken, type: 'Dining Room' }, date: { start: '2026-12-01 18:00:00' } }] }] } };
      if (endpoint === '/3/details') return { ...clone(baseQuote), ...(options.json.commit === 1
        ? { book_token: { value: 'committed-book-token', date_expires: new Date(Date.now() + 60_000).toISOString() } } : {}) };
      if (endpoint === '/3/user/reservations') return { reservations: [], venues: {}, metadata: {} };
      if (endpoint === '/3/book') return { reservation_id: '9007199254740993', resy_token: 'example-booked-token' };
      if (endpoint === '/3/cancel') return {};
      throw new Error(`Unexpected endpoint ${endpoint}`);
    },
  };
  return client;
}

test('search projects restaurants and slots and follows observed one-based pages', async () => {
  const client = mock({ '/3/venuesearch/search': options => {
    assert.deepEqual(options.json, {
      availability: true, page: 2, per_page: 5,
      slot_filter: { day: context.day, party_size: 2 }, types: ['venue'],
      order_by: 'availability', geo: { latitude: 34, longitude: -118 }, query: 'Example',
    });
    assert.equal(options.authenticated, true);
    return { meta: { total_pages: 3 }, search: { hits: [{
      ...baseVenue, currency_code: 'USD', cuisine: ['Italian'],
      locality: 'Los Angeles', neighborhood: 'Downtown', _geoloc: { lat: 34, lng: -118 },
      availability: { slots: [{ config: { token: context.slotToken, type: 'Patio' }, date: { start: '2026-12-01 18:00:00' } }] },
    }] } };
  } });
  const result = await api.search(client, { query: 'Example', lat: 34, lon: -118, day: context.day, page: 2, limit: 5 });
  assert.equal(result.nextPage, 3);
  assert.equal(result.hasMore, true);
  assert.equal(result.restaurants[0].venueId, '123');
  assert.equal(result.restaurants[0].currency, 'USD');
  assert.equal(result.restaurants[0].slots[0].slotToken, context.slotToken);
});

test('invalid IDs, dates, coordinates and counts fail before network reads', async () => {
  const client = mock();
  for (const day of ['2026-99-99', '2026-02-30', '2026-1-01', 'not-a-date']) {
    await assert.rejects(api.availability(client, { venueId: '123', day }), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(api.venue(client, { venueId: '../123' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(api.search(client, { query: '', lat: 91, lon: 0, day: context.day }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(api.calendar(client, { venueId: '123', startDate: context.day, endDate: '2026-01-01' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(client.calls.length, 0);
});

test('restaurant, availability and calendar reads have bounded exact wire fields', async () => {
  const client = mock({
    '/3/venue': options => { assert.deepEqual(options.query, { id: '123' }); return clone(baseVenue); },
    '/4/find': options => {
      assert.deepEqual(options.json, { lat: 0, long: 0, day: context.day, party_size: 2, venue_id: '123' });
      return { results: { venues: [{ venue: baseVenue, slots: [] }] } };
    },
    '/4/venue/calendar': options => {
      assert.deepEqual(options.query, { venue_id: '123', num_seats: 2, start_date: context.day, end_date: '2026-12-03' });
      return { scheduled: [{ date: context.day, inventory: { reservation: 'available', event: 'not-available' } }], last_calendar_day: '2026-12-03' };
    },
  });
  client.token = null;
  assert.equal((await api.venue(client, { venueId: 123 })).name, baseVenue.name);
  assert.equal((await api.availability(client, { venueId: 123, day: context.day })).restaurants[0].slots.length, 0);
  assert.equal((await api.calendar(client, { venueId: 123, startDate: context.day, endDate: '2026-12-03' })).days.length, 1);
  assert.ok(client.calls.every(call => call.options.authenticated === false));
});

test('malformed table and search envelopes fail instead of silently dropping data', async () => {
  const searchClient = mock({ '/3/venuesearch/search': () => ({ search: { hits: [] }, meta: {} }) });
  await assert.rejects(api.search(searchClient, { query: '', lat: 0, lon: 0, day: context.day }), { code: 'PROTOCOL_CHANGED' });
  const tableClient = mock({ '/4/find': () => ({ results: { venues: [{ venue: baseVenue, slots: [{ config: {} }] }] } }) });
  await assert.rejects(api.availability(tableClient, { venueId: 123, day: context.day }), { code: 'PROTOCOL_CHANGED' });
});

test('reservation metadata joins by ID and preserves large reservation IDs and policies', async () => {
  const client = mock({ '/3/user/reservations': options => {
    assert.deepEqual(options.query, { type: 'past', offset: 11, limit: 10 });
    return { reservations: [baseReservation], venues: { 123: baseVenue }, metadata: { type: 'past', total: 1 } };
  } });
  const result = await api.reservations(client, { type: 'past', offset: 11 });
  assert.equal(result.reservations[0].reservationId, '9007199254740993');
  assert.equal(result.reservations[0].venue.name, baseVenue.name);
  assert.equal(result.reservations[0].cancellation.feeKnown, true);
  assert.equal(result.reservations[0].cancellation.fee, null);
});

test('saved cards come from the account GET response with only masked selection metadata', async () => {
  const client = mock();
  let accountReads = 0;
  client.me = async () => {
    accountReads += 1;
    return { id: client.accountId, private_account_field: 'not-returned', payment_methods: [{
      id: 12, display: '1234', type: 'Visa', is_default: 1,
      provider_id: 'not-returned', issuing_bank: 'not-returned', exp_year: 2030, exp_month: 1,
    }] };
  };
  assert.deepEqual(await api.payments(client), { paymentMethods: [{
    paymentMethodId: '12', display: '1234', type: 'Visa', isDefault: true,
  }] });
  assert.equal(accountReads, 1);
  assert.equal(client.calls.length, 0);
  client.me = async () => ({ id: client.accountId, payment_methods: [{ id: '../bad' }] });
  await assert.rejects(api.payments(client), { code: 'PROTOCOL_CHANGED' });
});

test('booking preparation only quotes, records terms privately and rejects unknown costs', async () => {
  const client = mock();
  const plan = await api.prepareBooking(client, context);
  assert.equal(plan.review.amounts.total, 0);
  assert.equal(plan.review.paymentRequired, false);
  assert.deepEqual(client.calls.map(call => call.endpoint), ['/4/find', '/3/details']);
  assert.equal(client.calls[1].options.json.commit, 0);
  assert.equal('slotToken' in plan, false);
  const record = await readState(`plan-${plan.planId}`);
  assert.equal(record.context.slotToken, context.slotToken);
  assert.equal((await fs.stat(path.join(directory, `plan-${plan.planId}.json`))).mode & 0o777, 0o600);
  const unknown = mock({ '/3/details': () => ({ ...clone(baseQuote), payment: {} }) });
  await assert.rejects(api.prepareBooking(unknown, context), { code: 'REVIEW_UNAVAILABLE' });
});

test('live-observed details envelope enriches its missing venue ID and normalizes nested costs and cutoffs', async () => {
  const liveShape = {
    locale: { currency: 'USD', time_zone: 'PST8PDT' },
    venue: { config: { allow_bypass_payment_method: 1 }, location: baseVenue.location },
    config: { type: '' },
    payment: { config: { type: 'free' }, amounts: {
      quantity: 2, total: 0, items: [], service_charge: { amount: 0, value: '0%' }, resy_fee: 0,
    } },
    cancellation: { fee: null, display: { policy: ['Please cancel in advance.'] },
      refund: { date_cut_off: '2026-12-01T18:00:00Z' }, credit: { date_cut_off: null } },
  };
  const client = mock({ '/3/details': () => clone(liveShape) });
  client.token = null;
  const result = await api.details(client, context);
  assert.equal(result.venue.venueId, '123');
  assert.equal(result.start, '2026-12-01 18:00:00');
  assert.equal(result.tableType, 'Dining Room');
  assert.equal(result.currency, 'USD');
  assert.deepEqual(result.amounts.serviceCharge, { amount: 0, value: '0%' });
  assert.equal(result.cancellation.refundCutoff, '2026-12-01T18:00:00Z');
  assert.equal(result.paymentRequired, false);
  assert.ok(client.calls.every(call => call.options.authenticated === false));
});

test('a venue-bound slot must still be available and eligible before preparing a plan', async () => {
  const missing = mock({ '/4/find': () => ({ results: { venues: [{ venue: baseVenue, slots: [] }] } }) });
  await assert.rejects(api.prepareBooking(missing, context), { code: 'TABLE_UNAVAILABLE' });
  const ineligible = mock({ '/4/find': () => ({ results: { venues: [{ venue: baseVenue,
    slots: [{ config: { token: context.slotToken }, exclusive: { is_eligible: false } }] }] } }) });
  await assert.rejects(api.prepareBooking(ineligible, context), { code: 'TABLE_INELIGIBLE' });
  assert.ok(missing.calls.every(call => call.endpoint !== '/3/details'));
  assert.ok(ineligible.calls.every(call => call.endpoint !== '/3/details'));
});

test('paid or cancellation-fee bookings require a specific saved card without marketing opt-in', async () => {
  const quoted = { ...clone(baseQuote), cancellation: { fee: { amount: 25 }, display: { policy: ['Late cancellation: $25.'] } } };
  const client = mock({ '/3/details': options => ({ ...clone(quoted), ...(options.json.commit === 1 ? { book_token: { value: 'fresh-token' } } : {}) }) });
  await assert.rejects(api.prepareBooking(client, context), { code: 'PAYMENT_REQUIRED' });
  await assert.rejects(api.prepareBooking(client, { ...context, paymentMethodId: 99 }), { code: 'INVALID_ARGUMENT' });
  const plan = await api.prepareBooking(client, { ...context, paymentMethodId: 12 });
  const operation = await api.confirmBooking(client, { planId: plan.planId });
  assert.equal(operation.status, 'completed');
  assert.deepEqual(client.calls.find(call => call.endpoint === '/3/book').options.form, {
    book_token: 'fresh-token', venue_marketing_opt_in: 0, struct_payment_method: { id: '12' },
  });
});

test('confirmation commits details once and serializes concurrent attempts with durable replay prevention', async () => {
  const client = mock();
  const plan = await api.prepareBooking(client, context);
  const outcomes = await Promise.allSettled([
    api.confirmBooking(client, { planId: plan.planId }),
    api.confirmBooking(client, { planId: plan.planId }),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'PLAN_ALREADY_USED');
  assert.equal(client.calls.filter(call => call.endpoint === '/3/book').length, 1);
  assert.equal(client.calls.filter(call => call.endpoint === '/3/details' && call.options.json.commit === 1).length, 1);
  const result = outcomes.find(outcome => outcome.status === 'fulfilled').value;
  assert.equal((await api.inspectOperation({ operationId: result.operationId, client })).status, 'completed');
  client.accountId = '999';
  await assert.rejects(api.inspectOperation({ operationId: result.operationId, client }), { code: 'ACCOUNT_MISMATCH' });
});

test('different account, expired plan, changed quote and existing reservations prevent dispatch', async () => {
  const client = mock();
  const plan = await api.prepareBooking(client, context);
  const accountId = client.accountId;
  client.accountId = '999';
  await assert.rejects(api.confirmBooking(client, { planId: plan.planId }), { code: 'ACCOUNT_MISMATCH' });
  client.accountId = accountId;
  const record = await readState(`plan-${plan.planId}`);
  await saveState(`plan-${plan.planId}`, { ...record, expiresAt: '2000-01-01T00:00:00Z' });
  await assert.rejects(api.confirmBooking(client, { planId: plan.planId }), { code: 'PLAN_EXPIRED' });
  await saveState(`plan-${plan.planId}`, record);
  const request = client.request.bind(client);
  client.request = async (endpoint, options) => endpoint === '/3/details'
    ? { ...clone(baseQuote), config: { type: 'Patio' } } : request(endpoint, options);
  await assert.rejects(api.confirmBooking(client, { planId: plan.planId }), { code: 'PLAN_CHANGED' });
  client.request = async (endpoint, options) => endpoint === '/3/user/reservations'
    ? { reservations: [baseReservation] } : request(endpoint, options);
  await assert.rejects(api.confirmBooking(client, { planId: plan.planId }), { code: 'RESERVATION_CONFLICT' });
  assert.equal(client.calls.filter(call => call.endpoint === '/3/book').length, 0);
});

test('details changes after commit stop before book and consume that plan', async () => {
  const client = mock({ '/3/details': options => ({
    ...clone(baseQuote),
    ...(options.json.commit === 1 ? { config: { type: 'Counter' }, book_token: { value: 'fresh-token' } } : {}),
  }) });
  const plan = await api.prepareBooking(client, context);
  await assert.rejects(api.confirmBooking(client, { planId: plan.planId }), { code: 'PLAN_CHANGED' });
  await assert.rejects(api.confirmBooking(client, { planId: plan.planId }), { code: 'PLAN_ALREADY_USED' });
  assert.equal(client.calls.filter(call => call.endpoint === '/3/book').length, 0);
});

test('a lost booking response persists uncertainty and blocks even a newly prepared plan', async () => {
  const client = mock({ '/3/book': () => { throw new ResyError('NETWORK_ERROR', 'Lost response'); } });
  const plan = await api.prepareBooking(client, context);
  let operationId;
  await assert.rejects(api.confirmBooking(client, { planId: plan.planId }), error => {
    operationId = error.details.operationId; return error.code === 'OPERATION_UNCERTAIN';
  });
  assert.equal((await api.inspectOperation({ operationId, client })).status, 'uncertain');
  const newPlan = await api.prepareBooking(client, context);
  await assert.rejects(api.confirmBooking(client, { planId: newPlan.planId }), { code: 'OPERATION_UNRESOLVED' });
  assert.equal(client.calls.filter(call => call.endpoint === '/3/book').length, 1);
});

test('definitive HTTP412 is recorded as rejected without retry or replacement', async () => {
  const client = mock({ '/3/book': () => { throw new ResyError('API_ERROR', 'Conflict', { httpStatus: 412 }); } });
  const plan = await api.prepareBooking(client, context);
  let operationId;
  await assert.rejects(api.confirmBooking(client, { planId: plan.planId }), error => {
    operationId = error.details.operationId; return error.code === 'OPERATION_REJECTED';
  });
  assert.equal((await api.inspectOperation({ operationId, client })).status, 'rejected');
  assert.equal(client.calls.filter(call => call.endpoint === '/3/book').length, 1);
});

function cancellationClient({ stillPresent = false, feeUnknown = false } = {}) {
  let cancelled = false;
  return mock({
    '/3/user/reservations': () => ({
      reservations: !cancelled || stillPresent ? [{ ...clone(baseReservation), ...(feeUnknown ? { cancellation: {} } : {}) }] : [],
      venues: { 123: baseVenue },
    }),
    '/3/cancel': () => { cancelled = true; return {}; },
  });
}

test('cancellation is previewed and submitted once then verified through fresh scoped reads', async () => {
  const client = cancellationClient();
  const plan = await api.prepareCancellation(client, { reservationToken: baseReservation.resy_token });
  assert.equal(client.calls.some(call => call.endpoint === '/3/cancel'), false);
  const result = await api.confirmCancellation(client, { planId: plan.planId });
  assert.equal(result.status, 'completed');
  assert.equal(result.stage, 'cancelled');
  assert.deepEqual(client.calls.find(call => call.endpoint === '/3/cancel').options.form, { resy_token: baseReservation.resy_token });
  await assert.rejects(api.confirmCancellation(client, { planId: plan.planId }), { code: 'PLAN_ALREADY_USED' });
});

test('unknown cancellation fee and cancellation without confirmed removal fail safely', async () => {
  const unknown = cancellationClient({ feeUnknown: true });
  await assert.rejects(api.prepareCancellation(unknown, { reservationToken: baseReservation.resy_token }), { code: 'REVIEW_UNAVAILABLE' });
  const client = cancellationClient({ stillPresent: true });
  const plan = await api.prepareCancellation(client, { reservationToken: baseReservation.resy_token });
  await assert.rejects(api.confirmCancellation(client, { planId: plan.planId }), { code: 'OPERATION_UNCERTAIN' });
  assert.equal(client.calls.filter(call => call.endpoint === '/3/cancel').length, 1);
});

test('a verification HTTP error after accepted cancellation stays uncertain, never rejected', async () => {
  let cancelled = false;
  const client = mock({
    '/3/user/reservations': () => {
      if (cancelled) throw new ResyError('API_ERROR', 'Verification unavailable', { httpStatus: 404 });
      return { reservations: [clone(baseReservation)], venues: { 123: baseVenue } };
    },
    '/3/cancel': () => { cancelled = true; return {}; },
  });
  const plan = await api.prepareCancellation(client, { reservationToken: baseReservation.resy_token });
  let operationId;
  await assert.rejects(api.confirmCancellation(client, { planId: plan.planId }), error => {
    operationId = error.details.operationId; return error.code === 'OPERATION_UNCERTAIN';
  });
  const operation = await api.inspectOperation({ operationId, client });
  assert.equal(operation.status, 'uncertain');
  assert.equal(operation.stage, 'verifying_cancellation');
});

test('crossing a cancellation cutoff between review and confirmation requires new review', async () => {
  const late = { ...clone(baseReservation), cancellation: { fee: { amount: 25, date_cut_off: '2020-06-01T00:00:00Z' } } };
  const client = mock({ '/3/user/reservations': () => ({ reservations: [late], venues: { 123: baseVenue } }) });
  const plan = await api.prepareCancellation(client, { reservationToken: late.resy_token });
  const record = await readState(`plan-${plan.planId}`);
  await saveState(`plan-${plan.planId}`, { ...record, createdAt: '2020-01-01T00:00:00Z' });
  await assert.rejects(api.confirmCancellation(client, { planId: plan.planId }), { code: 'PLAN_CHANGED' });
  assert.equal(client.calls.some(call => call.endpoint === '/3/cancel'), false);
});
