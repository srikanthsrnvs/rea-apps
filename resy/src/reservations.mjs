import { randomUUID } from 'node:crypto';
import { ResyError } from './errors.mjs';
import { readState, saveState, withStateLock } from './state.mjs';

const planLifetimeMs = 5 * 60_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = value => typeof value === 'string' ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
const invalid = message => { throw new ResyError('INVALID_ARGUMENT', message); };
const changed = message => { throw new ResyError('PROTOCOL_CHANGED', message); };

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

function id(value, label = 'Venue ID') {
  const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof result !== 'string' || !/^\d{1,30}$/.test(result)) invalid(`${label} must be a numeric ID.`);
  return result;
}

function date(value, label = 'Date') {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid(`${label} must be a valid YYYY-MM-DD date.`);
  return value;
}

function coordinate(value, maximum, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > maximum) invalid(`${label} must be a number from ${-maximum} to ${maximum}.`);
  return value;
}

function opaque(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16_384 || /[\x00-\x1f\x7f]/.test(value)) invalid(`${label} must be a nonempty token.`);
  return value;
}

function recordId(value, label) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) invalid(`${label} must be a CLI-generated UUID.`);
  return value;
}

function identity(value) {
  const raw = value?.id ?? value?.user_id;
  const result = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw;
  if (typeof result !== 'string' || !/^\d{1,30}$/.test(result)) changed('Resy did not return a stable account ID.');
  return result;
}

function normalizeLocation(value = {}) {
  return {
    address1: text(value.address_1), address2: text(value.address_2),
    city: text(value.locality), state: text(value.region), postalCode: text(value.postal_code),
    country: text(value.country), neighborhood: text(value.neighborhood),
    code: text(value.code), slug: text(value.url_slug),
    latitude: number(value.latitude), longitude: number(value.longitude),
  };
}

function normalizeVenue(value) {
  if (!object(value)) changed('Resy returned an invalid restaurant.');
  const rawId = object(value.id) ? value.id.resy : value.id;
  let venueId;
  try { venueId = id(rawId); } catch { changed('Resy returned a restaurant without a valid ID.'); }
  return {
    venueId, name: text(value.name), slug: text(value.url_slug ?? value.venue_url_slug),
    cuisine: Array.isArray(value.cuisine) ? strings(value.cuisine) : strings([value.type]),
    location: normalizeLocation({
      locality: value.locality, region: value.region, neighborhood: value.neighborhood,
      latitude: value._geoloc?.lat, longitude: value._geoloc?.lng,
      ...value.location,
    }),
    currency: text(value.locale?.currency) ?? text(value.currency_code) ?? text(value.currency),
    currencySymbol: text(value.currency_symbol), priceRange: number(value.price_range_id),
    rating: number(value.rating?.average), ratingCount: number(value.rating?.count),
    minPartySize: number(value.min_party_size), maxPartySize: number(value.max_party_size),
    isTockInventory: bool(value.is_tock_inventory),
    externalBookingUrl: text(value.tock_business_search_url ?? value.tock_business_page_url),
    phone: text(value.contact?.phone_number), menuUrl: text(value.contact?.menu_url),
  };
}

function normalizeSlot(value) {
  if (!object(value) || !object(value.config)) changed('Resy returned an invalid table option.');
  const token = text(value.config.token);
  // Tock results may link to an external booking service without a Resy token.
  if (!token && !text(value.tock_booking_url)) changed('Resy returned a table option without a booking token.');
  return {
    slotToken: token, tableType: text(value.config.type), start: text(value.date?.start),
    end: text(value.date?.end), serviceTypeId: value.shift?.service?.type?.id ?? null,
    templateId: value.template?.id ?? null,
    isGlobalDiningAccess: bool(value.is_global_dining_access),
    isEligible: bool(value.exclusive?.is_eligible),
    externalBookingUrl: text(value.tock_booking_url),
  };
}

function normalizeSlots(value) {
  if (!Array.isArray(value)) changed('Resy did not return a table-options list.');
  return value.map(normalizeSlot);
}

