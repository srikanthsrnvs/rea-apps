import { randomUUID } from 'node:crypto';
import { authenticatedOperation } from './client.mjs';
import { fetchRouteQuotes } from './shopping.mjs';
import {
  fetchPaymentProfiles,
  fetchUserProfiles,
  selectPaymentProfile,
} from './payments.mjs';
import {
  selectBookingProduct,
  validateSignedFare,
} from './booking-selection.mjs';
import {
  legacyBookingRequest,
  normalizeBookingResult,
} from './booking-protocol.mjs';
import { normalizeTripStatus } from './cancellation-protocol.mjs';
import { savePlan, loadPlan, requireUUID } from './plans.mjs';
import { executeMutation } from './mutations.mjs';
import { productMapIcons, saveTripMapIcons } from './map-vehicle.mjs';

async function requireNoActiveRide(send) {
  const payload = await send('/rt/riders/me/status', {});
  const status = normalizeTripStatus(payload);
  const phase = status.clientStatus?.status;
  // An omitted order list must not hide an active primary ride. Looking is the
  // observed native idle phase; other reported phases require inspection.
  if (
    status.activeOrderCount ||
    (phase && phase !== 'Looking') ||
    (payload.riderAppOrdersFetchResult?.riderAppOrdersFetchSucceeded ===
      false &&
      !phase)
  )
    throw new Error(
      'An existing ride is active or its idle state could not be established. Inspect uber status before preparing another booking',
    );
}

export async function prepareBooking({
  from,
  to,
  via = [],
  product,
  vehicleViewId,
  variantId,
  paymentProfileId,
}) {
  if (paymentProfileId !== undefined)
    requireUUID(paymentProfileId, 'Payment profile ID');
  return authenticatedOperation(async ({ session, send }) => {
    requireUUID(session.userUUID, 'Rider ID');
    await requireNoActiveRide(send);
    const pricing = await fetchRouteQuotes(send, { from, to, via });
    const selection = selectBookingProduct(pricing.summary, {
      product,
      vehicleViewId,
      variantId,
    });
    const candidates = pricing.fares.packageVariants?.filter(
      (v) =>
        v.pricingInfo?.packageVariantUuid === selection.fare.variantId &&
        v.vehicleViewId === selection.product.vehicleViewId,
    );
    if (candidates?.length !== 1)
      throw new Error('Raw signed fare selection is missing or ambiguous');
    const variant = candidates[0];
    const route = {
      from,
      to,
      via,
      vehicleViewId: selection.product.vehicleViewId,
    };
    const fare = validateSignedFare(variant, route);
    const payment = selectPaymentProfile(
      await fetchPaymentProfiles(send),
      await fetchUserProfiles(send, session.userUUID),
      paymentProfileId,
    );
    const jobId = randomUUID();
    const body = legacyBookingRequest({
      ...route,
      variant,
      paymentProfileId: payment.payment.id,
      userProfile: payment.userProfile,
      jobId,
    });
    const preview = {
      route: { from, to, via },
      product: {
        name: selection.product.name,
        vehicleViewId: selection.product.vehicleViewId,
        variantId: selection.fare.variantId,
      },
      fare: {
        amount: fare.amount,
        currencyCode: fare.currencyCode,
        formattedFare: selection.fare.formattedFare,
        expiresAt: fare.expiresAt,
      },
      payment: payment.payment,
    };
    const order = pricing.shopping.response.fullResponse.shoppingOrders.find(
      (order) => order.id === selection.product.orderId,
    );
    const mapIcons = productMapIcons(
      order?.jobs?.singleTransport?.transportJob?.productContext?.presentation,
    );
    const plan = await savePlan(
      'booking',
      session,
      { body, preview, jobId, variant, mapIcons },
      { ttlMs: Math.min(300000, fare.expiresAt - Date.now() - 5000) },
    );
    return {
      planId: plan.id,
      operationId: plan.operationId,
      expiresAt: plan.expiresAt,
      preview,
      next: `uber book --plan-id ${plan.id} --confirm`,
    };
  });
}

export async function confirmBooking(planId) {
  return authenticatedOperation(async ({ session, send }) => {
    const plan = await loadPlan(planId, 'booking', session);
    await requireNoActiveRide(send);
    const payment = selectPaymentProfile(
      await fetchPaymentProfiles(send),
      await fetchUserProfiles(send, session.userUUID),
      plan.preview.payment.id,
    );
    if (payment.payment.name !== plan.preview.payment.name)
      throw new Error(
        'Payment method presentation changed; prepare a new booking',
      );
    if (plan.expiresAt <= Date.now())
      throw new Error('Booking plan expired; prepare it again');
    validateSignedFare(plan.variant, {
      ...plan.preview.route,
      vehicleViewId: plan.preview.product.vehicleViewId,
    });
    const response = await executeMutation(
      {
        id: plan.operationId,
        kind: 'booking',
        endpoint: `/rt/riders/${session.userUUID}/v2/pickup`,
        body: plan.body,
        context: { jobId: plan.jobId, preview: plan.preview },
        validate: normalizeBookingResult,
      },
      send,
    );
    const result = normalizeBookingResult(response);
    let artworkSaved = false;
    // Optional viewer metadata must never turn an accepted paid action into an
    // apparent booking failure. The durable mutation journal remains authoritative.
    try {
      artworkSaved = await saveTripMapIcons(
        result.tripId,
        session.userUUID,
        plan.mapIcons,
      );
    } catch {}
    return {
      operationId: plan.operationId,
      ...result,
      map: {
        command: `uber map serve --trip-id ${result.tripId}`,
        artworkSaved,
      },
    };
  });
}
