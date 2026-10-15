import { authenticatedRequest } from './client.mjs';
import { loadTripMapIcons } from './map-vehicle.mjs';
import { fetchSharedTrip } from './trip-share.mjs';
import { fetchRouteline } from './routing.mjs';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const uuid = value => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
const text = value => typeof value === 'string' && value.length <= 500 ? value : null;
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function list(value, maximum, label) {
  if (!Array.isArray(value)) return [];
  if (value.length > maximum) fail('MAP_LIMIT_EXCEEDED', `${label} exceeds the supported map size.`);
  return value;
}
function coordinate(value) {
  if (!object(value) || !finite(value.latitude) || !finite(value.longitude)
    || Math.abs(value.latitude) > 90 || Math.abs(value.longitude) > 180) return null;
  return { lat: value.latitude, lon: value.longitude };
}

/** Native map hub BulkRoutePointsExtractor.d uses scale 1e-5. Current-trip caller coverage remains bounded. */
export function decodePolyline(encoded, { precision = 5, maxPoints = 20000 } = {}) {
  if (typeof encoded !== 'string' || encoded.length > 200000) fail('INVALID_POLYLINE', 'Polyline must be a bounded encoded string.');
  if (![5, 6].includes(precision) || !Number.isSafeInteger(maxPoints) || maxPoints < 1 || maxPoints > 20000) fail('INVALID_POLYLINE', 'Unsupported polyline precision or point limit.');
  let cursor = 0, latitude = 0, longitude = 0;
  const points = [], scale = 10 ** precision;
  function delta() {
    let value = 0, factor = 1;
    for (let group = 0; group < 11; group++) {
      if (cursor >= encoded.length) fail('INVALID_POLYLINE', 'Polyline ends within a coordinate.');
      const byte = encoded.charCodeAt(cursor++) - 63;
      if (byte < 0 || byte > 63) fail('INVALID_POLYLINE', 'Polyline contains an invalid character.');
      value += (byte % 32) * factor;
      if (!Number.isSafeInteger(value)) fail('INVALID_POLYLINE', 'Polyline coordinate overflow.');
      if (byte < 32) return value % 2 === 1 ? -(Math.floor(value / 2) + 1) : value / 2;
      factor *= 32;
    }
    fail('INVALID_POLYLINE', 'Polyline coordinate exceeds the encoding limit.');
  }
  while (cursor < encoded.length) {
    if (points.length >= maxPoints) fail('MAP_LIMIT_EXCEEDED', 'Polyline has too many points.');
    latitude += delta(); longitude += delta();
    const point = coordinate({ latitude: latitude / scale, longitude: longitude / scale });
    if (!point) fail('INVALID_POLYLINE', 'Polyline coordinates are outside geographic bounds.');
    points.push(point);
  }
  return points;
}

