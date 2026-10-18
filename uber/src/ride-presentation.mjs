const text = (value) =>
  typeof value === 'string' && value.trim() && value.length <= 500
    ? value.trim()
    : null;
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
function image(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (url.hostname === 'uber.com' ||
        url.hostname.endsWith('.uber.com') ||
        [
          'd1w2poirtb3as9.cloudfront.net',
          'd1a3f4spazzrp4.cloudfront.net',
        ].includes(url.hostname))
      ? url.href
      : null;
  } catch {
    return null;
  }
}
const phaseFor = (status) =>
  ({
    Dispatching: 'searching',
    Looking: 'searching',
    Accepted: 'approaching',
    EnRoute: 'approaching',
    EN_ROUTE: 'approaching',
    Arriving: 'arriving',
    Arrived: 'waiting',
    OnTrip: 'riding',
    ON_TRIP: 'riding',
    InProgress: 'riding',
    Completed: 'completed',
    COMPLETED: 'completed',
    ClientCanceled: 'cancelled',
    DriverCanceled: 'cancelled',
    Canceled: 'cancelled',
    Cancelled: 'cancelled',
    CANCELED: 'cancelled',
    CANCELLED: 'cancelled',
  })[status] ?? 'unknown';
const titles = {
  searching: 'Finding your driver',
  approaching: 'Your driver is on the way',
  arriving: 'Your driver is arriving',
  waiting: 'Your driver is waiting',
  riding: 'On your way',
  completed: 'Ride completed',
  cancelled: 'Ride cancelled',
  unknown: 'Ride details',
};

/** Selected-trip display fields only. Never forward the rider, phone, tokens or raw DTO. */
export function withRidePresentation(scene, { trip, shared } = {}) {
  if (!scene.tripId) return scene;
  let phase = phaseFor(scene.status);
  // A marketplace order is IN_PROGRESS while the driver is still approaching.
  // The native RAO ETA selector switches legs when the pickup is COMPLETED.
  if (
    scene.state === 'active' &&
    scene.waypoints?.some(
      (point) => point.kind === 'pickup' && point.state === 'COMPLETED',
    )
  )
    phase = 'riding';
  const rawDriver = shared?.driver ?? trip?.driver;
  const rawVehicle = shared?.vehicle ?? trip?.vehicle;
  const rating = Number(rawDriver?.rating);
  const driver =
    rawDriver && rawDriver.shouldShowDriverProfile !== false
      ? {
          id: uuid(rawDriver.uuid),
          name:
            rawDriver.driverVisibilitySettings?.hideName === true
              ? null
              : text(shared ? rawDriver.firstName : rawDriver.name),
          photoUrl:
            rawDriver.driverVisibilitySettings?.hidePicture === true
              ? null
              : image(rawDriver.pictureUrl),
          rating:
            rawDriver.driverVisibilitySettings?.hideRating !== true &&
            rawDriver.rating !== null &&
            rawDriver.rating !== undefined &&
            Number.isFinite(rating) &&
            rating >= 0 &&
            rating <= 5
              ? rating
              : null,
        }
      : null;
  const vehicle = rawVehicle
    ? {
        make: text(shared ? rawVehicle.make : rawVehicle.vehicleType?.make),
        model: text(shared ? rawVehicle.model : rawVehicle.vehicleType?.model),
        color: text(
          shared
            ? rawVehicle.color?.name
            : (rawVehicle.vehicleColorTranslatedName ??
                rawVehicle.vehicleColorName),
        ),
        licensePlate: text(rawVehicle.licensePlate),
        imageUrl: image(shared ? rawVehicle.iconImage?.url : null),
      }
    : null;
  const stop = (kind, sharedKind) => {
    const waypoint = scene.waypoints?.find((point) => point.kind === kind);
    const raw = shared?.waypoints?.find((point) => point.type === sharedKind);
    const title = text(waypoint?.title);
    const address = text(raw?.address) ?? text(waypoint?.address);
    return waypoint || address ? { title, address } : null;
  };
  const approaching = [
    'searching',
    'approaching',
    'arriving',
    'waiting',
  ].includes(phase);
  const terminal = scene.state === 'ended';
  return {
    ...scene,
    kind: 'ride',
    eta: terminal
      ? {
          display: null,
          pickupMinutes: null,
          pickupDisplay: null,
          destinationSeconds: null,
          destinationMinutes: null,
          destinationDisplay: null,
        }
      : scene.eta,
    ride: {
      tripId: scene.tripId,
      phase,
      statusTitle: text(shared?.tripStatusText) ?? titles[phase],
      statusDetail: null,
      driver,
      vehicle,
      pickup: stop('pickup', 'PICKUP'),
      destination: stop('dropoff', 'DESTINATION'),
      product: null,
    },
    mapPresentation: {
      phase,
      waypointKinds: approaching
        ? ['pickup']
        : phase === 'riding'
          ? ['via', 'dropoff']
          : ['pickup', 'via', 'dropoff'],
      // The ON_TRIP dropoff layer is native gated. Keep future trip legs out of
      // approach bounds; preserve them in the full scene for consumers.
      routeKinds: terminal
        ? []
        : approaching
          ? ['provider', 'provider_recommended']
          : phase === 'riding'
            ? [
                'provider',
                'provider_recommended',
                'trip_leg',
                'trip_recommended',
              ]
            : [
                'provider',
                'provider_recommended',
                'trip_leg',
                'trip_recommended',
              ],
    },
  };
}