export async function search(client, {
  query, lat, lon, day, partySize = 2, page = 1, limit = 20,
} = {}) {
  if (typeof query !== 'string' || query.length > 500) invalid('Search query must be a string of at most 500 characters.');
  coordinate(lat, 90, 'Latitude'); coordinate(lon, 180, 'Longitude');
  date(day); integer(partySize, 1, 100, 'Party size');
  integer(page, 1, 10_000, 'Search page'); integer(limit, 1, 100, 'Limit');
  const response = await client.request('/3/venuesearch/search', {
    method: 'POST', authenticated: Boolean(client.token),
    json: {
      availability: true, page, per_page: limit,
      slot_filter: { day, party_size: partySize }, types: ['venue'],
      order_by: 'availability', geo: { latitude: lat, longitude: lon }, query,
    },
  });
  if (!Array.isArray(response?.search?.hits) || !Number.isSafeInteger(response?.meta?.total_pages)
    || response.meta.total_pages < 0) changed('Resy did not return the expected restaurant search page.');
  return {
    query, day, partySize, page, totalPages: response.meta.total_pages,
    restaurants: response.search.hits.map(hit => ({
      ...normalizeVenue(hit), slots: normalizeSlots(hit.availability?.slots ?? []),
    })),
    hasMore: page < response.meta.total_pages,
    nextPage: page < response.meta.total_pages ? page + 1 : null,
  };
}

export async function venue(client, { venueId } = {}) {
  venueId = id(venueId);
  return normalizeVenue(await client.request('/3/venue', { query: { id: venueId }, authenticated: Boolean(client.token) }));
}

export async function availability(client, { venueId, day, partySize = 2, lat = 0, lon = 0 } = {}) {
  venueId = id(venueId); date(day); integer(partySize, 1, 100, 'Party size');
  coordinate(lat, 90, 'Latitude'); coordinate(lon, 180, 'Longitude');
  const response = await client.request('/4/find', {
    method: 'POST', authenticated: Boolean(client.token),
    json: { lat, long: lon, day, party_size: partySize, venue_id: venueId },
  });
  if (!Array.isArray(response?.results?.venues)) changed('Resy did not return a restaurant availability list.');
  return {
    venueId, day, partySize,
    restaurants: response.results.venues.map(item => ({
      ...normalizeVenue(item.venue), slots: normalizeSlots(item.slots),
    })),
  };
}

export async function calendar(client, { venueId, startDate, endDate, partySize = 2 } = {}) {
  venueId = id(venueId); date(startDate, 'Start date'); date(endDate, 'End date');
  integer(partySize, 1, 100, 'Party size');
  if (startDate > endDate) invalid('Start date must precede end date.');
  const response = await client.request('/4/venue/calendar', {
    authenticated: Boolean(client.token),
    query: { venue_id: venueId, num_seats: partySize, start_date: startDate, end_date: endDate },
  });
  if (!Array.isArray(response?.scheduled)) changed('Resy did not return an availability calendar.');
  return {
    venueId, partySize, startDate, endDate, lastCalendarDay: text(response.last_calendar_day),
    days: response.scheduled.map(entry => {
      if (typeof entry.date !== 'string' || !object(entry.inventory)) changed('Resy returned an invalid calendar day.');
      return { date: entry.date, inventory: entry.inventory };
    }),
  };
}

function normalizeCancellation(value, policy, currency) {
  const fee = value?.fee;
  return {
    policy: strings(policy), currency: text(currency),
    allowed: bool(value?.allowed),
    fee: fee === null ? null : object(fee) ? {
      amount: number(fee.amount), displayAmount: text(fee.display?.amount),
      cutoff: text(fee.date_cut_off),
    } : null,
    feeKnown: fee === null || (object(fee) && number(fee.amount) !== null),
    refundCutoff: text(value?.refund?.date_cut_off ?? value?.date_refund_cut_off),
    creditCutoff: text(value?.credit?.date_cut_off ?? value?.date_credit_cut_off),
  };
}

function normalizeReservation(value, venueMap = {}) {
  if (!object(value)) changed('Resy returned an invalid reservation.');
  let reservationId;
  try { reservationId = id(value.reservation_id, 'Reservation ID'); } catch { changed('Resy returned a reservation without a valid ID.'); }
  const rawVenue = venueMap[value.venue?.id] ?? value.venue;
  const currency = value.venue?.currency ?? rawVenue?.locale?.currency ?? rawVenue?.currency;
  return {
    reservationId, reservationToken: text(value.resy_token),
    day: text(value.day), time: text(value.time_slot), partySize: number(value.num_seats),
    serviceTypeId: value.service_type_id ?? null, tableType: text(value.config?.type),
    venue: normalizeVenue(rawVenue), currency: text(currency),
    payment: object(value.payment?.invoice) ? {
      total: number(value.payment.invoice.total), reservationCharge: number(value.payment.invoice.reservation_charge),
    } : null,
    cancellation: normalizeCancellation(value.cancellation, value.cancellation_policy, currency),
  };
}