function pathPoints(value, warnings) {
  const points = [];
  for (const raw of list(value, 2000, 'Driver path')) {
    const point = coordinate(raw);
    if (!point) { warnings.add('Some driver path points had invalid coordinates and were omitted.'); continue; }
    points.push({ ...point, course: finite(raw.course) && raw.course >= 0 && raw.course < 360 ? raw.course : null,
      epoch: finite(raw.epoch) && raw.epoch >= 0 ? raw.epoch : null,
      speed: finite(raw.speed) && raw.speed >= 0 ? raw.speed : null });
  }
  return points;
}
function driverPosition(path, now, warnings) {
  const timestamped = path.filter(point => point.epoch !== null);
  const past = timestamped.filter(point => point.epoch <= now).sort((a, b) => b.epoch - a.epoch);
  if (past.length) return past[0];
  if (path.length) warnings.add('The driver path has no observed point at or before the current time.');
  return null;
}
function addWaypoint(result, kind, location, extra = {}) {
  const point = coordinate(location);
  if (!point) return;
  result.push({ kind, ...point, ...extra, title: text(location.title) ?? text(location.shortAddress) });
}
function modernWaypoints(job, warnings) {
  const result = [];
  for (const wrapper of list(job?.waypoints, 100, 'Trip waypoints')) {
    const type = wrapper?.transportJobWaypointType;
    if (!object(type)) { warnings.add('A provider or unsupported waypoint was omitted.'); continue; }
    const choices = [['pickup', type.pickupWaypointView], ['dropoff', type.dropoffWaypointView], ['via', type.viaWaypointView]].filter(([, value]) => object(value));
    if (choices.length !== 1) { warnings.add('An unrecognized waypoint union was omitted.'); continue; }
    const [kind, view] = choices[0];
    addWaypoint(result, kind, view.location?.location, { uuid: uuid(view.uuid), state: text(view.stateInfo?.state) });
  }
  return result;
}
function collectCandidates(body) {
  const candidates = new Map(); let recognized = false, unsupported = 0;
  const modern = body.riderAppOrdersResponse, single = body.singleRiderAppOrderResponse;
  function addModern(order, features) {
    if (!object(order)) return;
    const one = order.jobs?.singlePersonalTransport?.transport;
    const jobs = object(one) ? [one] : list(order.jobs?.multiplePersonalTransport?.transportJobs, 50, 'Transport jobs');
    if (!jobs.length) unsupported++;
    for (const job of jobs) {
      const tripId = uuid(job?.id);
      if (!tripId) { unsupported++; continue; }
      const prior = candidates.get(tripId);
      const mergedJob = prior ? { ...prior.job, ...job, provider: { ...prior.job?.provider, ...job.provider,
        vehicle: { ...prior.job?.provider?.vehicle, ...job.provider?.vehicle } } } : job;
      const mergedFeatures = prior ? { ...prior.features, ...features,
        mapRoutelineFeature: { ...prior.features?.mapRoutelineFeature, ...features?.mapRoutelineFeature } } : features;
      candidates.set(tripId, { tripId, fulfillmentOrderId: uuid(order.id) ?? prior?.fulfillmentOrderId ?? null,
        orderState: text(order.state) ?? prior?.orderState ?? null, job: mergedJob, features: mergedFeatures,
        legacy: prior?.legacy ?? null, source: 'modern_status' });
    }
  }
  if (Array.isArray(modern?.orders)) { recognized = true; for (const order of list(modern.orders, 50, 'Rider orders')) addModern(order, modern.features?.[order?.id]); }
  if (object(single?.order)) { recognized = true; addModern(single.order, single.features); }
  const orders = body.fulfillmentStateData?.orders;
  if (Array.isArray(orders)) {
    recognized = true;
    for (const order of list(orders, 50, 'Fulfillment orders')) {
      const jobs = list(order?.orderPlan?.jobs, 50, 'Fulfillment jobs');
      if (!jobs.length) unsupported++;
      for (const job of jobs) {
      const trip = job?.legacyTripData?.trip, tripId = uuid(trip?.uuid);
      if (!tripId) { unsupported++; continue; }
      const prior = candidates.get(tripId);
      candidates.set(tripId, prior ? { ...prior, legacy: trip } : { tripId, fulfillmentOrderId: uuid(order.orderId?.uuid), orderState: null, legacy: trip, job: null, features: null, source: 'legacy_status' });
      }
    }
  }
  if (object(body.trip)) {
    recognized = true; const tripId = uuid(body.trip.uuid);
    if (!tripId) unsupported++;
    else { const prior = candidates.get(tripId); candidates.set(tripId, prior ? { ...prior, legacy: body.trip } : { tripId, fulfillmentOrderId: uuid(body.trip.fulfillmentOrderId?.uuid ?? body.trip.fulfillmentOrderId), orderState: null, legacy: body.trip, job: null, features: null, source: 'legacy_trip_response' }); }
  }
  if (!recognized) fail('UNSUPPORTED_MAP_RESPONSE', 'The response has no recognized Uber trip collections.');
  return { candidates: [...candidates.values()], unsupported };
}
function safeIcon(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
// Legacy Trip.eta is numeric, but its wire unit is not established by the retained caller coverage.
function pickupEta() { return null; }

/** A closed map projection: no authentication, payment, phone or raw-response fields. */
export function normalizeTripMap(payload, { tripId, now = Date.now() } = {}) {
  if (now instanceof Date) now = now.getTime();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) fail('INVALID_MAP_TIME', 'Supply a finite current timestamp in milliseconds.');
  if (tripId !== undefined && !uuid(tripId)) fail('INVALID_TRIP_ID', 'Supply a canonical Uber trip UUID.');
  const body = object(payload?.body) ? payload.body : payload;
  if (!object(body)) fail('UNSUPPORTED_MAP_RESPONSE', 'The response is not a trip-status object.');
  // A failed server-side order fetch is not an empty account or a cancelled ride.
  // Observed on a real booking: fulfillmentStateData.orders was null while
  // riderAppOrdersFetchSucceeded was false and clientStatus was Dispatching.
  if (body.riderAppOrdersFetchResult?.riderAppOrdersFetchSucceeded === false) {
    fail('MAP_TRIP_FETCH_FAILED', 'Uber could not fetch the trip details. No current driver location is available.');
  }
  const { candidates, unsupported } = collectCandidates(body), warnings = new Set();
  if (unsupported) warnings.add('Some active orders have no supported map transport shape.');
  const clientStatus = text(body.clientStatus?.status);
  const pollingIntervalMs = Number.isSafeInteger(body.metadata?.pollingIntervalMs) && body.metadata.pollingIntervalMs > 0 && body.metadata.pollingIntervalMs <= 3600000 ? body.metadata.pollingIntervalMs : null;
  const base = { schemaVersion: 1, observedAt: new Date(now).toISOString(), pollingIntervalMs, clientStatus };
  let selected;
  if (tripId !== undefined) { selected = candidates.find(candidate => candidate.tripId === uuid(tripId)); if (!selected) fail('TRIP_NOT_FOUND', 'The requested trip is absent from the current status response.'); }
  else {
    if (candidates.length > 1) fail('AMBIGUOUS_TRIP', 'Multiple trips are active. Select the exact trip UUID.');
    selected = candidates[0];
  }
  if (!selected) return { ...base, state: unsupported ? 'unknown' : 'idle', tripId: null, fulfillmentOrderId: null, status: clientStatus, driver: { path: [], position: null }, routes: [], waypoints: [], eta: { display: null, pickupMinutes: null, pickupDisplay: null, destinationSeconds: null }, vehicleMapIconUrl: null, warnings: [...warnings] };
  const trip = selected.legacy, feature = selected.features?.mapRoutelineFeature;
  const waypoints = selected.job ? modernWaypoints(selected.job, warnings) : [];
  if (!waypoints.length && trip) {
    addWaypoint(waypoints, 'pickup', trip.pickupLocation);
    for (const location of list(trip.viaLocations, 100, 'Via locations')) addWaypoint(waypoints, 'via', location);
    addWaypoint(waypoints, 'dropoff', trip.destination);
  }
  const routes = [], seenRoutes = new Set(); let decodedPointCount = 0;
  function route(encoded, kind, extra = {}) {
    if (typeof encoded !== 'string' || !encoded || seenRoutes.has(encoded)) return;
    if (routes.length >= 200) fail('MAP_LIMIT_EXCEEDED', 'Too many trip route segments.');
    try { const points = decodePolyline(encoded); decodedPointCount += points.length; if (decodedPointCount > 50000) fail('MAP_LIMIT_EXCEEDED', 'Trip routes exceed the supported total point count.'); if (points.length) { routes.push({ kind, encodedPolyline: encoded, points, ...extra }); seenRoutes.add(encoded); } }
    catch (error) { if (error.code === 'MAP_LIMIT_EXCEEDED') throw error; warnings.add('An invalid route polyline was omitted.'); }
  }
  route(feature?.encodedProviderPolyline, 'provider');
  const waypointIds = new Set(waypoints.map(point => point.uuid).filter(Boolean));
  for (const leg of list(feature?.legs, 100, 'Modern route legs')) {
    if (!waypointIds.has(uuid(leg?.uuid))) { warnings.add('A route leg outside the selected trip waypoints was omitted.'); continue; }
    route(leg?.encodedPolyline, 'trip_leg', { waypointUUID: uuid(leg?.uuid), entityRef: text(leg?.entityRef) });
  }
  if (!routes.length && trip) {
    route(trip.currentRoute, 'provider');
    for (const leg of list(trip.legs, 100, 'Legacy route legs')) route(leg?.encodedPolyline, 'trip_leg', { locationEndRef: text(leg?.locationEndRef) });
  }
  const modernPath = selected.job?.provider?.vehicle?.vehiclePath;
  const hasModernPath = Array.isArray(modernPath) && modernPath.length > 0;
  const rawPath = hasModernPath ? modernPath : trip?.vehicle?.vehiclePath;
  const path = pathPoints(rawPath, warnings), position = driverPosition(path, now, warnings);
  const status = selected.orderState ?? clientStatus ?? text(trip?.driver?.status);
  const terminal = [status, clientStatus].some(value => ['ClientCanceled', 'DriverCanceled', 'Completed', 'Canceled', 'COMPLETED', 'CANCELED'].includes(value));
  const dispatching = clientStatus === 'Dispatching' || status === 'Dispatching';
  if (!path.length) warnings.add('No assigned-driver coordinates are present in this status snapshot.');
  return { ...base, state: terminal ? 'ended' : dispatching ? 'dispatching' : 'active', tripId: selected.tripId,
    fulfillmentOrderId: selected.fulfillmentOrderId, status, source: selected.source,
    driver: { path, position: terminal ? null : position, positionAgeMs: position ? Math.max(0, now - position.epoch) : null, source: hasModernPath ? 'transport_provider_vehicle_path' : trip?.vehicle?.vehiclePath ? 'legacy_vehicle_path' : null },
    routes, waypoints, eta: { display: text(trip?.etaString) ?? text(trip?.etaStringShort), pickupMinutes: pickupEta(trip), pickupDisplay: text(trip?.etaString) ?? text(trip?.etaStringShort), destinationSeconds: null },
    vehicleMapIconUrl: safeIcon(feature?.vehicleMapIconUrl ?? trip?.vehicleMapIconUrl), warnings: [...warnings] };
}

