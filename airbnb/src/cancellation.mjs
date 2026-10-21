import fs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createClient } from './client.mjs';
import { readState, saveState, withStateLock, stateDirectory } from './state.mjs';
import { AirbnbError } from './errors.mjs';
import { requireSuccess } from './http.mjs';
import { buildCancellationPreview, parseCancellationPreview, buildConfirmCancellation, parseCancellationResult } from './booking-protocol.mjs';

const TTL = 5 * 60_000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAIN = new Set(['CancellationProductOverviewSection', 'CancellationReasonsSelectionSection']);
const REFUND = new Set(['CancellationPriceBreakdownSection', 'CancellationRefundMethodSection']);
const fail = (code, message) => { throw new AirbnbError(code, message); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => key !== 'loggingData').map(key => [key, canonical(value[key])]));
  return value;
}
function owner(session) {
  if (!session?.token || typeof session.userId !== 'string' || !session.userId) fail('AUTH_REQUIRED', 'Sign in before reviewing a cancellation.');
  return session.userId;
}
function name(id) {
  if (typeof id !== 'string' || !ID.test(id)) fail('INVALID_ARGUMENT', 'Provide a valid cancellation review ID.');
  return `cancellation-review-${id}`;
}

// Exact native placements and display money, without inferring numeric refunds.
export function cancellationTerms(response, reasonId) {
  const parsed = parseCancellationPreview(response), sections = parsed.sections;
  if (!sections || ['mainSectionPlacement', 'refundSectionPlacement'].some(key => sections[key] != null && !Array.isArray(sections[key]))) fail('CANCELLATION_UNAVAILABLE', 'Airbnb did not return valid cancellation sections.');
  const main = (sections.mainSectionPlacement ?? []).map(x => x?.sectionData), refund = (sections.refundSectionPlacement ?? []).map(x => x?.sectionData);
  const all = [...main, ...refund];
  const reasons = main.filter(x => x?.__typename === 'CancellationReasonsSelectionSection')
    .flatMap(x => Array.isArray(x.reasons) ? x.reasons : []);
  const buttons = Array.isArray(parsed.callToActionButtons) ? parsed.callToActionButtons : [];
  const blockers = [];
  if (!main.length || !refund.length) blockers.push('incomplete_sections');
  if (all.some(x => x?.__typename === 'CancellationInterventionSection')) blockers.push('intervention');
  if (main.some(x => !MAIN.has(x?.__typename)) || refund.some(x => !REFUND.has(x?.__typename))) blockers.push('unsupported_section');
  const primary = buttons.filter(x => x?.__typename === 'CancellationPrimaryButton');
  if (primary.length !== 1 || !primary[0]?.ctaText || primary[0]?.action?.url) blockers.push('unsupported_confirmation');
  if (!refund.some(x => x?.__typename === 'CancellationPriceBreakdownSection')) blockers.push('missing_refund_review');
  const offered = reasons.filter(x => typeof x?.reasonId === 'string' && x.reasonId && !['UNKNOWN', 'UNKNOWN__'].includes(x.reasonId));
  if (reasonId !== undefined && !offered.some(x => x.reasonId === reasonId)) fail('INVALID_CANCELLATION_REASON', 'Select a reasonId offered by this exact cancellation review.');
  const terms = canonical({ title: parsed.title, callToActionButtons: buttons,
    mainSections: main, refundSections: refund });
  return { terms, termsHash: hash(terms), reasons: offered, blockers,
    eligible: blockers.length === 0 && reasonId !== undefined };
}

export function mergeCancellationRead(initial, refresh) {
  const before = parseCancellationPreview(initial), after = parseCancellationPreview(refresh);
  const incoming = after.sections;
  if (!incoming || !['mainSectionPlacement', 'refundSectionPlacement'].some(key => Array.isArray(incoming[key]) && incoming[key].length)) fail('CANCELLATION_UNAVAILABLE', 'The cancellation refresh returned no updated sections.');
  const merged = structuredClone(before.cancellation);
  if (after.title != null) merged.title = after.title;
  if (after.callToActionButtons != null) merged.callToActionButtons = after.callToActionButtons;
  for (const key of ['mainSectionPlacement', 'refundSectionPlacement']) {
    if (incoming[key] != null && !Array.isArray(incoming[key])) fail('CANCELLATION_UNAVAILABLE', 'The cancellation refresh returned invalid sections.');
    if (incoming[key]?.length) merged.sections[key] = structuredClone(incoming[key]);
  }
  return { data: { presentation: { cancellation: merged } } };
}

async function readReview(client, confirmationCode, reasonId) {
  // A reason refresh can return refund placements only. Merge it only with an
  // immediately preceding successful read for the same account and reservation.
  const initial = await client.request(buildCancellationPreview({ confirmationCode }));
  cancellationTerms(initial, reasonId); // Validate the reason against today's offered list.
  if (reasonId === undefined) return { body: initial, raw: initial };
  const refresh = await client.request(buildCancellationPreview({ confirmationCode, selectedReasonId: reasonId }));
  return { body: mergeCancellationRead(initial, refresh), raw: { initial, selectedReason: refresh } };
}

