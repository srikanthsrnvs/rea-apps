import { randomUUID } from 'node:crypto';
import { createClient } from './client.mjs';
import { readState, saveState, withStateLock } from './state.mjs';
import { resolveCard } from './read.mjs';
import { AmexError } from './errors.mjs';
import { calendarDate } from './account-protocol.mjs';
import {
  buildPaymentInquiry, parsePaymentInquiry, preparePayment, buildPaymentSubmit,
  parsePaymentSubmission, preparePaymentCancellation, buildPaymentCancellation,
  parsePaymentCancellation, paymentTerms, termsDigest, decimalMoney,
} from './payment-protocol.mjs';

const TTL = 300_000;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const fail = (code, message, details) => { throw new AmexError(code, message, details); };
function recordId(value) { if (typeof value !== 'string' || !ID.test(value)) fail('AMEX_REVIEW_ID_INVALID', 'Use a current inquiry or review ID returned by this CLI.'); return value; }
function bindingKey(binding) { return termsDigest([binding.cardId, binding.sortedIndex, binding.accountToken]); }
function decimalUnits(value) { const money = decimalMoney(value); const [whole, fraction = ''] = money.amount.split('.'); return `${BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))}`; }
function publicData(value, secrets = []) {
  if (Array.isArray(value)) return value.map(item => publicData(item, secrets) ?? null);
  if (object(value)) return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(?:token|cardid|cardkey|accountkey|methodid|paymentid|identifier|idempotency|sessioncontext|gatekeeper|cupcake|authorization|password|encrypted)/iu.test(key)
      && !/(?:url|link|sso)$/iu.test(key) && !/^(?:__proto__|constructor|prototype)$/u.test(key))
    .map(([key, item]) => [key, publicData(item, secrets)]).filter(([, item]) => item !== undefined));
  if (typeof value === 'string' && secrets.some(secret => typeof secret === 'string' && secret && (value === secret || secret.length >= 8 && value.includes(secret)))) return undefined;
  return value;
}
function privateStrings(record) {
  return [record.binding?.accountToken, record.binding?.cardId, record.response?.data?.paymentRequestId,
    ...(record.methods ?? []).flatMap(method => [method.nativeId, method.source?.paymentAccountToken]),
    ...(record.payments ?? []).map(payment => payment.nativeId), record.prepared?.body?.accountToken,
    record.prepared?.body?.methodId, record.prepared?.body?.idempotencyKey, record.prepared?.paymentID].filter(Boolean);
}
function optionSources(data, method) { return Array.isArray(method.amountOptions) ? method.amountOptions : data.paymentAmounts?.defaultOptions?.amountOptions ?? []; }
function aliases(data) {
  let amountIndex = 0;
  const methods = (Array.isArray(data.paymentMethods?.options) ? data.paymentMethods.options : []).filter(object).map((source, index) => ({
    alias: `method-${index + 1}`, nativeId: source.paymentMethodId, source,
    amounts: (Array.isArray(optionSources(data, source)) ? optionSources(data, source) : []).filter(object).map(option => ({
      alias: `amount-${++amountIndex}`, nativeId: option.identifier ?? option.type, source: option,
    })),
  }));
  const payments = (Array.isArray(data.scheduledPayments?.payments) ? data.scheduledPayments.payments : []).filter(object)
    .map((source, index) => ({ alias: `payment-${index + 1}`, nativeId: source.paymentID, source }));
  return { methods, payments };
}
function one(items, alias, label) {
  if (typeof alias !== 'string') fail('AMEX_SELECTION_REQUIRED', `Choose an offered ${label} alias.`);
  const matches = items.filter(item => item.alias === alias);
  if (matches.length !== 1) fail('AMEX_SELECTION_REQUIRED', `Choose an offered ${label} alias from this inquiry.`);
  return matches[0];
}
function outcomeFromResponse(kind, response) {
  if (!object(response) || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300
    || ['x-axp-session-expired', 'x-axp-jwt-expired'].some(name => response.headers?.[name] === 'true')
    || String(response.headers?.['x-axp-business-layer-status']).toUpperCase() === 'FAIL') return { phase: 'unknown', reason: 'unrecognized_financial_http_outcome' };
  return kind === 'payment' ? parsePaymentSubmission(response.body) : parsePaymentCancellation(response.body);
}