/** Native sharing projection; no share tokens, rider/driver identity or contact fields. */
export function normalizeSharedTripMap(payload, options = {}) {
  const body = object(payload?.body) ? payload.body : payload;
  if (!uuid(body?.uuid) || typeof body.status !== 'string') fail('UNSUPPORTED_MAP_RESPONSE', 'Unrecognized Uber shared-trip response.');
  if (options.tripId && uuid(options.tripId) !== uuid(body.uuid)) fail('TRIP_NOT_FOUND', 'The shared trip does not match the selected ride.');
  if (body.tokenState !== 'ACTIVE') fail('MAP_SHARE_REVOKED', 'Uber trip tracking is no longer available.');
  const now = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now();
  const locations = list(body.locations, 2000, 'Shared driver locations');
  // Do not guess seconds-to-ms conversions for an unverified timestamp scalar.
  const observed = locations.filter(point => finite(point?.epoch) && point.epoch >= now - 86400000 && point.epoch <= now + 3600000);
  const legs = body.hideRouteline === true ? [] : list(body.routeLines, 100, 'Shared route lines').map(line => ({ encodedPolyline: line?.encodedPolyline }));
  const scene = normalizeTripMap({ clientStatus: { status: body.status }, trip: {
    uuid: body.uuid, pickupLocation: body.pickupLocation, destination: body.destination,
    vehicle: { vehiclePath: observed }, legs,
  } }, options);
  scene.source = 'native_trip_share';
  scene.routeDisplayAllowed = body.hideRouteline !== true;
  scene.driver.source = observed.length ? 'native_share_locations' : null;
  scene.pollingIntervalMs = 8000;
  if (locations.length !== observed.length) scene.warnings.push('Some shared location timestamps could not be verified as recent milliseconds.');
  return scene;
}

