const text = (value) => (typeof value === 'string' ? value : null);
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);

function optionalText(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${label} must be a nonempty string`);
  return value;
}

/** Direct GetCancellationInfoRequest; default native request has no fields. */
export function cancellationInfoRequest({ reasonId } = {}) {
  const reason = optionalText(reasonId, 'Cancellation reason ID');
  return reason === undefined ? {} : { reasonId: reason };
}

/** Direct RiderCancelRequest. reason is a server-provided string, not an enum. */
export function riderCancelRequest({
  reason,
  refundStrategy,
  fulfillmentOrderId,
  comment,
} = {}) {
  const fields = {
    reason: optionalText(reason, 'Cancellation reason'),
  };
  const orderId = optionalText(fulfillmentOrderId, 'Fulfillment order ID');
  if (orderId !== undefined) fields.fulfillmentOrderId = { uuid: orderId };
  if (refundStrategy !== undefined) {
    if (!['ORIGINAL_PAYMENT_METHOD', 'UBER_CASH'].includes(refundStrategy))
      throw new Error('Unsupported refund strategy');
    fields.refundStrategy = refundStrategy;
  }
  if (comment !== undefined)
    fields.cancellationInput = {
      comment: optionalText(comment, 'Cancellation comment'),
    };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

/** chargeFee is an explicit server decision; unknown never means free. */
export function normalizeCancellationInfo(payload) {
  const body = payload?.body ?? payload;
  if (
    !object(body) ||
    ![
      'chargeFee',
      'title',
      'messages',
      'tripCancellationInfoView',
      'modalText',
    ].some((key) => Object.hasOwn(body, key))
  ) {
    throw new Error(
      'Unrecognized cancellation preview; use --raw to inspect the response',
    );
  }
  return {
    title: text(body.title),
    messages: Array.isArray(body.messages)
      ? body.messages.filter((value) => typeof value === 'string')
      : [],
    chargeFee: typeof body.chargeFee === 'boolean' ? body.chargeFee : null,
    cancelButtonTitle: text(body.cancelButtonTitle),
    acceptButtonTitle: text(body.acceptButtonTitle),
    dialogOptions: Array.isArray(body.cancellationDialogOptions)
      ? body.cancellationDialogOptions.filter(object).map((option) => ({
          type: text(option.type),
          title: text(option.title),
          message: text(option.message),
          ctaTitle: text(option.ctaTitle),
        }))
      : [],
    refundOptions: Array.isArray(body.refundSpec?.eligibleRefundOptions)
      ? body.refundSpec.eligibleRefundOptions.filter(object).map((option) => ({
          refundStrategy: text(option.refundStrategy),
          title: text(option.title),
          body: text(option.body),
        }))
      : [],
    refundDescription: text(body.refundSpec?.description),
    // Retain server-driven presentation instead of inferring fee amounts from UI text.
    modalText: body.modalText ?? null,
    tripCancellationInfoView: body.tripCancellationInfoView ?? null,
    cancellationSurveyPayload: body.cancellationSurveyPayload ?? null,
    warnings:
      typeof body.chargeFee !== 'boolean'
        ? [
            'Cancellation fee status is unknown. Inspect the server presentation before cancelling.',
          ]
        : [],
  };
}

/** Modern job IDs are mapped to legacy TripUuid by the app's JobProvider abstraction. */
export function normalizeTripStatus(payload) {
  const body = payload?.body ?? payload;
  if (!object(body))
    throw new Error('Unrecognized trip status response; use --raw');
  const modern = body.riderAppOrdersResponse?.orders;
  const single =
    body.singleRiderAppOrderResponse?.order ?? body.response?.order;
  const legacy = body.fulfillmentStateData?.orders;
  if (!Array.isArray(modern) && !object(single) && !Array.isArray(legacy)) {
    throw new Error('Unrecognized trip status response; use --raw');
  }
  const orders = [];
  const seen = new Set();
  for (const order of [
    ...(Array.isArray(modern) ? modern : []),
    ...(object(single) ? [single] : []),
  ]) {
    if (!object(order)) continue;
    const fulfillmentOrderId = text(order.id);
    if (fulfillmentOrderId && seen.has(fulfillmentOrderId)) continue;
    if (fulfillmentOrderId) seen.add(fulfillmentOrderId);
    const singleJob = order.jobs?.singlePersonalTransport?.transport;
    const multiple = order.jobs?.multiplePersonalTransport;
    const jobs = object(singleJob)
      ? [singleJob]
      : Array.isArray(multiple?.transportJobs)
        ? multiple.transportJobs.filter(object)
        : [];
    const tripIds = [
      ...new Set(jobs.map((job) => text(job.id)).filter(Boolean)),
    ];
    // A multiple-job order provides the backwards-compatible primary job explicitly.
    const tripId = object(singleJob)
      ? text(singleJob.id)
      : text(multiple?.backwardsCompatibleSinglePersonalTransportJobID);
    orders.push({
      fulfillmentOrderId,
      tripId,
      tripIds,
      state: text(order.state),
      cancellation: tripId ? { tripId, fulfillmentOrderId } : null,
    });
  }
  for (const order of Array.isArray(legacy) ? legacy : []) {
    if (!object(order)) continue;
    const fulfillmentOrderId = text(order.orderId?.uuid);
    if (fulfillmentOrderId && seen.has(fulfillmentOrderId)) continue;
    if (fulfillmentOrderId) seen.add(fulfillmentOrderId);
    const jobs = Array.isArray(order.orderPlan?.jobs)
      ? order.orderPlan.jobs
      : [];
    const tripIds = [
      ...new Set(
        jobs
          .map((job) => text(job?.legacyTripData?.trip?.uuid))
          .filter(Boolean),
      ),
    ];
    const tripId = tripIds.length === 1 ? tripIds[0] : null;
    orders.push({
      fulfillmentOrderId,
      tripId,
      tripIds,
      state: null,
      cancellation: tripId ? { tripId, fulfillmentOrderId } : null,
    });
  }
  return {
    clientStatus: body.clientStatus ?? null,
    activeOrderCount: orders.length,
    orders,
    pollingIntervalMs: Number.isFinite(body.metadata?.pollingIntervalMs)
      ? body.metadata.pollingIntervalMs
      : null,
    warnings: orders.some((order) => !order.tripId)
      ? [
          'Some orders have no supported transport trip ID. Inspect --raw before selecting a cancellation target.',
        ]
      : [],
  };
}