export async function prepareCancellation({ confirmationCode, reasonId, subreasonId, raw = false } = {}) {
  if (subreasonId !== undefined) fail('UNSUPPORTED_CANCELLATION_ACTION', 'The recovered cancellation flow does not submit subreasons.');
  buildCancellationPreview({ confirmationCode, selectedReasonId: reasonId });
  const session = await readState('session'), userId = owner(session);
  const client = await createClient({ session });
  const response = await readReview(client, confirmationCode, reasonId), review = cancellationTerms(response.body, reasonId);
  const needsReason = reasonId === undefined && review.reasons.length && review.blockers.every(x => ['incomplete_sections', 'missing_refund_review'].includes(x));
  const result = { status: needsReason ? 'reason_required' : review.blockers.length ? 'action_required' : 'review_required',
    confirmationCode, reasonId, ...review, ...(raw ? { raw: response.raw } : {}) };
  if (!review.eligible) return result;
  const id = randomUUID(), expiresAt = Date.now() + TTL;
  await saveState(name(id), { version: 1, id, owner: userId, confirmationCode, reasonId,
    ...review, createdAt: Date.now(), expiresAt, submission: null });
  return { ...result, reviewId: id, expiresAt: new Date(expiresAt).toISOString(),
    next: `airbnb cancellation confirm --review-id ${id} --accept-terms ${review.termsHash} --confirm` };
}

function outcome(review) {
  if (!review.submission) return { reviewId: review.id, status: 'review_required', termsHash: review.termsHash };
  let parsed;
  try { parsed = parseCancellationResult(requireSuccess(review.submission.response)); } catch {}
  return { reviewId: review.id, confirmationCode: review.confirmationCode, outcome: parsed?.outcome ?? 'unknown',
    confirmed: parsed?.confirmed ?? false, terminal: parsed?.terminal ?? false,
    errorMessage: parsed?.errorMessage ?? null, retryable: parsed?.retryable ?? null,
    redirectUrl: parsed?.redirectUrl ?? null, actionText: parsed?.actionText ?? null,
    ...(!parsed || parsed.outcome === 'unknown' ? { message: 'Cancellation has an uncertain outcome. This review will not submit again.' } : {}) };
}
async function releaseBookingIntent(review) {
  for (const entry of (await fs.readdir(stateDirectory)).filter(x => /^booking-review-[0-9a-f-]+\.json$/.test(x))) {
    const booking = await readState(entry.slice(0, -5));
    if (booking?.owner === review.owner && booking.preparation?.confirmationCode === review.confirmationCode && booking.intent) {
      const intent = await readState(booking.intent);
      if (intent?.reviewId === booking.id) await saveState(booking.intent, { ...intent, phase: 'cancelled', updatedAt: Date.now() });
    }
  }
}

export async function confirmCancellation({ reviewId, acceptTerms, confirm = false } = {}) {
  const record = name(reviewId);
  if (confirm !== true) fail('CONFIRMATION_REQUIRED', 'Cancellation requires user approval of this exact reservation, reason, refund and terms.');
  return withStateLock(async () => {
    const review = await readState(record), session = await readState('session');
    if (!review || review.owner !== owner(session)) fail('REVIEW_NOT_FOUND', 'No matching cancellation review for this account.');
    if (review.submission) return outcome(review);
    if (Date.now() >= review.expiresAt) fail('REVIEW_EXPIRED', 'Prepare and review a fresh cancellation before confirming.');
    if (review.eligible !== true || acceptTerms !== review.termsHash || hash(canonical(review.terms)) !== review.termsHash) fail('TERMS_REVIEW_REQUIRED', 'Accept the exact termsHash from an eligible cancellation review.');
    const intentName = `cancellation-intent-${hash({ owner: review.owner, confirmationCode: review.confirmationCode })}`;
    const prior = await readState(intentName);
    if (prior && (prior.phase !== 'failed' || prior.retryable !== true)) fail('CANCELLATION_ALREADY_ATTEMPTED', 'This reservation already has a submitted, uncertain or nonretryable cancellation. Inspect that recorded outcome before another submission.');
    const client = await createClient({ session });
    const fresh = cancellationTerms((await readReview(client, review.confirmationCode, review.reasonId)).body, review.reasonId);
    if (!fresh.eligible || fresh.termsHash !== review.termsHash) fail('CANCELLATION_TERMS_CHANGED', 'Airbnb changed the cancellation terms or eligibility. Prepare and approve a fresh review.');
    // Native current caller uses reasonId and omits reasonIdValue/refund method.
    const request = buildConfirmCancellation({ confirmationCode: review.confirmationCode, reasonId: review.reasonId });
    await saveState(intentName, { reviewId, phase: 'pending', startedAt: Date.now() });
    review.submission = { phase: 'pending', startedAt: Date.now(), request };
    await saveState(record, review);
    const response = await client.response(request);
    review.submission = { ...review.submission, phase: 'responded', response, receivedAt: Date.now() };
    await saveState(record, review);
    const result = outcome(review);
    await saveState(intentName, { reviewId, phase: result.confirmed ? 'succeeded' : result.outcome === 'failed' ? 'failed' : 'pending', retryable: result.retryable, updatedAt: Date.now() });
    if (result.confirmed) {
      try { await releaseBookingIntent(review); } catch { result.localReconciliation = 'pending'; }
    }
    return result;
  });
}

export async function cancellationStatus({ reviewId } = {}) {
  const review = await readState(name(reviewId)), session = await readState('session');
  if (!review || review.owner !== owner(session)) fail('REVIEW_NOT_FOUND', 'No matching cancellation review for this account.');
  return outcome(review);
}