export async function enrichTripRoutes(scene, { send = authenticatedRequest, loadRoute = fetchRouteline } = {}) {
  if (!['active', 'dispatching'].includes(scene.state) || scene.routes.length || scene.routeDisplayAllowed === false
      || scene.waypoints.some(point => point.kind === 'via')) return scene;
  const pickup = scene.waypoints.find(point => point.kind === 'pickup');
  const dropoff = scene.waypoints.find(point => point.kind === 'dropoff');
  const routes = [];
  async function add(from, to, kind) {
    if (!from || !to) return;
    try {
      const result = await loadRoute(`${from.lat},${from.lon}`, `${to.lat},${to.lon}`, { send });
      const points = decodePolyline(result.encodedPolyline);
      const near = (a, b) => Math.abs(a.lat - b.lat) < 0.005 && Math.abs(a.lon - b.lon) < 0.005;
      if (points.length < 2 || !near(points[0], from) || !near(points.at(-1), to)) throw new Error('Route endpoints do not match');
      routes.push({ kind, source: 'uber_routing_recommendation', encodedPolyline: result.encodedPolyline, points });
    } catch { scene.warnings.push('An Uber road-route recommendation is unavailable; current positions remain usable.'); }
  }
  if (['EnRoute', 'Accepted', 'Arriving', 'Arrived'].includes(scene.status)) await add(scene.driver.position, pickup, 'provider_recommended');
  if (['OnTrip', 'InProgress'].includes(scene.status)) await add(scene.driver.position, dropoff, 'provider_recommended');
  else await add(pickup, dropoff, 'trip_recommended');
  if (routes.length) scene.warnings.push('Road routes are Uber recommendations; the driver-selected navigation route is unverified.');
  return { ...scene, routes };
}

export async function getTripMap(options = {}, { send = authenticatedRequest, loadIcons = loadTripMapIcons, loadSharedTrip = fetchSharedTrip, loadRoute = fetchRouteline } = {}) {
  const status = await send('/rt/riders/me/status', {}, { readOnly: true });
  let scene;
  try { scene = normalizeTripMap(status, options); }
  catch (error) {
    if (!options.tripId || !['MAP_TRIP_FETCH_FAILED', 'UNSUPPORTED_MAP_RESPONSE', 'TRIP_NOT_FOUND'].includes(error.code)) throw error;
    scene = normalizeSharedTripMap(await loadSharedTrip(options.tripId, { send }), options);
    scene.warnings.push('Account status omitted this trip; using the native trip-sharing data source.');
  }
  scene = await enrichTripRoutes(scene, { send, loadRoute });
  let icons = null;
  try { icons = scene.tripId ? await loadIcons(scene.tripId) : null; }
  catch { scene.warnings.push('Saved vehicle artwork is unavailable; position data remains usable.'); }
  return icons ? { ...scene, vehicleMapIcons: icons } : scene;
}
