import { randomUUID, createHash } from 'node:crypto';
import { createClient } from './client.mjs';
import { readState, saveState, withStateLock } from './state.mjs';
import { AirbnbError } from './errors.mjs';
import { requireSuccess } from './http.mjs';
import { buildStaysCheckout, parseStayCheckoutPreview, prepareSavedCardPaymentOption, buildStayProductDetails,
  buildPlaceOrder, parsePlaceOrderResult, buildCheckoutConfirmation, parseCheckoutConfirmation } from './booking-protocol.mjs';

const TTL = 10 * 60_000;
const SUPPORTED_SECTIONS = new Set(['ConfirmAndPaySection', 'PaymentCreditsAndCouponSection', 'FirstMessageSection',
  'InsuranceSection', 'PaymentOptionsSection', 'PaymentPlanSelectionSection', 'PriceDetailSection',
  'CheckoutProductDetailSection', 'TermsAndConditionsSection']);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => { throw new AirbnbError(code, message); };
function owner(session) {
  if (!session?.token || typeof session.userId !== 'string' || !session.userId) fail('AUTH_REQUIRED', 'Sign in before preparing a booking.');
  return session.userId;
}
export function moneyCeiling(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value) || value.length > 30) fail('INVALID_ARGUMENT', 'Provide a nonnegative decimal maximum total, such as 123.45.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}
function totalOf(preparation) {
  const total = preparation.totalAmount;
  if (typeof total?.amountMicros !== 'string' || !/^[0-9]+$/.test(total.amountMicros) || !/^[A-Z]{3}$/.test(total.currency ?? '')) {
    fail('CHECKOUT_INCOMPLETE', 'Airbnb did not supply an exact checkout total and currency.');
  }
  return { amountMicros: total.amountMicros, currency: total.currency, display: total.amountFormatted ?? null };
}
function paymentChoices(preparation) {
  return (preparation.paymentOptions ?? []).map((option, index) => {
    let supported = false;
    try { prepareSavedCardPaymentOption(option); supported = true; } catch {}
    return { id: `payment-${index + 1}`, label: option.displayName ?? null,
      brand: option.creditCardDetails?.cardType ?? null, lastFour: option.creditCardDetails?.lastFour ?? null,
      existing: option.isExistingInstrument === true, cvvRequired: option.isCvvRequiredForPayment,
      supported, ...(supported ? {} : { actionRequired: 'This payment option requires a separate payment or verification flow.' }) };
  });
}
function reviewPublic(review) {
  return { reviewId: review.id, status: review.submission ? review.submission.phase : 'review_required',
    expiresAt: new Date(review.expiresAt).toISOString(), stay: review.stay, title: review.title,
    total: review.total, priceItems: review.priceItems, paymentOptions: review.paymentOptions,
    terms: review.terms, termsHash: review.termsHash, hostMessage: review.hostMessage,
    bookingAction: review.bookingAction, requiredActions: review.requiredActions,
    next: `airbnb booking confirm --review-id ${review.id} --payment-option PAYMENT_ID --max-total AMOUNT --currency ${review.total.currency} --accept-terms ${review.termsHash} --confirm` };
}
function recordName(id) {
  if (typeof id !== 'string' || !ID.test(id)) fail('INVALID_ARGUMENT', 'Provide a valid review ID.');
  return `booking-review-${id}`;
}
function publicSubmission(review) {
  const attempt = review.submission;
  if (!attempt) return reviewPublic(review);
  if (attempt.phase === 'pending') return { reviewId: review.id, outcome: 'unknown', confirmed: false,
    message: 'The request has an uncertain outcome. Do not repeat the booking; use booking status to inspect its recorded result.' };
  let parsed;
  try { parsed = parsePlaceOrderResult(requireSuccess(attempt.response)); }
  catch { return { reviewId: review.id, outcome: 'unknown', confirmed: false, httpStatus: attempt.response?.status,
    message: 'Airbnb did not return a recognized terminal booking result. This review cannot submit again.' }; }
  return { reviewId: review.id, outcome: parsed.outcome, confirmed: parsed.confirmed, terminal: parsed.terminal,
    orderId: parsed.orderId, ...(parsed.confirmed ? { confirmationCode: review.preparation.confirmationCode } : {}),
    status: parsed.status, error: parsed.error, checkoutActions: parsed.checkoutActions };
}

export async function prepareBooking(options = {}) {
  // Validate all stay inputs before any state/network operation.
  const spec = { ...buildStaysCheckout({ ...options, bookingAttemptId: randomUUID() }), ...(options.currency ? { currency: options.currency } : {}) };
  const session = await readState('session'), userId = owner(session);
  const client = await createClient({ session });
  const response = await client.response(spec);
  const parsed = parseStayCheckoutPreview(requireSuccess(response));
  const preparation = parsed.preparation, total = totalOf(preparation);
  const sectionData = preparation.sectionData ?? [];
  const product = sectionData.find(section => section?.__typename === 'CheckoutProductDetailSection');
  const terms = sectionData.filter(section => ['TermsAndConditionsSection', 'CheckoutProductDetailSection', 'ConfirmAndPaySection'].includes(section?.__typename));
  if (!terms.length) fail('CHECKOUT_INCOMPLETE', 'Airbnb did not supply checkout terms for review.');
  const messageSection = sectionData.find(section => section?.__typename === 'FirstMessageSection');
  const confirmation = sectionData.find(section => section?.__typename === 'ConfirmAndPaySection');
  const id = randomUUID();
  const requiredActions = [];
  if (messageSection) requiredActions.push({ type: 'host_message', prompt: messageSection.subtitle ?? messageSection.title });
  for (const section of sectionData) {
    if (!SUPPORTED_SECTIONS.has(section?.__typename)) requiredActions.push({ type: 'unsupported_section', sectionType: section?.__typename ?? null });
    if (section?.__typename === 'ConfirmAndPaySection' && (section.freezeDetails != null || section.thirdPartyStayBookingData != null)) requiredActions.push({ type: 'booking_action', message: 'Airbnb requires an additional booking or identity action.' });
    if (section?.__typename === 'InsuranceSection' && section.isActive === true) requiredActions.push({ type: 'insurance', message: 'The current quote includes an active insurance option; a separate explicit choice is required.' });
  }
  const review = { version: 1, id, owner: userId, createdAt: Date.now(), expiresAt: Date.now() + TTL,
    stay: { listingId: String(options.listingId), checkin: options.checkin, checkout: options.checkout,
      adults: options.adults ?? 1, children: options.children ?? 0, infants: options.infants ?? 0, pets: options.pets ?? 0 },
    title: product?.productListingDetails?.title ?? null,
    total, priceItems: preparation.priceItems, paymentOptions: paymentChoices(preparation),
    terms, termsHash: hash(terms), requiredActions,
    bookingAction: confirmation ? { title: confirmation.title, subtitle: confirmation.subtitle, isInstantBookable: confirmation.isInstantBookable, freezeDetails: confirmation.freezeDetails } : null,
    hostMessage: messageSection ? { title: messageSection.title, prompt: messageSection.subtitle, hostNote: messageSection.hostMessage } : null,
    preparation, response, submission: null };
  await saveState(recordName(id), review);
  return { ...reviewPublic(review), ...(options.raw ? { raw: response.body } : {}) };
}

export async function confirmBooking({ reviewId, paymentOption, maxTotal, currency, acceptTerms, messageToHost, confirm = false } = {}) {
  const name = recordName(reviewId);
  if (confirm !== true) fail('CONFIRMATION_REQUIRED', 'Booking requires explicit confirmation after the user reviews this exact stay, price, payment and terms.');
  const ceiling = moneyCeiling(maxTotal);
  return withStateLock(async () => {
    const review = await readState(name), session = await readState('session');
    if (!review || review.owner !== owner(session)) fail('REVIEW_NOT_FOUND', 'No matching review for the signed-in account.');
    if (review.submission) return publicSubmission(review);
    if (Date.now() >= review.expiresAt) fail('REVIEW_EXPIRED', 'Prepare and review a fresh checkout before booking.');
    if (acceptTerms !== review.termsHash || hash(review.terms) !== review.termsHash) fail('TERMS_REVIEW_REQUIRED', 'Accept the exact termsHash from this checkout review.');
    if (currency !== review.total.currency || BigInt(review.total.amountMicros) > ceiling) fail('PRICE_LIMIT_EXCEEDED', 'The reviewed total exceeds the approved maximum or uses a different currency.');
    if (review.requiredActions.some(action => action.type !== 'host_message')) fail('CHECKOUT_ACTION_REQUIRED', 'This quote needs an additional explicit checkout choice.');
    if (review.hostMessage && (typeof messageToHost !== 'string' || !messageToHost.trim())) fail('HOST_MESSAGE_REQUIRED', 'Provide the exact host message approved by the user; the CLI does not invent one.');
    if (messageToHost !== undefined && (typeof messageToHost !== 'string' || !messageToHost.trim() || messageToHost.length > 10_000)) fail('INVALID_ARGUMENT', 'Provide a nonempty host message of at most 10,000 characters.');
    const index = review.paymentOptions.findIndex(option => option.id === paymentOption && option.supported === true);
    if (index < 0) fail('PAYMENT_ACTION_REQUIRED', 'Choose a supported saved card from this exact review. CVV/3DS/new-card flows are not submitted.');
    const selectedPaymentOption = prepareSavedCardPaymentOption(review.preparation.paymentOptions[index]);
    const spec = buildPlaceOrder({ placeOrder: { bookingQuoteId: review.preparation.bookingQuoteId,
      orderId: review.preparation.orderId, paymentParams: { paymentQuoteId: review.preparation.paymentQuoteId, selectedPaymentOption },
      productDetails: buildStayProductDetails(messageToHost === undefined ? {} : { messageToHost }) } });
    const client = await createClient({ session });
    const intent = `booking-intent-${hash({ owner: review.owner, stay: review.stay })}`;
    const priorIntent = await readState(intent);
    if (priorIntent && !['failed', 'cancelled'].includes(priorIntent.phase)) fail('BOOKING_ALREADY_ATTEMPTED', 'This account already has a submitted or uncertain booking for the same stay. Inspect that booking before preparing another submission.');
    review.intent = intent;
    await saveState(intent, { reviewId, phase: 'pending', createdAt: Date.now() });
    review.submission = { phase: 'pending', startedAt: Date.now(), request: spec };
    await saveState(name, review);
    const response = await client.response(spec);
    review.submission = { ...review.submission, phase: 'responded', response, receivedAt: Date.now() };
    await saveState(name, review);
    const result = publicSubmission(review);
    await saveState(intent, { reviewId, phase: result.outcome === 'failed' ? 'failed' : result.confirmed ? 'confirmed' : 'pending', updatedAt: Date.now() });
    return result;
  });
}

export async function bookingStatus({ reviewId, lookup = false } = {}) {
  const review = await readState(recordName(reviewId)), session = await readState('session');
  if (!review || review.owner !== owner(session)) fail('REVIEW_NOT_FOUND', 'No matching review for the signed-in account.');
  const result = publicSubmission(review);
  if (lookup && review.submission && review.preparation.confirmationCode) {
    const client = await createClient({ session });
    const response = await client.request(buildCheckoutConfirmation({ confirmationCode: review.preparation.confirmationCode }));
    result.confirmation = parseCheckoutConfirmation(response);
    // Presentation data alone cannot turn an uncertain fulfillment into success.
  }
  return result;
}
