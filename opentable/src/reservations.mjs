import { createHash, randomUUID } from 'node:crypto';
import { OpenTableError } from './errors.mjs';
import { readState, saveState, withStateLock } from './state.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const attributes = new Set(['default', 'bar', 'counter', 'hightop', 'outdoor', 'communal', 'restricted']);
const obj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;
const fail = (code, message, details) => { throw new OpenTableError(code, message, details); };
const invalid = message => fail('INVALID_ARGUMENT', message);
const changed = message => fail('PROTOCOL_CHANGED', message);
const digest = value => createHash('sha256').update(value).digest('hex');
const scope = client => digest(String(client.token ?? ''));
const lifetime = 5 * 60_000;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function id(value, label = 'Restaurant ID') {
  const result = Number.isSafeInteger(value) ? String(value) : value;
  if (typeof result !== 'string' || !/^\d{1,30}$/.test(result)) invalid(`${label} must be a numeric ID.`);
  return result;
}
function bookingRestaurantId(value) {
  const result = id(value);
  if (BigInt(result) > 2147483647n) invalid('Booking restaurant ID exceeds the native 32-bit range.');
  return result;
}
function recordId(value, label = 'ID') {
  if (typeof value !== 'string' || !uuid.test(value)) invalid(`${label} must be a CLI-generated UUID.`);
  return value;
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}
function localTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) invalid('Date/time must be restaurant-local YYYY-MM-DDTHH:mm.');
  const parsed = new Date(`${value}:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 16) !== value) invalid('Date/time is not a valid local calendar date and time.');
  return value;
}
function coordinate(value, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > max) invalid(`${label} is invalid.`);
  return value;
}
function account(user) {
  const value = Number.isSafeInteger(user?.globalPersonId) ? String(user.globalPersonId) : user?.globalPersonId;
  if (!obj(user) || typeof value !== 'string' || !value.length || value.length > 200) changed('OpenTable omitted your stable account identity.');
  return value;
}
function diners(user, requested) {
  // Global-user booking caller W0 sets gpid from User.globalPersonId and
  // leaves dinerId null. The live global-user profile omits optional diners.
  if (user.diners === undefined || user.diners === null || Array.isArray(user.diners) && user.diners.length === 0) {
    if (requested !== undefined) invalid('OpenTable did not return an owned diner list for explicit selection.');
    return null;
  }
  if (!Array.isArray(user.diners)) changed('OpenTable returned an unfamiliar diners list.');
  const own = [...new Set(user.diners.map(item => Number.isSafeInteger(item?.id) ? String(item.id) : item?.id).filter(value => typeof value === 'string' && /^\d{1,30}$/.test(value)))];
  if (requested !== undefined) {
    requested = id(requested, 'Diner ID');
    if (!own.includes(requested)) invalid('That diner is not on this account.');
    return requested;
  }
  if (own.length !== 1) fail('DINER_SELECTION_REQUIRED', 'Choose a diner from your account before preparing this booking.', { dinerIds: own });
  return own[0];
}
function strings(value) { return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []; }
function messages(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) changed('OpenTable returned an unfamiliar policy list.');
  return value.map(item => ({ message: text(item?.message), type: text(item?.type) }));
}
function venueProjection(value) {
  if (!obj(value)) changed('OpenTable returned an invalid restaurant.');
  let restaurantId;
  try { restaurantId = id(value.id); } catch { changed('OpenTable omitted a restaurant ID.'); }
  return {
    restaurantId, name: text(value.name), description: text(value.description),
    location: { address: text(value.line1), city: text(value.city), state: text(value.state), postalCode: text(value.postalCode), country: text(value.country), latitude: number(value.latitude), longitude: number(value.longitude) },
    cuisines: Array.isArray(value.cuisines) ? value.cuisines.map(item => ({ id: item?.id ?? null, name: text(item?.name) })) : [],
    currency: text(value.currencyCode), priceBand: obj(value.priceBand) ? { id: value.priceBand.id ?? null, name: text(value.priceBand.name) } : null,
    phone: text(value.phoneNumber), website: text(value.website), url: text(value.nonNaturalUrl),
    hours: text(value.hours), diningStyle: text(value.diningStyle), dressCode: text(value.dressCode),
    maxPartySize: number(value.maxPartySize), tableAttributes: strings(value.tableAttributes),
    terms: text(value.termsAndConditions?.message),
  };
}
function nativeSlots(venue, required = false) {
  const result = venue?.availability;
  const list = result?.availability;
  if (list === undefined && !required) return { slots: [], metadata: null, dateMessages: [] };
  if (!obj(result) || !obj(list) || !Array.isArray(list.timeslots)) changed('OpenTable omitted the expected table availability.');
  if (list.id !== undefined && String(list.id) !== String(venue.id)) changed('OpenTable returned availability for another restaurant.');
  return {
    slots: list.timeslots,
    metadata: { dateTime: text(result.dateTime), noTimesReasons: Array.isArray(list.noTimesReasons) ? list.noTimesReasons : [], minPartySize: number(list.minPartySize), maxPartySize: number(list.maxPartySize), maxDaysInAdvance: number(list.maxDaysInAdvance), blockedDayMessage: text(list.blockedDayMessage), blockedAvailabilityMessage: text(list.blockedAvailabilityMessage) },
    dateMessages: messages(list.dateMessages),
  };
}
function selectionVariants(slot) {
  if (!obj(slot) || typeof slot.dateTime !== 'string') changed('OpenTable returned an invalid table slot.');
  localTime(slot.dateTime);
  if (slot.available !== true) return [];
  // The shipped TimeSlot no-arg constructor defaults these primitive fields
  // to false/zero (REA ev_0bf6f803... + ev_63182c03...). Public responses
  // omit requiresCreditCard=false; explicit null remains an unknown shape.
  slot = { ...slot, requiresCreditCard: slot.requiresCreditCard === undefined ? false : slot.requiresCreditCard, requiresOffer: slot.requiresOffer === undefined ? false : slot.requiresOffer, priceAmount: slot.priceAmount === undefined ? 0 : slot.priceAmount };
  const result = [];
  if (Array.isArray(slot.diningAreas) && slot.diningAreas.length) {
    for (const area of slot.diningAreas) {
      if (!obj(area) || typeof area.id !== 'string') changed('OpenTable returned an invalid dining area.');
      for (const attribute of strings(area.availableAttributes)) {
        if (!attributes.has(attribute)) changed('OpenTable returned an unfamiliar seating option.');
        result.push({ ...slot, selectedAttribute: attribute, selectedDiningArea: { diningAreaId: area.id, tableAttribute: attribute, environment: text(area.environment), isDefaultArea: bool(area.isDefaultArea) }, diningAreaName: text(area.localizedName) });
      }
    }
  } else {
    for (const attribute of strings(slot.attributes)) {
      if (!attributes.has(attribute)) changed('OpenTable returned an unfamiliar seating option.');
      result.push({ ...slot, selectedAttribute: attribute, selectedDiningArea: null, diningAreaName: null });
    }
  }
  return result;
}
function slotProjection(slot) {
  return {
    dateTime: slot.dateTime, tableType: slot.selectedAttribute, diningArea: slot.selectedDiningArea ? { ...slot.selectedDiningArea, name: slot.diningAreaName } : null,
    requiresCreditCard: bool(slot.requiresCreditCard), creditCardPolicyType: text(slot.creditCardPolicyType),
    priceAmount: number(slot.priceAmount), currency: text(slot.currencyType), monetaryDivisor: null,
    points: number(slot.points), pointsType: text(slot.type),
    requiresOffer: bool(slot.requiresOffer), offerIds: strings(slot.offerIds), ticketExperienceId: text(slot.ticketExperienceId),
    restricted: slot.selectedAttribute === 'restricted' || (Array.isArray(slot.privilegedAccessRules) && slot.privilegedAccessRules.length > 0),
    bookingSupported: standardSupported(slot),
  };
}
function cardless(slot) {
  return slot.requiresCreditCard === false && slot.priceAmount === 0
    && !['DEPOSIT', 'HOLD'].includes(slot.creditCardPolicyType)
    && !slot.ticketExperienceId && slot.requiresOffer !== true && !strings(slot.offerIds).length
    && slot.selectedAttribute !== 'restricted' && !(Array.isArray(slot.privilegedAccessRules) && slot.privilegedAccessRules.length);
}
function guaranteed(slot) {
  return slot.requiresCreditCard === true && slot.creditCardPolicyType === 'HOLD' && slot.priceAmount === 0
    && !slot.ticketExperienceId && slot.requiresOffer !== true && !strings(slot.offerIds).length
    && slot.selectedAttribute !== 'restricted' && !(Array.isArray(slot.privilegedAccessRules) && slot.privilegedAccessRules.length);
}
function standardSupported(slot) { return cardless(slot) || guaranteed(slot); }
function cardId(value) {
  value = Number.isSafeInteger(value) ? String(value) : value;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) invalid('Payment method ID is invalid.');
  return value;
}
function cardView(value) {
  return { paymentMethodId: cardId(value.id), lastFour: text(value.last4), type: text(value.type), isDefault: bool(value.default), expiryMonth: text(value.expiryMonth), expiryYear: text(value.expiryYear) };
}
function walletCards(user) {
  if (user?.wallet === undefined || user?.wallet === null) return [];
  if (!Array.isArray(user?.wallet?.cards)) changed('OpenTable omitted your wallet cards.');
  return user.wallet.cards;
}
function selectCard(user, requested) {
  const cards = walletCards(user).filter(card => obj(card) && typeof card.token === 'string' && card.token.length
    && typeof card.last4 === 'string' && /^\d{4}$/.test(card.last4) && typeof card.type === 'string' && card.type.toLowerCase().replace(/[_ -]/g, '') !== 'googlepay');
  if (requested !== undefined && requested !== null) {
    requested = cardId(requested);
    const matched = cards.filter(card => String(card.id) === requested);
    if (matched.length !== 1) fail('PAYMENT_METHOD_NOT_FOUND', 'That saved card is not eligible or is not on this account.');
    return matched[0];
  }
  const defaults = cards.filter(card => card.default === true);
  if (defaults.length === 1) return defaults[0];
  if (cards.length === 1) return cards[0];
  fail('PAYMENT_REQUIRED', 'Choose an existing wallet card with --payment-method-id. New cards and Google Pay require OpenTable.');
}
export async function payments(client) {
  const user = await client.me(); account(user);
  return { paymentMethods: walletCards(user).map(cardView) };
}
async function provider(client) {
  const config = await client.request('/api/configuration/android_feature_config_v11.json');
  if (!obj(config)) changed('OpenTable returned an unfamiliar feature configuration.');
  const raw = config.android_alternate_payment_processor_v3;
  const value = typeof raw === 'string' && /^[+-]?\d+$/.test(raw) ? Number(raw) : raw;
  // Native Integer feature fallback is -1; malformed or missing values are
  // omitted by its parser. Never infer the provider from a wallet token.
  const flag = Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : -1;
  return flag > 0 ? 'SPREEDLY' : 'STRIPE';
}
async function choices(client, rawVenue, context) {
  const available = nativeSlots(rawVenue);
  const slots = [];
  for (const raw of available.slots) {
    for (const slot of selectionVariants(raw)) {
      const slotId = randomUUID();
      await saveState(`selection-${slotId}`, { version: 1, slotId, scope: scope(client), expiresAt: Date.now() + 10 * 60_000, context: { ...context, restaurantId: id(rawVenue.id) }, slot });
      slots.push({ slotId, ...slotProjection(slot), currency: text(slot.currencyType) ?? text(rawVenue.currencyCode) });
    }
  }
  return { slots, availability: available.metadata, dateMessages: available.dateMessages };
}
export async function search(client, { query, lat, lon, dateTime, partySize = 2, page = 1, limit = 20 } = {}) {
  if (typeof query !== 'string' || query.length > 500) invalid('Search query must be a string of at most 500 characters.');
  coordinate(lat, 90, 'Latitude'); coordinate(lon, 180, 'Longitude'); localTime(dateTime);
  integer(partySize, 1, 20, 'Party size'); integer(page, 1, 99_999, 'Page'); integer(limit, 1, 100, 'Limit');
  const result = await client.request(`/api/v5/personalize/search/${page}`, { method: 'POST', query: { forcebannercheck: true }, json: {
    term: query, covers: partySize, dateTime, page, size: limit, location: { latitude: lat, longitude: lon },
    includePayments: true, excludeWaitlist: true, withMapResults: true, requestMatchRelevance: true, requestIntent: true,
  } });
  if (!Array.isArray(result?.results) || !Number.isSafeInteger(result.total) || result.total < 0) changed('OpenTable returned an unfamiliar restaurant search page.');
  const restaurants = [];
  for (const row of result.results) restaurants.push({ ...venueProjection(row?.restaurant), ...await choices(client, row.restaurant, { requestedDateTime: dateTime, partySize }) });
  const hasMore = result.results.length > 0 && page * limit < result.total;
  return { query, dateTime, partySize, page, total: result.total, totalAvailable: number(result.totalAvailable), restaurants, hasMore, nextPage: hasMore ? page + 1 : null };
}
export async function restaurant(client, { restaurantId } = {}) {
  restaurantId = id(restaurantId);
  const raw = await client.request(`/api/v3/restaurant/${restaurantId}`);
  const result = venueProjection(raw);
  if (result.restaurantId !== restaurantId) changed('OpenTable returned another restaurant.');
  return result;
}
async function rawAvailability(client, context) {
  const raw = await client.request(`/api/v3/restaurant/${context.restaurantId}`, { query: {
    dateTime: context.requestedDateTime, partySize: context.partySize, requestAttributeTables: true,
    includeOffers: true, includeNextAvailable: true, requestTicket: true, allowPop: true,
  } });
  if (id(raw?.id) !== context.restaurantId) changed('OpenTable returned another restaurant.');
  nativeSlots(raw, true);
  return raw;
}
export async function availability(client, { restaurantId, dateTime, partySize = 2 } = {}) {
  restaurantId = id(restaurantId); localTime(dateTime); integer(partySize, 1, 20, 'Party size');
  const context = { restaurantId, requestedDateTime: dateTime, partySize };
  const raw = await rawAvailability(client, context);
  return { ...venueProjection(raw), requestedDateTime: dateTime, partySize, ...await choices(client, raw, context) };
}
function ownCurrent(user) {
  if (!obj(user?.reservations) || !Array.isArray(user.reservations.history)) changed('OpenTable omitted your current reservation list.');
  return user.reservations.history;
}
function nativeReservation(value) {
  if (!obj(value) || !obj(value.restaurant)) changed('OpenTable returned an invalid reservation.');
  const restaurantId = id(value.restaurant.id);
  const confirmationNumber = id(value.confirmationNumber, 'Confirmation number');
  if (typeof value.token !== 'string' || !value.token.length || /[\x00-\x1f\x7f]/.test(value.token)) changed('OpenTable omitted the reservation security token.');
  return { raw: value, restaurantId, confirmationNumber, securityToken: value.token };
}
function reservationProjection(value) {
  // ReservationHistoryItem's native no-arg constructor defaults its primitive
  // isCreditCard field to false; SerializedName maps it to creditCard.
  value = { ...value, creditCard: value.creditCard === undefined ? false : value.creditCard };
  return {
    nativeId: value.id === undefined ? null : String(value.id), confirmationNumber: String(value.confirmationNumber),
    restaurant: venueProjection(value.restaurant), dateTime: text(value.dateTime), utcDateTime: text(value.utcDateTime),
    partySize: number(value.partySize), status: number(value.status), reservationStatus: text(value.reservationStatus),
    notes: text(value.notes), tableType: text(value.tableAttribute), diningArea: obj(value.selectedDiningArea) ? value.selectedDiningArea : null,
    creditCard: bool(value.creditCard), creditCardLastFour: text(value.creditCardLastFour),
    creditCardMessage: text(value.creditCardMessage), cancellationPolicy: obj(value.creditCardCancellationPolicy) ? {
      cancellable: bool(value.creditCardCancellationPolicy.cancellable), cancellationCutoffDate: text(value.creditCardCancellationPolicy.cancellationCutoffDate), cancellationCutoffUtcDate: text(value.creditCardCancellationPolicy.cancellationCutoffUtcDate),
    } : null,
    dateMessages: messages(value.dateMessages), terms: text(value.termsAndConditions?.message),
    hasDeposit: obj(value.depositDetails), hasPrepaidExperience: obj(value.experienceInvoiceSummary) || obj(value.experienceInvoiceDetails),
    cancellationSupported: !['Seated', 'AssumedSeated', 'SeatedDisputed', 'PickedUp', 'Cancelled'].includes(value.reservationStatus) && !obj(value.depositDetails) && !obj(value.experienceInvoiceSummary) && !obj(value.experienceInvoiceDetails)
      && (value.creditCard === false || value.creditCard === true && value.creditCardCancellationPolicy?.cancellable === true),
  };
}
async function reservationReference(value, accountId) {
  const context = nativeReservation(value), reservationId = randomUUID();
  await saveState(`reservation-${reservationId}`, { version: 1, reservationId, accountId, ...context });
  return { reservationId, ...reservationProjection(value) };
}
export async function reservations(client, { page = 1 } = {}) {
  integer(page, 1, 99_999, 'Page');
  const user = await client.me(), accountId = account(user);
  const current = ownCurrent(user);
  const response = await client.request(`/api/v3/user/history/${page}`);
  if (!Array.isArray(response?.history) || !Number.isSafeInteger(response.totalCount) || response.totalCount < 0) changed('OpenTable returned an unfamiliar reservation history.');
  const upcoming = [], history = [];
  for (const raw of current) upcoming.push(await reservationReference(raw, accountId));
  for (const raw of response.history) history.push(await reservationReference(raw, accountId));
  // Native response supplies totalCount without a page size. Continue until an
  // empty page rather than inventing a fixed-size or snapshot guarantee.
  return { reservations: upcoming, history, page, totalHistoryCount: response.totalCount, nextPage: response.history.length ? page + 1 : null };
}
async function selected(client, selection) {
  const venue = await rawAvailability(client, selection.context);
  const variants = nativeSlots(venue, true).slots.flatMap(selectionVariants);
  const match = variants.filter(item => item.dateTime === selection.slot.dateTime && String(item.slotHash) === String(selection.slot.slotHash)
    && item.selectedAttribute === selection.slot.selectedAttribute && same(item.selectedDiningArea, selection.slot.selectedDiningArea));
  if (match.length !== 1) fail('TABLE_UNAVAILABLE', 'That exact table option is no longer available. Search tables again.');
  return { venue, slot: match[0] };
}
function bookingReview(venue, slot, context, dinerId) {
  return { restaurant: venueProjection(venue), slot: slotProjection(slot), partySize: context.partySize, dinerId, dateMessages: nativeSlots(venue, true).dateMessages, price: { amount: number(slot.priceAmount), currency: text(slot.currencyType) ?? text(venue.currencyCode), divisor: null, chargedNow: slot.priceAmount === 0 ? 0 : null } };
}
function reviewable(slot, review) {
  if (!standardSupported(slot)) fail('UNSUPPORTED_PAYMENT_FLOW', 'This table requires a deposit, prepayment, experience, or restricted inventory that this CLI cannot submit. Standard card guarantees can use an existing eligible wallet card.');
  if (!review.price.currency || !text(slot.slotHash) || !text(slot.token)) fail('REVIEW_UNAVAILABLE', 'OpenTable omitted the currency or table-selection fields needed to book safely.');
}
const planView = plan => ({ planId: plan.planId, kind: plan.kind, expiresAt: plan.expiresAt, review: plan.review });
export async function prepareBooking(client, { restaurantId, slotCursor, dinerId, dateTime, partySize, paymentMethodId } = {}) {
  restaurantId = bookingRestaurantId(restaurantId); recordId(slotCursor, 'Slot ID');
  return withStateLock(async () => {
    const selection = await readState(`selection-${slotCursor}`);
    if (!selection || selection.version !== 1 || selection.slotId !== slotCursor) fail('SLOT_NOT_FOUND', 'Search tables to obtain a valid slot ID.');
    if (selection.scope !== scope(client)) fail('ACCOUNT_MISMATCH', 'Search tables again using this authenticated session.');
    if (selection.expiresAt <= Date.now()) fail('SLOT_EXPIRED', 'That slot selection expired. Search tables again.');
    if (selection.context.restaurantId !== restaurantId || (dateTime !== undefined && localTime(dateTime) !== selection.context.requestedDateTime)
      || (partySize !== undefined && partySize !== selection.context.partySize)) invalid('The slot does not belong to that restaurant, date/time, and party size.');
    const user = await client.me(), accountId = account(user), selectedDiner = diners(user, dinerId);
    const fresh = await selected(client, selection);
    const review = bookingReview(fresh.venue, fresh.slot, selection.context, selectedDiner);
    reviewable(fresh.slot, review);
    let payment = null;
    if (guaranteed(fresh.slot)) {
      const card = selectCard(user, paymentMethodId);
      payment = { cardId: cardId(card.id), tokenHash: digest(card.token), provider: await provider(client) };
      review.paymentMethod = { ...cardView(card), provider: payment.provider };
    } else if (paymentMethodId !== undefined) invalid('This table does not require a card guarantee.');
    const planId = randomUUID();
    const plan = { version: 1, planId, kind: 'booking', accountId, selection: { ...selection, slot: fresh.slot }, dinerId: selectedDiner, payment, baselineReview: review, review, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + lifetime).toISOString(), operationId: null };
    await saveState(`plan-${planId}`, plan);
    return planView(plan);
  });
}
async function ownReservation(client, accountId, context, user) {
  user ??= await client.me();
  if (account(user) !== accountId) fail('ACCOUNT_MISMATCH', 'This reservation belongs to another account.');
  const own = ownCurrent(user).filter(value => String(value.restaurant?.id) === context.restaurantId && String(value.confirmationNumber) === context.confirmationNumber && value.token === context.securityToken);
  if (own.length !== 1) fail('RESERVATION_NOT_FOUND', 'That reservation is not in your current account reservations.');
  if (own[0].gpid !== undefined && own[0].gpid !== null && String(own[0].gpid) !== accountId) fail('RESERVATION_NOT_OWNED', 'Your account can view this reservation but its owner is another diner.');
  const raw = await client.request('/api/v3/user/reservation', { query: { rid: context.restaurantId, confirmationNumber: context.confirmationNumber, securityToken: context.securityToken } });
  const parsed = nativeReservation(raw);
  if (parsed.restaurantId !== context.restaurantId || parsed.confirmationNumber !== context.confirmationNumber || parsed.securityToken !== context.securityToken) changed('OpenTable returned another reservation.');
  if (raw.gpid !== undefined && raw.gpid !== null && String(raw.gpid) !== accountId) fail('RESERVATION_NOT_OWNED', 'OpenTable returned a reservation owned by another diner.');
  return raw;
}
function cancellationReview(raw) {
  const review = reservationProjection(raw);
  if (review.reservationStatus === 'Cancelled') fail('ALREADY_CANCELLED', 'That reservation is already cancelled.');
  if (['Seated', 'AssumedSeated', 'SeatedDisputed', 'PickedUp'].includes(review.reservationStatus)) fail('CANCELLATION_NOT_ALLOWED', 'That reservation has already been fulfilled.');
  const utc = text(raw.utcDateTime);
  const endsWithZone = utc && /(?:Z|[+-]\d\d:?\d\d)$/.test(utc);
  const scheduled = utc ? Date.parse(endsWithZone ? utc : `${utc}Z`) : NaN;
  if (Number.isFinite(scheduled) && scheduled <= Date.now()) fail('CANCELLATION_NOT_ALLOWED', 'That reservation is in the past.');
  if (review.cancellationPolicy?.cancellable === false) fail('CANCELLATION_NOT_ALLOWED', 'OpenTable does not allow cancellation of this reservation.');
  if (!review.cancellationSupported) fail('UNSUPPORTED_CANCELLATION_POLICY', 'This reservation has a deposit, prepaid experience, or unknown cancellation state. Use OpenTable to review its refund terms.');
  const guarantee = review.creditCard === true || Boolean(review.creditCardLastFour || review.creditCardMessage);
  if (guarantee && (!review.cancellationPolicy || review.cancellationPolicy.cancellable !== true || !review.creditCardMessage && !review.terms && !review.restaurant.terms)) fail('REVIEW_UNAVAILABLE', 'OpenTable omitted the current card-guarantee cancellation terms.');
  return { ...review, requiresExplicitFeeAcceptance: guarantee,
    cancellationCharge: { amount: guarantee ? null : 0, currency: review.restaurant.currency, feeKnown: !guarantee,
      cutoffPassed: cutoffState(review, Date.now()), source: guarantee ? 'native_card_guarantee_policy' : 'cardless_reservation' } };
}
export async function prepareCancellation(client, { reservationId } = {}) {
  recordId(reservationId, 'Reservation ID');
  return withStateLock(async () => {
    const reference = await readState(`reservation-${reservationId}`);
    if (!reference || reference.version !== 1 || reference.reservationId !== reservationId) fail('RESERVATION_NOT_FOUND', 'Run reservations to obtain a current reservation ID.');
    const user = await client.me(), accountId = account(user);
    if (reference.accountId !== accountId) fail('ACCOUNT_MISMATCH', 'This reservation belongs to another account.');
    const raw = await ownReservation(client, accountId, reference, user);
    const review = cancellationReview(raw), planId = randomUUID();
    const plan = { version: 1, planId, kind: 'cancellation', accountId, context: { restaurantId: reference.restaurantId, confirmationNumber: reference.confirmationNumber, securityToken: reference.securityToken }, reservationId, review, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + lifetime).toISOString(), operationId: null };
    await saveState(`plan-${planId}`, plan);
    return planView(plan);
  });
}
async function loadPlan(client, planId, kind) {
  recordId(planId, 'Plan ID');
  const plan = await readState(`plan-${planId}`);
  if (!plan || plan.version !== 1 || plan.planId !== planId || plan.kind !== kind) fail('PLAN_NOT_FOUND', 'That plan does not exist.');
  const user = await client.me();
  if (plan.accountId !== account(user)) fail('ACCOUNT_MISMATCH', 'This plan belongs to another OpenTable account.');
  if (plan.operationId) fail('PLAN_ALREADY_USED', 'This plan was already submitted. Inspect its operation instead.', { operationId: plan.operationId });
  if (!(Date.parse(plan.expiresAt) > Date.now())) fail('PLAN_EXPIRED', 'Prepare a new plan before confirming.');
  const pending = await readState(`pending-${digest(plan.accountId)}`);
  if (pending) {
    const operation = await readState(`operation-${recordId(pending.operationId, 'Operation ID')}`);
    if (!operation || ['started', 'uncertain'].includes(operation.status) || operation.holdRelease === 'failed') fail('OPERATION_UNRESOLVED', 'A previous operation is unresolved. Inspect it before submitting another.', { operationId: pending.operationId });
  }
  return { plan, user };
}
async function start(plan) {
  const operationId = randomUUID();
  const operation = { version: 1, operationId, planId: plan.planId, kind: plan.kind, accountId: plan.accountId, status: 'started', stage: 'prepared', summary: plan.review, result: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await saveState(`operation-${operationId}`, operation);
  await saveState(`pending-${digest(plan.accountId)}`, { operationId });
  plan.operationId = operationId;
  await saveState(`plan-${plan.planId}`, plan);
  return operation;
}
async function update(operation, fields) {
  Object.assign(operation, fields, { updatedAt: new Date().toISOString() });
  await saveState(`operation-${operation.operationId}`, operation);
}
const operationView = value => ({ operationId: value.operationId, planId: value.planId, kind: value.kind, status: value.status, stage: value.stage, summary: value.summary, result: value.result, holdRelease: value.holdRelease ?? null, error: value.error ?? null });
function definitive(error) { const status = error?.details?.httpStatus; return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408; }
async function release(client, operation, restaurantId, holdId) {
  try { await client.request(`/api/v3/reservation/${restaurantId}/lock`, { method: 'DELETE', query: { slotLockId: holdId } }); await update(operation, { holdRelease: 'released' }); }
  catch { try { await update(operation, { holdRelease: 'failed' }); } catch {} }
}
function holdPayload(plan, slot) {
  const body = { rid: Number(plan.selection.context.restaurantId), dateTime: slot.dateTime, partySize: plan.selection.context.partySize, hash: slot.slotHash, type: 'Standard', priceAmount: 0, requiresCreditCard: slot.requiresCreditCard, currencyType: plan.review.price.currency };
  if (guaranteed(slot)) body.creditCardPolicyType = 'HOLD';
  if (slot.selectedDiningArea) body.selectedDiningArea = slot.selectedDiningArea;
  else body.attribute = slot.selectedAttribute;
  return body;
}
function bookingPayload(plan, slot, hold, user, card) {
  const body = { rid: plan.selection.context.restaurantId, gpid: account(user), dateTime: slot.dateTime, partySize: plan.selection.context.partySize, hash: slot.slotHash, slotAvailabilityToken: slot.token, lockId: hold.id, type: 'Standard', priceAmount: 0, requiresCreditCard: slot.requiresCreditCard, currencyType: plan.review.price.currency, points: slot.points, pointsType: slot.type, isAnonymous: false, firstTime: false, diningFormOptIn: false };
  if (slot.selectedDiningArea) body.selectedDiningArea = slot.selectedDiningArea;
  else body.tableAttribute = slot.selectedAttribute;
  if (plan.dinerId !== null) body.dinerId = plan.dinerId;
  if (card) body.creditCardLock = { customerId: card.token, last4: card.last4, paymentProviderType: plan.payment.provider, tokenizationMethod: 'CREDIT_CARD' };
  if (hold.offerLockId) body.offerLockId = hold.offerLockId;
  return body;
}
function usableHoldId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value); }
function holdUnchanged(hold, plan, slot) {
  if (!obj(hold) || !usableHoldId(hold.id)) changed('OpenTable omitted the inventory hold ID.');
  if (hold.rid !== undefined && String(hold.rid) !== plan.selection.context.restaurantId
    || hold.partySize !== undefined && hold.partySize !== plan.selection.context.partySize
    || hold.date !== undefined && hold.date !== slot.dateTime) fail('PLAN_CHANGED', 'The inventory hold does not match the reviewed table.');
  const processor = hold.paymentProviderSummary?.paymentProcessor;
  if (hold.thirdPartyCreditCardFormUrl || ['FREEDOMPAY', 'FREEDOMPAY2'].includes(processor)
    || processor && !['STRIPE', 'SPREEDLY', 'UNKNOWN'].includes(processor)
    || hold.paymentProviderSummary?.shouldDisableWallet === true && plan.payment
    || hold.creditCardPolicyType === 'DEPOSIT' || obj(hold.creditCardDepositSummary) || obj(hold.depositTotalSummary)
    || obj(hold.experience) || obj(hold.ageVerificationGate)) fail('UNSUPPORTED_PAYMENT_FLOW', 'The hold requires a disabled wallet, third-party form, deposit, experience, or verification flow. No booking was sent.');
  if (plan.payment) {
    if (hold.creditCardPolicyType !== 'HOLD') fail('PLAN_CHANGED', 'The hold is not the reviewed card guarantee.');
    if (!text(hold.creditCardMessage) && !plan.review.restaurant.terms) fail('REVIEW_UNAVAILABLE', 'OpenTable omitted the card guarantee terms.');
  } else if (['HOLD', 'DEPOSIT'].includes(hold.creditCardPolicyType) || hold.creditCardLockURL || hold.creditCardMessage || obj(hold.creditCardCancellationPolicy)) fail('PLAN_CHANGED', 'The hold introduced card or cancellation requirements. No booking was sent.');
}
function holdTerms(hold) {
  const policy = hold.creditCardCancellationPolicy;
  const summary = hold.paymentProviderSummary;
  return { creditCardPolicyType: text(hold.creditCardPolicyType), creditCardMessage: text(hold.creditCardMessage), cancellationPolicy: obj(policy) ? { cancellable: bool(policy.cancellable), cancellationCutoffDate: text(policy.cancellationCutoffDate), cancellationCutoffUtcDate: text(policy.cancellationCutoffUtcDate) } : null,
    paymentProviderSummary: obj(summary) ? { tokenizationProvider: text(summary.tokenizationProvider), paymentProcessor: text(summary.paymentProcessor), shouldDisableWallet: bool(summary.shouldDisableWallet), shouldHidePlatformPayment: bool(summary.shouldHidePlatformPayment) } : null };
}
async function reviewHold(client, operation, plan, hold, policy) {
  await release(client, operation, plan.selection.context.restaurantId, hold.id);
  if (operation.holdRelease !== 'released') fail('HOLD_RELEASE_FAILED', 'The unused hold could not be released. Inspect this operation before another attempt.', { operationId: operation.operationId });
  const planId = randomUUID();
  const next = { ...plan, planId, operationId: null, expectedHoldTerms: policy, previousOperationId: operation.operationId,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + lifetime).toISOString(), review: { ...plan.baselineReview, guaranteePolicy: policy } };
  await saveState(`plan-${planId}`, next);
  await update(operation, { status: 'review_required', stage: 'hold_terms_review', result: { nextPlanId: planId } });
  return { ...operationView(operation), nextPlan: planView(next) };
}
async function failure(operation, error, certainty) {
  const status = certainty ?? (definitive(error) ? 'rejected' : 'uncertain');
  try { await update(operation, { status, error: { code: error instanceof OpenTableError ? error.code : 'REQUEST_FAILED', message: status === 'uncertain' ? 'The server outcome is uncertain. Check your reservations before attempting another operation.' : 'The operation was stopped or rejected. No automatic retry was sent.' } }); } catch {}
  fail(status === 'uncertain' ? 'OPERATION_UNCERTAIN' : 'OPERATION_REJECTED', status === 'uncertain' ? 'The result is uncertain. Do not repeat it; inspect the operation and your reservations.' : 'The operation was stopped. Inspect its record before preparing another.', { operationId: operation.operationId, stage: operation.stage, holdRelease: operation.holdRelease ?? null });
}
export async function confirmBooking(client, { planId } = {}) {
  return withStateLock(async () => {
    const { plan, user } = await loadPlan(client, planId, 'booking');
    if (diners(user, plan.dinerId ?? undefined) !== plan.dinerId) fail('PLAN_CHANGED', 'Your booking identity changed. Prepare a new plan.');
    bookingRestaurantId(plan.selection.context.restaurantId);
    const fresh = await selected(client, plan.selection), review = bookingReview(fresh.venue, fresh.slot, plan.selection.context, plan.dinerId);
    reviewable(fresh.slot, review);
    let selectedPayment = null;
    if (plan.payment) {
      selectedPayment = selectCard(user, plan.payment.cardId);
      const currentProvider = await provider(client);
      if (digest(selectedPayment.token) !== plan.payment.tokenHash || currentProvider !== plan.payment.provider) fail('PLAN_CHANGED', 'Your selected wallet card or payment provider changed. Prepare a new plan.');
      review.paymentMethod = { ...cardView(selectedPayment), provider: currentProvider };
    }
    if (!same(plan.baselineReview ?? plan.review, review)) fail('PLAN_CHANGED', 'The table, price, or restaurant terms changed. Prepare a new plan.');
    if (ownCurrent(user).some(raw => String(raw.restaurant?.id) === plan.selection.context.restaurantId && text(raw.dateTime)?.slice(0, 10) === fresh.slot.dateTime.slice(0, 10) && raw.reservationStatus !== 'Cancelled')) fail('RESERVATION_CONFLICT', 'Your account already has a reservation at this restaurant on that date.');
    const operation = await start(plan);
    let hold, submitted = false;
    try {
      await update(operation, { stage: 'acquiring_hold' });
      hold = await client.request(`/api/v3/reservation/${plan.selection.context.restaurantId}/lock`, { method: 'POST', json: holdPayload(plan, fresh.slot) });
      if (obj(hold) && Number.isSafeInteger(hold.id)) hold = { ...hold, id: String(hold.id) };
      await update(operation, { stage: 'hold_acquired', holdId: usableHoldId(hold?.id) ? hold.id : null });
      holdUnchanged(hold, plan, fresh.slot);
      if (plan.payment) {
        const policy = holdTerms(hold);
        if (!same(plan.expectedHoldTerms, policy)) return await reviewHold(client, operation, plan, hold, policy);
      }
      await update(operation, { stage: 'booking' });
      submitted = true;
      const raw = await client.request(`/api/v3/reservation/${plan.selection.context.restaurantId}`, { method: 'POST', json: bookingPayload(plan, fresh.slot, hold, user, selectedPayment) });
      const result = nativeReservation(raw);
      if (result.restaurantId !== plan.selection.context.restaurantId || raw.dateTime !== fresh.slot.dateTime || raw.partySize !== plan.selection.context.partySize) changed('OpenTable returned an unfamiliar booking result.');
      const reference = await reservationReference(raw, plan.accountId);
      await update(operation, { status: 'completed', stage: 'booked', result: reference, holdRelease: 'consumed' });
      return operationView(operation);
    } catch (error) {
      // Do not release a hold after an ambiguous booking: it may have been
      // consumed by a successful booking. The durable pending record blocks replay.
      const certainty = submitted ? (definitive(error) ? 'rejected' : 'uncertain') : usableHoldId(hold?.id) ? 'rejected' : hold !== undefined ? 'uncertain' : definitive(error) ? 'rejected' : 'uncertain';
      if (usableHoldId(hold?.id) && (!submitted || certainty === 'rejected') && operation.holdRelease == null) await release(client, operation, plan.selection.context.restaurantId, hold.id);
      return failure(operation, error, certainty);
    }
  });
}
function cutoffState(review, now) {
  const value = review.cancellationPolicy?.cancellationCutoffUtcDate;
  const cutoff = typeof value === 'string' && /(?:Z|[+-]\d\d:?\d\d)$/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(cutoff) ? now >= cutoff : null;
}
export async function confirmCancellation(client, { planId, acceptUnknownFee = false } = {}) {
  if (typeof acceptUnknownFee !== 'boolean') invalid('Unknown-fee acceptance must be an explicit boolean.');
  return withStateLock(async () => {
    const { plan, user } = await loadPlan(client, planId, 'cancellation');
    const raw = await ownReservation(client, plan.accountId, plan.context, user), review = cancellationReview(raw);
    if (!same(plan.review, review) || cutoffState(plan.review, Date.parse(plan.createdAt)) !== cutoffState(review, Date.now())) fail('PLAN_CHANGED', 'The cancellation policy or reservation changed. Prepare a new cancellation plan.');
    if (review.requiresExplicitFeeAcceptance && acceptUnknownFee !== true) fail('FEE_APPROVAL_REQUIRED', 'This card-guaranteed reservation may charge a cancellation fee. Review its native policy and explicitly accept the unknown fee before confirming.');
    const operation = await start(plan);
    try {
      await update(operation, { stage: 'cancelling' });
      await client.request(`/api/v3/reservation/${plan.context.restaurantId}/${plan.context.confirmationNumber}`, { method: 'DELETE', query: { token: plan.context.securityToken } });
      await update(operation, { stage: 'verifying_cancellation' });
      const check = await client.request('/api/v3/user/reservation', { query: { rid: plan.context.restaurantId, confirmationNumber: plan.context.confirmationNumber, securityToken: plan.context.securityToken } });
      const parsed = nativeReservation(check);
      if (parsed.restaurantId !== plan.context.restaurantId || parsed.confirmationNumber !== plan.context.confirmationNumber || check.reservationStatus !== 'Cancelled') fail('CANCELLATION_UNCONFIRMED', 'OpenTable has not confirmed cancellation of this reservation.');
      await update(operation, { status: 'completed', stage: 'cancelled', result: { reservationId: plan.reservationId, confirmationNumber: plan.context.confirmationNumber } });
      return operationView(operation);
    } catch (error) { return failure(operation, error, operation.stage === 'verifying_cancellation' ? 'uncertain' : undefined); }
  });
}
export async function inspectOperation({ operationId, client } = {}) {
  recordId(operationId, 'Operation ID');
  if (!client) fail('LOGIN_REQUIRED', 'Sign in to inspect this operation.');
  const operation = await readState(`operation-${operationId}`);
  if (!operation || operation.version !== 1 || operation.operationId !== operationId) fail('OPERATION_NOT_FOUND', 'That operation does not exist.');
  if (operation.accountId !== account(await client.me())) fail('ACCOUNT_MISMATCH', 'That operation belongs to another account.');
  return operationView(operation);
}