async function reservationResponse(client, query = {}) {
  const response = await client.request('/3/user/reservations', { query });
  if (!Array.isArray(response?.reservations)) changed('Resy did not return your reservations.');
  return response;
}

export async function reservations(client, { type = 'upcoming', offset = 1, limit = 10 } = {}) {
  if (!['upcoming', 'past', 'all'].includes(type)) invalid('Reservation type must be upcoming, past, or all.');
  integer(offset, 1, 100_000, 'Offset'); integer(limit, 1, 100, 'Limit');
  const response = await reservationResponse(client, { type, offset, limit });
  return {
    reservations: response.reservations.map(item => normalizeReservation(item, response.venues)),
    metadata: object(response.metadata) ? response.metadata : null,
  };
}

export async function payments(client) {
  // The widget's getUserCards (wz -> Ce) reads GET /2/user. The singular
  // /2/user/payment_method endpoint is a card mutation route, not a list read.
  const response = await client.me();
  if (!Array.isArray(response?.payment_methods)) changed('Resy did not return your payment methods.');
  return {
    paymentMethods: response.payment_methods.map(item => {
      let paymentMethodId;
      try { paymentMethodId = id(item.id, 'Payment method ID'); }
      catch { changed('Resy returned a payment method without a valid ID.'); }
      return {
        paymentMethodId, display: text(item.display), type: text(item.type),
        isDefault: bool(item.is_default) ?? (item.is_default === 1 ? true : item.is_default === 0 ? false : null),
      };
    }),
  };
}

function quoteProjection(response, context) {
  if (!object(response)) changed('Resy did not return reservation details.');
  const amounts = response.payment?.amounts;
  const currency = response.locale?.currency ?? response.venue?.locale?.currency ?? response.venue?.currency;
  const rawVenueId = object(response.venue?.id) ? response.venue.id.resy : response.venue?.id;
  const normalizedVenue = rawVenueId !== undefined ? normalizeVenue(response.venue) : context.venue ?? null;
  const total = number(amounts?.total);
  const fee = response.cancellation?.fee;
  const bypass = response.venue?.config?.allow_bypass_payment_method;
  const paymentRequired = total === null || (fee !== null && !object(fee)) || ![0, 1].includes(bypass)
    ? null : fee !== null || total !== 0 || bypass !== 1
      || (Array.isArray(amounts.items) && amounts.items.length > 0)
      || (typeof response.payment?.config?.type === 'string' && response.payment.config.type !== 'free');
  return {
    day: context.day, partySize: context.partySize, venue: normalizedVenue,
    start: text(response.config?.date?.start ?? response.config?.time) ?? context.start ?? null,
    tableType: text(response.config?.type) || context.tableType || null, currency: text(currency),
    amounts: object(amounts) ? {
      quantity: number(amounts.quantity), reservationCharge: number(amounts.reservation_charge),
      serviceCharge: object(amounts.service_charge) ? {
        amount: number(amounts.service_charge.amount), value: text(amounts.service_charge.value),
      } : number(amounts.service_charge), serviceFee: number(amounts.service_fee),
      resyFee: number(amounts.resy_fee), addOns: number(amounts.add_ons),
      subtotal: number(amounts.subtotal), surcharge: number(amounts.surcharge), tax: number(amounts.tax), total,
      items: Array.isArray(amounts.items) ? amounts.items.map(item => ({
        amount: number(item.amount), name: text(item.name), quantity: number(item.quantity), isIncluded: bool(item.is_included),
      })) : [],
    } : null,
    cancellation: normalizeCancellation(response.cancellation, response.cancellation?.display?.policy, currency),
    paymentRequired,
  };
}

function detailArguments({ slotToken, day, partySize = 2, venueId }) {
  opaque(slotToken, 'Table token'); date(day); integer(partySize, 1, 100, 'Party size');
  return { slotToken, day, partySize, ...(venueId === undefined ? {} : { venueId: id(venueId) }) };
}