export function createPayments({ read = readState, save = saveState, lock = withStateLock,
  selectCard = resolveCard, clientFactory = createClient, now = Date.now, uuid = randomUUID } = {}) {
  async function current(ownerId) {
    const session = await read('session');
    if (session?.validated !== true || typeof session.ownerId !== 'string' || !session.ownerId) fail('AMEX_AUTH_REQUIRED', 'A validated Amex session is required.');
    if (ownerId !== undefined && ownerId !== session.ownerId) fail('AMEX_ACCOUNT_CHANGED', 'This financial review belongs to a different signed-in account.');
    return session;
  }
  async function assertBinding(selected, expected = selected.binding) {
    await current(selected.session.ownerId);
    if (bindingKey(selected.binding) !== bindingKey(expected)) fail('AMEX_PAYMENT_BINDING_CHANGED', 'This card binding changed. Get fresh payment options.');
    const cache = await read('account-cache');
    const entries = cache?.ownerId === selected.session.ownerId && Array.isArray(cache.records) ? cache.records.filter(entry => entry.id === selected.card.id) : [];
    if (entries.length !== 1 || bindingKey(entries[0].binding) !== bindingKey(expected)) fail('AMEX_PAYMENT_BINDING_CHANGED', 'The selected card binding is no longer current.');
  }
  async function loadInquiry(inquiryId) {
    const inquiry = await read(`payment-inquiry-${recordId(inquiryId)}`);
    if (inquiry?.version !== 1 || inquiry.type !== 'inquiry') fail('AMEX_INQUIRY_NOT_FOUND', 'This payment inquiry was not found.');
    await current(inquiry.ownerId);
    if (!Number.isFinite(inquiry.expiresAt) || inquiry.expiresAt <= now()) fail('AMEX_INQUIRY_EXPIRED', 'Payment options expired. Get fresh options.');
    return inquiry;
  }
  async function loadReview(kind, reviewId) {
    const record = await read(`${kind}-review-${recordId(reviewId)}`);
    if (record?.version !== 1 || record.type !== kind) fail('AMEX_REVIEW_NOT_FOUND', 'This financial review was not found.');
    await current(record.ownerId);
    return record;
  }
  function reviewOutput(record) {
    return { phase: 'review_required', reviewId: record.id, expiresAt: new Date(record.expiresAt).toISOString(), card: record.card,
      ...publicData(record.prepared.review, privateStrings(record)), terms: publicData(record.prepared.terms, privateStrings(record)), termsHash: record.prepared.termsHash };
  }
  async function statusRecord(kind, record) {
    await current(record.ownerId);
    const intent = record.intentKey ? await read(`${kind}-intent-${record.intentKey}`) : null;
    const journal = intent?.reviewId === record.id ? intent : record;
    const outcome = journal.outcome ?? (journal.response ? outcomeFromResponse(kind, journal.response) : journal.sentAt ? { phase: 'unknown', reason: 'submission_started_outcome_not_recorded' } : null);
    if (!outcome) return { ...reviewOutput(record), expired: record.expiresAt <= now(), statusSource: 'local_journal' };
    return { ...publicData(outcome, privateStrings(record)), reviewId: record.id, card: record.card, statusSource: 'local_journal',
      sentAt: journal.sentAt ? new Date(journal.sentAt).toISOString() : undefined,
      ...(kind === 'payment' ? { settled: false } : {}) };
  }
  async function paymentOptions({ card } = {}) {
    const selected = await selectCard(card);
    if (selected.result) return selected.result;
    const client = await clientFactory({ session: selected.session });
    const response = await client.request(buildPaymentInquiry({ accountToken: selected.binding.accountToken }));
    const parsed = parsePaymentInquiry(response);
    return lock(async () => {
      await assertBinding(selected);
      const id = recordId(uuid());
      const mappings = parsed.phase === 'ready' ? aliases(parsed.data) : { methods: [], payments: [] };
      const record = { version: 1, type: 'inquiry', id, ownerId: selected.session.ownerId, card: selected.card,
        binding: selected.binding, createdAt: now(), expiresAt: now() + TTL, response, ...mappings };
      await save(`payment-inquiry-${id}`, record);
      const secrets = privateStrings(record);
      if (parsed.phase !== 'ready') return { ...publicData(parsed, secrets), card: selected.card };
      return { phase: 'ready', inquiryId: id, expiresAt: new Date(record.expiresAt).toISOString(), card: selected.card,
        methods: mappings.methods.map(method => ({ id: method.alias, ...publicData(method.source, secrets),
          amountOptions: method.amounts.map(amount => ({ id: amount.alias, ...publicData(amount.source, secrets) })) })),
        dates: publicData(parsed.data.paymentDates, secrets),
        scheduledPayments: mappings.payments.map(payment => ({ id: payment.alias, ...publicData(payment.source, secrets) })),
        terms: publicData(paymentTerms(parsed.data), secrets),
        supportedMethodsBranch: parsed.data.paymentMethods?.type === 'AVAILABLE' };
    });
  }
  async function prepareReview(kind, options) {
    const initial = await lock(() => loadInquiry(options.inquiryId));
    const selected = await selectCard(initial.card.id);
    if (selected.result) return selected.result;
    return lock(async () => {
      const inquiry = await loadInquiry(options.inquiryId);
      if (inquiry.ownerId !== selected.session.ownerId || inquiry.card.id !== selected.card.id) fail('AMEX_ACCOUNT_CHANGED', 'The inquiry no longer matches the signed-in card.');
      await assertBinding(selected, inquiry.binding);
      let prepared;
      if (kind === 'payment') {
        const method = one(inquiry.methods, options.method, 'payment method');
        const amountOption = one(method.amounts, options.amountOption, 'amount option');
        prepared = preparePayment({ accountToken: inquiry.binding.accountToken, inquiry: inquiry.response,
          methodId: method.nativeId, amountOptionId: amountOption.nativeId, date: options.date, amount: options.amount });
      } else {
        const payment = one(inquiry.payments, options.payment, 'scheduled payment');
        prepared = preparePaymentCancellation({ accountToken: inquiry.binding.accountToken, inquiry: inquiry.response, paymentID: payment.nativeId });
      }
      if (prepared.phase !== 'review_required') return publicData(prepared, privateStrings(inquiry));
      const id = recordId(uuid());
      const intentKey = kind === 'payment'
        ? termsDigest([inquiry.ownerId, inquiry.card.id, prepared.body.methodId, prepared.body.value.currency, decimalUnits(prepared.body.value), prepared.body.date])
        : termsDigest([inquiry.ownerId, inquiry.card.id, prepared.paymentID]);
      const record = { version: 1, type: kind, id, phase: 'review_required', ownerId: inquiry.ownerId, card: inquiry.card,
        binding: inquiry.binding, inquiryId: inquiry.id, createdAt: now(), expiresAt: Math.min(now() + TTL, inquiry.expiresAt), prepared, intentKey };
      await save(`${kind}-review-${id}`, record);
      return reviewOutput(record);
    });
  }
  const previewPayment = options => prepareReview('payment', options ?? {});
  const previewCancellation = options => prepareReview('cancellation', options ?? {});
  async function confirm(kind, options) {
    const initial = await lock(() => loadReview(kind, options.reviewId));
    const recorded = await lock(() => statusRecord(kind, initial));
    if (recorded.phase !== 'review_required') return recorded;
    const selected = await selectCard(initial.card.id);
    if (selected.result) return selected.result;
    return lock(async () => {
      const record = await loadReview(kind, options.reviewId);
      const previous = await statusRecord(kind, record);
      if (previous.phase !== 'review_required') return previous;
      if (record.expiresAt <= now()) fail('AMEX_REVIEW_EXPIRED', 'The financial review expired. Get fresh payment options.');
      if (record.ownerId !== selected.session.ownerId || record.card.id !== selected.card.id) fail('AMEX_ACCOUNT_CHANGED', 'The review no longer matches the signed-in card.');
      await assertBinding(selected, record.binding);
      if (kind === 'payment') {
        const confirmedAmount = decimalMoney({ amount: options.amount, currency: options.currency });
        if (decimalUnits(confirmedAmount) !== decimalUnits(record.prepared.body.value) || confirmedAmount.currency !== record.prepared.body.value.currency
          || calendarDate(options.date, 'confirmed payment date') !== record.prepared.body.date) fail('AMEX_PAYMENT_CONFIRMATION_MISMATCH', 'Confirm the exact reviewed amount, currency and payment date.');
      }
      const spec = kind === 'payment'
        ? buildPaymentSubmit({ prepared: record.prepared, confirm: options.confirm, acceptTerms: options.acceptTerms })
        : buildPaymentCancellation({ prepared: record.prepared, confirm: options.confirm, acceptTerms: options.acceptTerms });
      const intentName = `${kind}-intent-${record.intentKey}`;
      const existing = await read(intentName);
      if (existing) fail('AMEX_DUPLICATE_FINANCIAL_ACTION', 'An equivalent financial action was already sent or may have been sent. Check its recorded status before taking another action.', { originalReviewId: existing.reviewId, phase: existing.outcome?.phase ?? 'unknown' });
      // One durable intent record is authoritative even if writing its review fails.
      // It blocks all equivalent new reviews before the sole PUT/DELETE can start.
      const journal = { version: 1, type: kind, ownerId: record.ownerId, card: record.card.id,
        reviewId: record.id, sentAt: now(), request: spec, outcome: { phase: 'unknown', reason: 'submission_started_outcome_not_recorded' } };
      await save(intentName, journal);
      await save(`${kind}-review-${record.id}`, { ...record, phase: 'unknown', sentAt: journal.sentAt, request: spec });
      try {
        const client = await clientFactory({ session: selected.session });
        journal.response = await client.response(spec);
        // Save the exact HTTP response before interpreting any success union.
        delete journal.outcome;
        await save(intentName, journal);
        journal.outcome = outcomeFromResponse(kind, journal.response);
      } catch (error) {
        if (!journal.response) journal.outcome = { phase: 'unknown', reason: 'financial_transport_outcome_unknown',
          errorCode: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code : 'UNEXPECTED_ERROR' };
        else throw error;
      }
      await save(intentName, journal);
      await save(`${kind}-review-${record.id}`, { ...record, phase: journal.outcome.phase, sentAt: journal.sentAt, response: journal.response, outcome: journal.outcome });
      return statusRecord(kind, record);
    });
  }
  const confirmPayment = options => confirm('payment', options ?? {});
  const confirmCancellation = options => confirm('cancellation', options ?? {});
  const paymentStatus = ({ reviewId } = {}) => lock(async () => statusRecord('payment', await loadReview('payment', reviewId)));
  const cancellationStatus = ({ reviewId } = {}) => lock(async () => statusRecord('cancellation', await loadReview('cancellation', reviewId)));
  return { paymentOptions, previewPayment, confirmPayment, paymentStatus, previewCancellation, confirmCancellation, cancellationStatus };
}
export const { paymentOptions, previewPayment, confirmPayment, paymentStatus,
  previewCancellation, confirmCancellation, cancellationStatus } = createPayments();
