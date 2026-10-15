import { authenticatedRequest } from './client.mjs';
import { loadTripMapIcons } from './map-vehicle.mjs';

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

export async function getTripMap(options = {}, { send = authenticatedRequest, loadIcons = loadTripMapIcons } = {}) {
  const scene = normalizeTripMap(await send('/rt/riders/me/status', {}, { readOnly: true }), options);
  let icons = null;
  try { icons = scene.tripId ? await loadIcons(scene.tripId) : null; }
  catch { scene.warnings.push('Saved vehicle artwork is unavailable; position data remains usable.'); }
  return icons ? { ...scene, vehicleMapIcons: icons } : scene;
}
