import { normalizeTripMap } from './trip-map.mjs';
import { nativeGeodesy } from './native-geodesy.mjs';
const uuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
const display = (value) =>
  typeof value === 'string' && value.length <= 200 && value.trim()
    ? value.trim()
    : null;

// Closed projection of native TripDriverLocationUpdateV2. No message contents,
// identities, contacts, tokens or unrelated account events reach the iframe.
export function applyDriverUpdate(
  scene,
  update,
  { now = Date.now(), sequence } = {},
) {
  if (
    !uuid(update?.tripUuid) ||
    uuid(update.tripUuid) !== uuid(scene.tripId) ||
    !['active', 'dispatching'].includes(scene.state)
  )
    return scene;
  const path =
    Array.isArray(update.vehiclePathPoints) &&
    update.vehiclePathPoints.length <= 2000
      ? update.vehiclePathPoints
      : [];
  const raw = { uuid: scene.tripId, vehicle: { vehiclePath: path } };
  if (
    typeof update.currentRoute === 'string' &&
    update.currentRoute.length <= 200000
  )
    raw.currentRoute = update.currentRoute;
  const normalized = normalizeTripMap(
    { clientStatus: { status: scene.status }, trip: raw },
    { tripId: scene.tripId, now },
  );
  const nativeRoute = normalized.routes.find(
    (route) => route.kind === 'provider',
  );
  let position = normalized.driver.position;
  if (nativeRoute?.points.length) {
    // The shipped mapper treats the first currentRoute point as location.
    // Preserve the real wire epoch; receipt time is not a fabricated GPS epoch.
    const [a, b] = nativeRoute.points;
    position = {
      ...a,
      epoch: position?.epoch ?? null,
      course: b ? nativeGeodesy.heading(a, b) : (position?.course ?? 0),
    };
  }
  const validPrediction =
    Array.isArray(update.prediction) &&
    update.prediction.length <= 2000 &&
    update.prediction.every(
      (p, index, array) =>
        Number.isFinite(p?.distanceInMeters) &&
        p.distanceInMeters >= 0 &&
        Number.isSafeInteger(p.timestamp) &&
        (!index || p.timestamp >= array[index - 1].timestamp),
    );
  const predictions = validPrediction
    ? update.prediction.map((p) => ({
        distanceInMeters: p.distanceInMeters,
        timestamp: p.timestamp,
      }))
    : [];
  const driver = {
    ...scene.driver,
    ...(position
      ? {
          position,
          path: normalized.driver.path,
          positionAgeMs: Number.isFinite(position.epoch)
            ? Math.max(0, now - position.epoch)
            : null,
        }
      : {}),
    prediction: predictions,
    receivedAt: new Date(now).toISOString(),
    streamSequence: sequence === undefined ? undefined : String(sequence),
    source: 'native_driver_location_push',
  };
  const eta = { ...scene.eta };
  if (
    scene.ride
      ? ['approaching', 'arriving', 'waiting'].includes(scene.ride.phase)
      : ['EnRoute', 'Accepted', 'Arriving', 'Arrived'].includes(scene.status)
  ) {
    if (Number.isSafeInteger(update.etaToPickup)) {
      eta.pickupMinutes = update.etaToPickup >= 0 ? update.etaToPickup : null;
      eta.pickupDisplay =
        update.etaToPickup >= 0
          ? (display(update.etaToPickupStringShort) ??
            display(update.etaToPickupString) ??
            `${update.etaToPickup} min`)
          : null;
      eta.source = 'native_driver_location_push';
      eta.observedAt = new Date(now).toISOString();
    } else if (
      display(update.etaToPickupStringShort) ??
      display(update.etaToPickupString)
    ) {
      eta.pickupDisplay =
        display(update.etaToPickupStringShort) ??
        display(update.etaToPickupString);
      eta.source = 'native_driver_location_push';
      eta.observedAt = new Date(now).toISOString();
    }
  }
  return {
    ...scene,
    observedAt: new Date(now).toISOString(),
    driver,
    eta,
    routes: nativeRoute
      ? [
          { ...nativeRoute, source: 'native_driver_location_push' },
          ...scene.routes.filter(
            (route) =>
              !['provider', 'provider_recommended'].includes(route.kind),
          ),
        ]
      : scene.routes,
    liveTransport: {
      mode: 'ramen_grpc',
      lastMessageAt: new Date(now).toISOString(),
    },
  };
}

export class MapLiveProjection {
  constructor(tripId, { now = Date.now } = {}) {
    this.tripId = uuid(tripId);
    this.now = now;
    this.base = null;
    this.latest = null;
    this.push = null;
    this.sequence = null;
  }
  snapshot(scene) {
    if (this.tripId && scene.tripId && uuid(scene.tripId) !== this.tripId)
      throw new Error('Map snapshot changed selected trip');
    this.tripId ??= uuid(scene.tripId);
    if (this.base?.state === 'ended') return this.project();
    this.base = scene;
    if (!['active', 'dispatching'].includes(scene.state)) {
      this.push = null;
      this.sequence = null;
    }
    return this.project();
  }
  accept(update, sequence) {
    if (
      !this.base ||
      uuid(update?.tripUuid) !== this.tripId ||
      !['active', 'dispatching'].includes(this.base.state)
    )
      return null;
    const seq = BigInt(sequence);
    if (this.sequence !== null && seq <= this.sequence) return null;
    this.sequence = seq;
    this.push = { update, at: this.now(), sequence: seq.toString() };
    return this.project();
  }
  project() {
    this.latest = this.base;
    if (this.push && this.now() - this.push.at <= 60000) {
      const projected = applyDriverUpdate(this.base, this.push.update, {
        now: this.push.at,
        sequence: this.push.sequence,
      });
      const baseEpoch = this.base.driver?.position?.epoch,
        pushEpoch = projected.driver?.position?.epoch;
      // Keep the native ETA, but never move backward to a push older than an
      // independently timestamped snapshot. Without comparable epochs the native
      // currentRoute stays authoritative, as in the shipped location mapper.
      this.latest =
        Number.isFinite(baseEpoch) &&
        Number.isFinite(pushEpoch) &&
        baseEpoch > pushEpoch
          ? { ...projected, driver: this.base.driver, routes: this.base.routes }
          : projected;
    }
    return this.latest;
  }
}