async function selectedContext(client, context) {
  if (!context.venueId) invalid('A venue ID is required to prepare a booking for this table token.');
  const result = await availability(client, context);
  const restaurant = result.restaurants.find(item => item.venueId === context.venueId);
  const matches = restaurant?.slots.filter(item => item.slotToken === context.slotToken) ?? [];
  if (matches.length !== 1) throw new ResyError('TABLE_UNAVAILABLE', 'That exact table option is no longer available for this restaurant, date, and party size. Search availability again.');
  const slot = matches[0];
  if (slot.isEligible === false) throw new ResyError('TABLE_INELIGIBLE', 'Your account is not eligible for that table option.');
  if (slot.externalBookingUrl) throw new ResyError('EXTERNAL_BOOKING_REQUIRED', 'This table uses another booking service. Open its restaurant link.');
  return {
    ...context, start: slot.start, tableType: slot.tableType,
    venue: { venueId: restaurant.venueId, name: restaurant.name, location: restaurant.location, currency: restaurant.currency },
  };
}

async function quoteRequest(client, context, commit) {
  return client.request('/3/details', {
    method: 'POST',
    authenticated: commit === 0 ? Boolean(client.token) : true,
    json: { config_id: context.slotToken, day: context.day, party_size: context.partySize, commit },
  });
}

export async function details(client, args = {}) {
  let context = detailArguments(args);
  if (context.venueId) context = await selectedContext(client, context);
  return quoteProjection(await quoteRequest(client, context, 0), context);
}

function assertReviewable(quote) {
  if (!quote.venue || !quote.amounts || quote.amounts.total === null || !quote.currency
    || !quote.cancellation.feeKnown || quote.paymentRequired === null) {
    throw new ResyError('REVIEW_UNAVAILABLE', 'Resy did not provide enough cost, policy, or payment information to prepare a booking.');
  }
}

function planView(plan) {
  return { planId: plan.planId, kind: plan.kind, expiresAt: plan.expiresAt, review: plan.review };
}

export async function prepareBooking(client, args = {}) {
  let context = detailArguments(args);
  if (!context.venueId) invalid('A venue ID is required when preparing a booking.');
  const paymentMethodId = args.paymentMethodId === undefined ? null : id(args.paymentMethodId, 'Payment method ID');
  return withStateLock(async () => {
    const accountId = identity(await client.me());
    context = await selectedContext(client, context);
    const quote = quoteProjection(await quoteRequest(client, context, 0), context);
    assertReviewable(quote);
    let selectedPayment = null;
    if (paymentMethodId !== null) {
      selectedPayment = (await payments(client)).paymentMethods.find(item => item.paymentMethodId === paymentMethodId);
      if (!selectedPayment) invalid('The selected payment method is not on this account.');
    }
    if (quote.paymentRequired && !selectedPayment) {
      throw new ResyError('PAYMENT_REQUIRED', 'This reservation requires a saved payment method. Run payments, then prepare it with a payment method ID.');
    }
    const planId = randomUUID();
    const plan = {
      version: 1, kind: 'booking', planId, accountId, context, paymentMethodId,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + planLifetimeMs).toISOString(),
      review: { ...quote, paymentMethod: selectedPayment }, operationId: null,
    };
    await saveState(`plan-${planId}`, plan);
    return planView(plan);
  });
}

async function cancellationReview(client, reservationToken) {
  const response = await reservationResponse(client, { resy_token: reservationToken });
  const own = response.reservations.filter(item => item.resy_token === reservationToken);
  if (own.length !== 1) throw new ResyError('RESERVATION_NOT_FOUND', 'Resy did not return exactly one reservation for that token.');
  const reservation = normalizeReservation(own[0], response.venues);
  if (reservation.cancellation.allowed === false) throw new ResyError('CANCELLATION_NOT_ALLOWED', 'Resy does not allow cancellation of this reservation.');
  if (!reservation.cancellation.feeKnown) throw new ResyError('REVIEW_UNAVAILABLE', 'Resy did not provide a cancellation-fee policy.');
  return reservation;
}

export async function prepareCancellation(client, { reservationToken } = {}) {
  opaque(reservationToken, 'Reservation token');
  return withStateLock(async () => {
    const accountId = identity(await client.me());
    const review = await cancellationReview(client, reservationToken);
    const planId = randomUUID();
    const plan = {
      version: 1, kind: 'cancellation', planId, accountId, reservationToken,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + planLifetimeMs).toISOString(),
      review, operationId: null,
    };
    await saveState(`plan-${planId}`, plan);
    return planView(plan);
  });
}

