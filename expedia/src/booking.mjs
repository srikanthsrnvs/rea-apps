import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { withClient } from './auth.mjs';
import { readState, saveState } from './state.mjs';
import { ExpediaError } from './errors.mjs';
import { checkoutRecord, assertCheckoutMutable, fetchCheckout, preview } from './checkout.mjs';
import { assertRecordOwner } from './flights.mjs';
import { checkoutPreview, checkoutFormFields, checkoutPaymentOptions, buildPaymentSelectionMutation, normalizePaymentSelection, buildNewCardTokenizationRequest, normalizeCardTokenizationResult, buildCardPaymentUpdateMutation, normalizeCardPaymentUpdate, buildFlightBookingMutation, normalizeFlightBookingResult, buildFlightBookingStatusQuery, normalizeFlightBookingStatus, buildCheckoutSessionQuery } from './checkout-protocol.mjs';

const fail = (code, message) => { throw new ExpediaError(code, message); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function review(record) {
  const { sessionId, tripId, ...value } = checkoutPreview(record.checkout);
  const travelerContact = checkoutFormFields(record.checkout, { type: 'CONTACT_INFORMATION' }).map(form => ({
    type: form.type, fields: form.fields.map(field => {
      const submitted = record.formValues?.[form.type];
      const current = submitted && Object.hasOwn(submitted, field.inputId) ? submitted[field.inputId] : field.value;
      const normalized = part => field.options?.find(option => option.value === part)?.label ?? part;
      return { key: field.key, label: field.label, value: Array.isArray(current) ? current.map(normalized) : normalized(current) };
    }),
  }));
  return { ...value, travelerContact, readyToBook: readiness(record).ready, payment: record.paymentReceipt ? { method: 'card', last4: record.paymentReceipt.last4, state: record.paymentReceipt.state } : value.payment };
}
function readiness(record) {
  const missingForms = record.checkout.forms.filter(form => !(record.validatedForms ?? []).includes(form.type)).map(form => form.type);
  const price = checkoutPreview(record.checkout).price;
  const trustReady = record.checkout.trustRequirement?.allowsEmpty === true;
  return { ready: !missingForms.length && record.paymentReceipt?.state === 'updated' && trustReady && Boolean(price && Number.isFinite(price.amount) && price.amount > 0 && /^[A-Z]{3}$/.test(price.currency)), missingForms, paymentState: record.paymentReceipt?.state ?? 'required', trustState: trustReady ? 'empty_payload_supported' : 'user_action_required' };
}
export function bookingFingerprint(record) {
  const value = review(record);
  return digest({ price: value.price, itinerary: value.itinerary, conditions: value.conditions, formValues: record.formValues, payment: record.paymentReceipt, detailId: record.detailId });
}

export async function updateCardPayment({ checkoutId, paymentOptionId, cardFile }) {
  let card;
  try {
    const stat = await fs.stat(cardFile);
    if (!stat.isFile() || stat.size > 65536) fail('INVALID_CARD_FILE', 'The card input must be a small JSON file.');
    card = JSON.parse(await fs.readFile(cardFile, 'utf8'));
  } catch (error) { if (error instanceof ExpediaError) throw error; fail('INVALID_CARD_FILE', 'The card input file could not be read as JSON.'); }
  return withClient(async (client, context) => {
    const record = await checkoutRecord(checkoutId, context);
    assertCheckoutMutable(record);
    if (record.paymentPhase === 'pending') fail('PAYMENT_OUTCOME_UNKNOWN', 'The previous payment setup has an uncertain outcome. It was not repeated.');
    // Build and validate in memory before recording an attempt. PAN/CVV never enter state.
    let request = buildNewCardTokenizationRequest(record.checkout, card, { paymentOptionId });
    record.planId = null; record.paymentPhase = 'pending'; record.paymentReceipt = null;
    await saveState(`checkout-${record.id}`, record);
    if (checkoutPaymentOptions(record.checkout).find(option => option.id === paymentOptionId)?.state !== 'STATE_SELECTED') {
      const selection = buildPaymentSelectionMutation(record.checkout, { paymentOptionId });
      const selected = normalizePaymentSelection(await client.graphql({ ...selection, group: 'checkout' }));
      if (selected.state !== 'selected' || selected.checkoutIdentifier?.sessionId !== record.checkout.sessionId) fail('PAYMENT_SELECTION_FAILED', 'Expedia did not confirm this card option. No booking was submitted.');
      record.checkout = await fetchCheckout(client, record.checkout.checkoutUrl, { preparation: false });
      if (checkoutPaymentOptions(record.checkout).find(option => option.id === paymentOptionId)?.state !== 'STATE_SELECTED') fail('PAYMENT_SELECTION_FAILED', 'The refreshed checkout selected a different payment option.');
      request = buildNewCardTokenizationRequest(record.checkout, card, { paymentOptionId });
    }
    const tokenResponse = await client.request(request.url, { method: request.method, headers: request.headers, body: request.body, includeCookies: false });
    const { edgeToken } = normalizeCardTokenizationResult(tokenResponse);
    const update = buildCardPaymentUpdateMutation(record.checkout, { paymentOptionId, edgeToken, billingCountry: card.billingAddress?.countryCode });
    const response = await client.graphql({ ...update, group: 'checkout' });
    if (response.errors?.length) fail('PAYMENT_UPDATE_UNCERTAIN', 'Expedia did not confirm the payment setup. No booking was submitted.');
    const result = normalizeCardPaymentUpdate(response);
    if (result.checkoutIdentifier?.sessionId !== record.checkout.sessionId || typeof result.checkoutIdentifier?.sessionToken !== 'string') fail('PAYMENT_SESSION_MISMATCH', 'Expedia returned a different payment checkout session. No booking was submitted.');
    record.checkout.sessionToken = result.checkoutIdentifier.sessionToken;
    record.paymentReceipt = { state: result.state, paymentOptionId, last4: request.body.card_number.slice(-4), updatedAt: new Date().toISOString() };
    // Challenge material stays private; a challenge is never interpreted as payment approval.
    record.paymentChallenge = result.state === 'requires_action' ? { authenticationSpec: result.authenticationSpec, challenge: result.challenge } : null;
    record.paymentPhase = 'ready';
    await saveState(`checkout-${record.id}`, record);
    return { checkoutId: record.id, status: result.state, payment: { last4: record.paymentReceipt.last4 }, userActionRequired: result.state === 'requires_action', bookingSubmitted: false };
  });
}

export async function prepareBooking({ checkoutId }) {
  return withClient(async (client, context) => {
    const record = await checkoutRecord(checkoutId, context);
    if (record.operationId) return inspectOperationRecord(record.operationId, context);
    assertCheckoutMutable(record);
    const check = readiness(record);
    if (!check.ready) return { ...preview(record), status: 'input_required', ...check };
    const planId = randomUUID();
    const plan = { id: planId, checkoutId, owner: record.owner, fingerprint: bookingFingerprint(record), review: review(record), expiresAt: new Date(Math.min(Date.now() + 5 * 60000, Date.parse(record.expiresAt))).toISOString() };
    record.planId = planId;
    await saveState(`plan-${planId}`, plan); await saveState(`checkout-${record.id}`, record);
    return { planId, checkoutId, status: 'approval_required', expiresAt: plan.expiresAt, review: plan.review };
  });
}

async function inspectOperationRecord(operationId, context) {
  const record = await readState(`operation-${operationId}`);
  if (!record) fail('OPERATION_NOT_FOUND', 'This booking operation was not found.');
  assertRecordOwner(record, context);
  return { operationId, checkoutId: record.checkoutId, status: record.status, outcome: record.outcome ?? null, ticketingStatus: record.outcome?.ticketingStatus ?? 'unverified', submittedAt: record.submittedAt };
}
export async function confirmBooking({ planId, confirm }) {
  if (confirm !== true) fail('APPROVAL_REQUIRED', 'Review the prepared flight and approve it before using --confirm.');
  return withClient(async (client, context) => {
    const plan = await readState(`plan-${planId}`);
    if (!plan || Date.parse(plan.expiresAt) <= Date.now()) fail('PLAN_EXPIRED', 'Prepare a fresh booking review before confirming.');
    assertRecordOwner(plan, context);
    const record = await checkoutRecord(plan.checkoutId, context);
    if (record.operationId) return inspectOperationRecord(record.operationId, context);
    assertCheckoutMutable(record);
    if (record.planId !== planId || bookingFingerprint(record) !== plan.fingerprint || !readiness(record).ready) fail('REVIEW_CHANGED', 'Checkout details changed. Prepare and approve a new booking review.');
    // Re-read server fare and conditions before any purchase. A change requires new approval.
    const current = await fetchCheckout(client, record.checkout.checkoutUrl, { preparation: false });
    const fresh = { ...record, checkout: current };
    if (!checkoutPaymentOptions(current).some(option => option.id === record.paymentReceipt.paymentOptionId && option.state === 'STATE_SELECTED')) fail('PAYMENT_SELECTION_CHANGED', 'Expedia changed the selected payment method. Prepare a new review before booking.');
    if (bookingFingerprint(fresh) !== plan.fingerprint) {
      record.checkout = current; record.planId = null;
      await saveState(`checkout-${record.id}`, record);
      return { checkoutId: record.id, status: 'review_required', reason: 'Expedia changed the checkout price or terms.', review: review(record) };
    }
    const validation = await client.graphql({ ...buildCheckoutSessionQuery(current), group: 'checkout' });
    const session = validation.data?.checkout?.getSession;
    if (!session?.token || validation.errors?.length) fail('CHECKOUT_VALIDATION_FAILED', 'Expedia did not validate this checkout. No booking was submitted.');
    if (session.signals?.length || session.serverSignals?.length) fail('CHECKOUT_ACTION_REQUIRED', 'Expedia returned checkout actions that need review. No booking was submitted.');
    current.sessionToken = session.token;
    const request = buildFlightBookingMutation(current);
    const operationId = randomUUID();
    // Dedupe identical unresolved purchases even if a model prepares another checkout.
    const travelers = Object.entries(record.formValues?.CONTACT_INFORMATION ?? {}).map(([key, value]) => [key.split('||')[0], value]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const intentKey = digest({ owner: record.owner, itinerary: plan.review.itinerary, travelers });
    const previous = await readState(`intent-${intentKey}`);
    if (previous) return inspectOperationRecord(previous.operationId, context);
    const operation = { id: operationId, checkoutId: record.id, owner: record.owner, status: 'submitting', submittedAt: new Date().toISOString(), orderId: null, orderNumber: null };
    record.operationId = operationId; record.checkout = current; record.bookingPhase = 'submission_pending';
    // Freeze the checkout before publishing its journal. A crash at any later
    // write leaves a blocked checkout rather than an apparently fresh purchase.
    await saveState(`checkout-${record.id}`, record);
    await saveState(`operation-${operationId}`, operation);
    await saveState(`intent-${intentKey}`, { operationId });
    try {
      const response = await client.graphql({ ...request, group: 'checkout' });
      const data = response.data?.book?.data;
      if (typeof data?.checkoutSessionToken === 'string') record.checkout.sessionToken = data.checkoutSessionToken;
      operation.outcome = normalizeFlightBookingResult(response);
      operation.orderId = operation.outcome.orderId; operation.orderNumber = operation.outcome.orderNumber;
      operation.status = operation.outcome.status;
      record.bookingPhase = 'submitted';
      await saveState(`operation-${operationId}`, operation);
      await saveState(`checkout-${record.id}`, record);
    } catch {
      operation.status = 'outcome_unknown';
      record.bookingPhase = 'outcome_unknown';
      await saveState(`operation-${operationId}`, operation);
      await saveState(`checkout-${record.id}`, record);
    }
    return inspectOperationRecord(operationId, context);
  });
}
export async function inspectOperation({ operationId, refresh = false }) {
  return withClient(async (client, context) => {
    const operation = await readState(`operation-${operationId}`);
    if (!operation) fail('OPERATION_NOT_FOUND', 'This booking operation was not found.');
    assertRecordOwner(operation, context);
    if (refresh && operation.orderId && operation.orderNumber && !['booked', 'failed'].includes(operation.status)) {
      const record = await readState(`checkout-${operation.checkoutId}`);
      if (!record) fail('CHECKOUT_NOT_FOUND', 'This operation has no saved checkout context.');
      assertRecordOwner(record, context);
      const request = buildFlightBookingStatusQuery(record.checkout, operation);
      const response = await client.graphql({ ...request, group: 'checkout' });
      const result = normalizeFlightBookingStatus(response);
      operation.status = result.status;
      operation.outcome = { ...operation.outcome, ...result };
      await saveState(`operation-${operationId}`, operation);
    }
    return inspectOperationRecord(operationId, context);
  });
}
