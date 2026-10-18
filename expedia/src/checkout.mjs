import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { withClient } from './auth.mjs';
import { readState, saveState } from './state.mjs';
import { ExpediaError } from './errors.mjs';
import { assertRecordOwner, recordOwner } from './flights.mjs';
import { extractFlightCheckoutUrl, validateFlightCheckoutUrl, parseCheckoutApolloState, checkoutFromApolloState, checkoutPreview, buildCheckoutSessionQuery, buildSmartFormMutation, checkoutInputTemplate, checkoutFormFields, checkoutPaymentOptions, normalizeSmartFormResult } from './checkout-protocol.mjs';

function fail(code, message) { throw new ExpediaError(code, message); }
export async function checkoutRecord(id, context) {
  const record = await readState(`checkout-${id}`);
  if (!record) fail('CHECKOUT_NOT_FOUND', 'This checkout was not found. Prepare it from a current flight selection.');
  if (Date.parse(record.expiresAt) <= Date.now()) fail('CHECKOUT_EXPIRED', 'This checkout expired. Search again for current availability and fares.');
  assertRecordOwner(record, context);
  return record;
}
export function assertCheckoutMutable(record) {
  if (record.operationId || ['submission_pending', 'submitted', 'outcome_unknown'].includes(record.bookingPhase)) fail('BOOKING_ALREADY_SUBMITTED', 'Inspect the existing booking operation before changing this checkout.');
}

export function preview(record) {
  const { sessionId, tripId, ...review } = checkoutPreview(record.checkout);
  return { checkoutId: record.id, status: 'review_required', expiresAt: record.expiresAt, review,
    forms: checkoutFormFields(record.checkout, { billingCountry: record.billingCountry }), inputTemplate: checkoutInputTemplate(record.checkout, { billingCountry: record.billingCountry }), payments: checkoutPaymentOptions(record.checkout), validatedForms: record.validatedForms ?? [],
  };
}

export async function fetchCheckout(client, url, { preparation = true } = {}) {
  let current = validateFlightCheckoutUrl(url, { preparation });
  for (let hop = 0; hop < 6; hop++) {
    const response = await client.request(current, { responseType: 'response', allowRedirectResponse: true, headers: { accept: 'text/html', 'x-page-id': 'page.Checkout.Payment,F,40' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) fail('INVALID_CHECKOUT_RESPONSE', 'Expedia returned an empty checkout redirect.');
      current = validateFlightCheckoutUrl(new URL(location, current).href); continue;
    }
    validateFlightCheckoutUrl(current);
    return checkoutFromApolloState(parseCheckoutApolloState(response.text), current);
  }
  fail('CHECKOUT_REDIRECT_LIMIT', 'Expedia returned too many checkout redirects.');
}
export async function prepareCheckout({ detailId }) {
  return withClient(async (client, context) => {
    const detail = await readState(`detail-${detailId}`);
    if (!detail || Date.parse(detail.expiresAt) <= Date.now()) fail('SELECTION_EXPIRED', 'Select a current flight before preparing checkout.');
    assertRecordOwner(detail, context);
    const url = extractFlightCheckoutUrl({ data: { flightsDetail: detail.priceSummary } });
    const checkout = await fetchCheckout(client, url);
    const validation = await client.graphql({ ...buildCheckoutSessionQuery(checkout), group: 'checkout' });
    const session = validation.data?.checkout?.getSession;
    if (!session?.token || validation.errors?.length) fail('CHECKOUT_VALIDATION_FAILED', 'Expedia did not validate this flight checkout.');
    if (session.signals?.length || session.serverSignals?.length) fail('CHECKOUT_ACTION_REQUIRED', 'Expedia returned checkout actions that need review. This checkout is not ready.');
    checkout.sessionToken = session.token;
    const record = { id: randomUUID(), detailId, checkout, owner: recordOwner(context), expiresAt: new Date(Date.now() + 15 * 60000).toISOString(), validatedForms: [] };
    await saveState(`checkout-${record.id}`, record);
    return preview(record);
  });
}
export async function inspectCheckout({ checkoutId }) {
  return withClient(async (_client, context) => preview(await checkoutRecord(checkoutId, context)));
}
export async function submitCheckoutForm({ checkoutId, type, inputFile }) {
  let input;
  try { input = JSON.parse(await fs.readFile(inputFile, 'utf8')); }
  catch { fail('INVALID_FORM_FILE', 'The form input file must contain a JSON array of inputId/value entries.'); }
  return withClient(async (client, context) => {
    const record = await checkoutRecord(checkoutId, context);
    assertCheckoutMutable(record);
    const request = buildSmartFormMutation(record.checkout, { type, userFieldInputs: input });
    // Any change invalidates a previously approved plan before it reaches Expedia.
    record.planId = null; record.validatedForms = record.validatedForms.filter(name => name !== type);
    await saveState(`checkout-${record.id}`, record);
    const response = await client.graphql({ ...request, group: 'checkout' });
    if (response.errors?.length) fail('FORM_UPDATE_FAILED', 'Expedia did not confirm the form update. Inspect checkout before continuing.');
    const data = normalizeSmartFormResult(response);
    if (data.sessionToken) record.checkout.sessionToken = data.sessionToken;
    const errors = data.validationErrors;
    const initialFields = checkoutFormFields(record.checkout, { type, billingCountry: record.billingCountry }).flatMap(form => form.fields);
    const countryId = initialFields.find(field => /billing:address-country$/.test(field.key))?.inputId;
    if (countryId) {
      const country = input.find(value => value.inputId === countryId)?.value;
      if (typeof country === 'string') record.billingCountry = country;
      else if (Array.isArray(country) && typeof country[0] === 'string') record.billingCountry = country[0];
    }
    const fields = checkoutFormFields(record.checkout, { type, billingCountry: record.billingCountry }).flatMap(form => form.fields);
    record.formValues ??= {};
    const values = record.formValues[type] ?? Object.fromEntries(fields.map(field => [field.inputId, field.value]));
    for (const { inputId, value } of input) values[inputId] = value;
    record.formValues[type] = values;
    const present = value => value !== null && value !== undefined && value !== false && (typeof value !== 'string' || value.trim().length > 0) && (!Array.isArray(value) || value.length > 0);
    const missing = fields.filter(field => field.required && !present(values[field.inputId])).map(field => field.inputId);
    const actionRequired = Boolean(data.signals.length || data.serverSignals.length);
    if (data.sessionToken && data.success && !missing.length && !actionRequired) record.validatedForms.push(type);
    await saveState(`checkout-${record.id}`, record);
    return { checkoutId: record.id, status: actionRequired ? 'action_required' : data.sessionToken && data.success && !missing.length ? 'form_updated' : 'validation_required', formType: type, validationErrors: errors, missingRequiredFields: missing, ...(actionRequired ? { userActionRequired: true } : {}) };
  });
}