async function loadPlan(client, planId, kind) {
  recordId(planId, 'Plan ID');
  const plan = await readState(`plan-${planId}`);
  if (!plan || plan.version !== 1 || plan.planId !== planId || plan.kind !== kind) throw new ResyError('PLAN_NOT_FOUND', 'That reservation plan does not exist.');
  if (plan.accountId !== identity(await client.me())) throw new ResyError('ACCOUNT_MISMATCH', 'This plan belongs to a different Resy account.');
  if (plan.operationId) throw new ResyError('PLAN_ALREADY_USED', 'This plan has already been submitted. Inspect its operation instead of submitting it again.', { operationId: plan.operationId });
  if (!(Date.parse(plan.expiresAt) > Date.now())) throw new ResyError('PLAN_EXPIRED', 'This plan expired. Prepare a new one before confirming.');
  return plan;
}

function sameReview(before, after) { return JSON.stringify(before) === JSON.stringify(after); }

function cancellationCutoffRisk(review, now = Date.now()) {
  const cutoff = Date.parse(review.cancellation.fee?.cutoff);
  return Number.isFinite(cutoff) ? now >= cutoff : null;
}

function changedReview() {
  throw new ResyError('PLAN_CHANGED', 'The reservation cost, policy, payment requirements, or table details changed. Prepare and review a new plan before confirming.');
}

async function startOperation(plan) {
  const operationId = randomUUID();
  const operation = {
    version: 1, operationId, planId: plan.planId, kind: plan.kind, accountId: plan.accountId,
    status: 'started', stage: 'prepared', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    summary: plan.review, result: null,
  };
  await saveState(`operation-${operationId}`, operation);
  await saveState(`pending-${plan.kind}-${plan.accountId}`, { operationId });
  plan.operationId = operationId;
  await saveState(`plan-${plan.planId}`, plan);
  return operation;
}

async function checkPendingOperation(plan) {
  const pending = await readState(`pending-${plan.kind}-${plan.accountId}`);
  if (!pending) return;
  recordId(pending.operationId, 'Operation ID');
  const operation = await readState(`operation-${pending.operationId}`);
  if (!operation || ['started', 'uncertain'].includes(operation.status)) {
    throw new ResyError('OPERATION_UNRESOLVED', 'A prior reservation operation is unresolved. Inspect it and your reservations before attempting another operation.', { operationId: pending.operationId });
  }
}

async function saveOperation(operation, fields) {
  Object.assign(operation, fields, { updatedAt: new Date().toISOString() });
  await saveState(`operation-${operation.operationId}`, operation);
}

function operationView(operation) {
  return {
    operationId: operation.operationId, planId: operation.planId, kind: operation.kind,
    status: operation.status, stage: operation.stage, createdAt: operation.createdAt,
    updatedAt: operation.updatedAt, summary: operation.summary, result: operation.result,
    error: operation.error ?? null,
  };
}

async function operationFailure(operation, error) {
  const status = error?.details?.httpStatus ?? error?.details?.status;
  const definitive = operation.stage !== 'verifying_cancellation'
    && Number.isInteger(status) && status >= 400 && status < 500 && status !== 408;
  try { await saveOperation(operation, {
    status: definitive ? 'rejected' : 'uncertain',
    error: { code: error instanceof ResyError ? error.code : 'REQUEST_FAILED', message: definitive
      ? 'Resy rejected this request. Prepare a new plan after resolving the reported error.'
      : 'The result could not be confirmed. Check your reservations before making another attempt.' },
  }); } catch { /* The existing durable started record still blocks replay. */ }
  throw new ResyError(definitive ? 'OPERATION_REJECTED' : 'OPERATION_UNCERTAIN',
    definitive ? 'Resy rejected the reservation operation.' : 'The reservation operation result is uncertain. Do not repeat it; inspect the operation and your reservations.',
    { operationId: operation.operationId, stage: operation.stage });
}

