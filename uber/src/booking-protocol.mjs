import { coordinate } from './protocol.mjs';
import { normalizeTripStatus } from './cancellation-protocol.mjs';

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value, label) {
  if (typeof value !== 'string' || !uuidPattern.test(value))
    throw new Error(`${label} must be a UUID`);
  return value;
}

// nab.a.b creates the target from the rendezvous coordinates and leaves target
// type/ts null. LocationSource.MANUAL's shipped SerializedName is "Manual".
function clientRequestLocation(value) {
  const point = coordinate(value);
  return {
    locationSource: 'Manual',
    rendezvousLocation: { ...point },
    targetLocation: { ...point },
  };
}

/** Direct PickupRequestV2 body. No booking network requests occur here. */
export function legacyBookingRequest({
  from,
  to,
  via = [],
  variant,
  vehicleViewId,
  paymentProfileId,
  jobId,
  userProfile,
} = {}) {
  if (!Array.isArray(via)) throw new Error('Via locations must be an array');
  const id = Number(vehicleViewId);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error('Vehicle view ID must be a positive integer');
  const fare = variant?.pricingInfo?.fareInfo?.upfrontFare;
  if (
    !object(fare) ||
    !object(fare.signature) ||
    typeof fare.signature.signature !== 'string' ||
    !fare.signature.signature
  ) {
    throw new Error('A server-issued signed upfront fare is required');
  }
  if (Number(variant.vehicleViewId) !== id || Number(fare.vehicleViewId) !== id)
    throw new Error('Signed fare vehicle does not match the selected vehicle');
  // Copy rather than rebuild signed price data. Preparation/confirmation must
  // additionally validate its exact route, expiry, amount and selected payment.
  const body = {
    vehicleViewId: id,
    paymentProfileUUID: uuid(paymentProfileId, 'Payment profile ID'),
    requestPickupLocation: clientRequestLocation(from),
    requestDestinationLocation: clientRequestLocation(to),
    requestViaLocations: via.map(clientRequestLocation),
    upfrontFare: structuredClone(fare),
    jobUUID: uuid(jobId, 'Job ID'),
  };
  if (userProfile !== undefined && userProfile !== null) {
    if (userProfile.type !== 'PERSONAL')
      throw new Error(
        'Only the recovered Personal profile booking flow is supported',
      );
    body.profileUUID = uuid(userProfile.id, 'User profile ID');
    body.profileType = 'Personal';
  }
  // Native cs6.z1.a supplies null timestamp, transactionId and paymentProfileId;
  // TripUUIDGenerator is inserted later as jobUUID by ad6.t.apply/Builder.R.
  return body;
}

/** Native self-ride participant specification for authenticated shopping. */
export function selfParticipantSpecs({
  riderId,
  paymentProfileId,
  userProfile,
} = {}) {
  const payer = {
    paymentProfile: { id: uuid(paymentProfileId, 'Payment profile ID') },
  };
  if (userProfile !== undefined && userProfile !== null) {
    if (userProfile.type !== 'PERSONAL')
      throw new Error('Only Personal user profiles are supported');
    payer.userProfile = {
      id: uuid(userProfile.id, 'User profile ID'),
      type: 'PERSONAL',
    };
  }
  return [
    {
      participantID: { type: 'userID', userID: uuid(riderId, 'Rider ID') },
      roles: [
        { type: 'payer', payer },
        { type: 'consumer', consumer: {} },
      ],
    },
  ];
}

/** A HTTP success or checkout action alone does not establish a created ride. */
export function normalizeBookingResult(payload) {
  const body = payload?.body ?? payload;
  if (!object(body))
    throw new Error(
      'Unrecognized booking response; check trip status before another booking',
    );
  let modern = null;
  if (
    object(body.singleRiderAppOrderResponse?.order) ||
    object(body.response?.order)
  ) {
    const status = normalizeTripStatus(body);
    modern = status.orders.length === 1 ? status.orders[0] : null;
  }
  const legacyTripId =
    typeof body.trip?.uuid === 'string' && uuidPattern.test(body.trip.uuid)
      ? body.trip.uuid
      : null;
  const tripId = modern?.tripId ?? legacyTripId;
  const orderId =
    modern?.fulfillmentOrderId ??
    (typeof body.trip?.fulfillmentOrderId?.uuid === 'string'
      ? body.trip.fulfillmentOrderId.uuid
      : null);
  if (!tripId || !uuidPattern.test(tripId))
    throw new Error(
      'Booking response has no supported trip ID; check trip status before another booking',
    );
  if (legacyTripId && modern?.tripId && legacyTripId !== modern.tripId)
    throw new Error(
      'Booking response has conflicting trip IDs; check trip status',
    );
  return {
    tripId,
    orderId,
    fulfillmentOrderId: orderId,
    currentState:
      modern?.state ??
      (typeof body.clientStatus?.status === 'string'
        ? body.clientStatus.status
        : null),
    requiresCheckout:
      object(body.checkoutActionParameters) ||
      body.trip?.isPendingPaymentConfirmation === true,
  };
}