export async function confirmBooking(client, { planId } = {}) {
  return withStateLock(async () => {
    const plan = await loadPlan(client, planId, 'booking');
    await checkPendingOperation(plan);
    const fresh = quoteProjection(await quoteRequest(client, plan.context, 0), plan.context);
    assertReviewable(fresh);
    if (!sameReview(plan.review, { ...fresh, paymentMethod: plan.review.paymentMethod })) changedReview();
    if (cancellationCutoffRisk(plan.review, Date.parse(plan.createdAt)) !== cancellationCutoffRisk(fresh)) changedReview();
    if (plan.paymentMethodId !== null
      && !(await payments(client)).paymentMethods.some(item => item.paymentMethodId === plan.paymentMethodId)) changedReview();
    const existing = await reservationResponse(client);
    if (existing.reservations.some(item => String(item.venue?.id?.resy ?? item.venue?.id) === fresh.venue.venueId
      && item.day === plan.context.day)) {
      throw new ResyError('RESERVATION_CONFLICT', 'You already have a reservation at this restaurant on that day.');
    }
    const operation = await startOperation(plan);
    try {
      await saveOperation(operation, { stage: 'committing_details' });
      const committed = await quoteRequest(client, plan.context, 1);
      const finalQuote = quoteProjection(committed, plan.context);
      assertReviewable(finalQuote);
      if (!sameReview(fresh, finalQuote)) {
        await saveOperation(operation, { status: 'rejected', stage: 'details_changed', error: { code: 'PLAN_CHANGED', message: 'Committed reservation details differ from the reviewed plan.' } });
        throw new ResyError('PLAN_CHANGED', 'Committed details changed. No booking request was sent. Prepare a new plan.', { operationId: operation.operationId });
      }
      const token = committed.book_token?.value;
      if (typeof token !== 'string' || !token.length) changed('Resy did not return a committed booking token.');
      const expiry = Date.parse(committed.book_token.date_expires);
      if (Number.isFinite(expiry) && expiry <= Date.now()) throw new ResyError('BOOKING_TOKEN_EXPIRED', 'Resy returned an expired booking token.');
      await saveOperation(operation, { stage: 'booking' });
      const form = { book_token: token, venue_marketing_opt_in: 0 };
      if (plan.paymentMethodId !== null) form.struct_payment_method = { id: plan.paymentMethodId };
      const result = await client.request('/3/book', { method: 'POST', form });
      const reservationId = id(result?.reservation_id, 'Reservation ID');
      if (typeof result?.resy_token !== 'string' || !result.resy_token.length) changed('Resy did not return a reservation token after booking.');
      await saveOperation(operation, {
        status: 'completed', stage: 'booked',
        result: { reservationId, reservationToken: result.resy_token },
      });
      return operationView(operation);
    } catch (error) {
      if (operation.status === 'rejected') throw error;
      return operationFailure(operation, error);
    }
  });
}

export async function confirmCancellation(client, { planId } = {}) {
  return withStateLock(async () => {
    const plan = await loadPlan(client, planId, 'cancellation');
    await checkPendingOperation(plan);
    const fresh = await cancellationReview(client, plan.reservationToken);
    if (!sameReview(plan.review, fresh) || cancellationCutoffRisk(plan.review, Date.parse(plan.createdAt)) !== cancellationCutoffRisk(fresh)) changedReview();
    const operation = await startOperation(plan);
    try {
      await saveOperation(operation, { stage: 'cancelling' });
      await client.request('/3/cancel', { method: 'POST', form: { resy_token: plan.reservationToken } });
      await saveOperation(operation, { stage: 'verifying_cancellation' });
      // A 2xx response alone is not enough to claim cancellation succeeded.
      const check = await reservationResponse(client, { type: 'upcoming', resy_token: plan.reservationToken });
      if (check.reservations.some(item => item.resy_token === plan.reservationToken)) {
        throw new ResyError('CANCELLATION_UNCONFIRMED', 'The reservation still appears in upcoming reservations.');
      }
      await saveOperation(operation, {
        status: 'completed', stage: 'cancelled', result: { reservationId: plan.review.reservationId },
      });
      return operationView(operation);
    } catch (error) { return operationFailure(operation, error); }
  });
}

export async function inspectOperation({ operationId, client } = {}) {
  recordId(operationId, 'Operation ID');
  const operation = await readState(`operation-${operationId}`);
  if (!operation || operation.version !== 1 || operation.operationId !== operationId) throw new ResyError('OPERATION_NOT_FOUND', 'That reservation operation does not exist.');
  if (!client) throw new ResyError('LOGIN_REQUIRED', 'Sign in to inspect a reservation operation.');
  if (operation.accountId !== identity(await client.me())) throw new ResyError('ACCOUNT_MISMATCH', 'This operation belongs to a different Resy account.');
  return operationView(operation);
}
