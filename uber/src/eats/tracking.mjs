import { decodePolyline } from '../trip-map.mjs';
import { nativeGeodesy } from '../native-geodesy.mjs';
import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const trackingId = (v) =>
  typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : null;
const text = (v, max = 2000) =>
  typeof v === 'string' && v.length <= max ? v : null;
const list = (v, max = 100) => (Array.isArray(v) ? v.slice(0, max) : []);
export function trackingText(value) {
  if (typeof value === 'string') return text(value);
  if (!value || typeof value !== 'object') return null;
  if (text(value.text)) return value.text;
  if (text(value.accessibilityText)) return value.accessibilityText;
  if (value.summary) return trackingText(value.summary);
  if (value.richtext) return trackingText(value.richtext);
  if (Array.isArray(value.richTextElements))
    return value.richTextElements
      .map((e) => trackingText(e.text?.text) ?? '')
      .join('')
      .slice(0, 2000);
  // Native display strings sometimes contain only textFormat. Never render it
  // as HTML; strip the closed formatting subset and decode ordinary entities.
  return (
    text(value.textFormat)
      ?.replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>') ?? null
  );
}
export function trackingPoint(value) {
  const lat = value?.latitude,
    lon = value?.longitude;
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return null;
  return { lat, lon };
}
const image = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      [
        'tb-static.uber.com',
        'd1w2poirtb3as9.cloudfront.net',
        'd1a3f4spazzrp4.cloudfront.net',
        'duyt4h9nfnj50.cloudfront.net',
      ].includes(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
};
export function selectTrackedOrder(response, selectedId) {
  if (!Array.isArray(response?.activeEaterOrdersMobileView))
    throw Object.assign(
      new Error('Uber returned no supported active-order tracking response'),
      { code: 'EATS_TRACKING_INVALID' },
    );
  const orders = response.activeEaterOrdersMobileView;
  const matches = orders.filter((o) =>
    [o.uuid, o.orderUUID].map(trackingId).includes(trackingId(selectedId)),
  );
  if (matches.length > 1)
    throw new Error('Ambiguous selected delivery identity');
  return matches[0] ?? null;
}
function stageFor(order) {
  const nativeStatus = text(order.analytics?.data?.order_status);
  const statuses = { EnrouteToDropoff: 'on_the_way' };
  // Native ya6.a ordinals consumed by no5.c.invoke (see tracking protocol).
  // TIME_TO_MEET_COURIER is distinct from ARRIVED, and neither proves delivery.
  const status =
    order.orderFeedV2?.header?.activeOrderStatus ?? order.activeOrderStatus;
  const stages = [
    'order_received',
    'preparing',
    'courier_to_restaurant',
    'on_the_way',
    'time_to_meet_courier',
    'arrived',
  ];
  if (
    status?.totalProgressSegments === 5 &&
    Number.isInteger(status.currentProgress) &&
    stages[status.currentProgress]
  )
    return {
      stage: stages[status.currentProgress],
      source: 'native_tracking_stage_ordinal',
    };
  if (statuses[nativeStatus])
    return {
      stage: statuses[nativeStatus],
      source: 'analytics.data.order_status',
    };
  const native = text(order.orderInfo?.orderPhase);
  return {
    stage:
      native === 'ACTIVE' ? 'active' : (native?.toLowerCase() ?? 'unknown'),
    source: 'orderInfo.orderPhase',
  };
}

/** A closed projection: no contact phone, action tokens, messages or credentials. */
export function normalizeEatsTracking(order, { now = Date.now() } = {}) {
  const workflowId = trackingId(order?.uuid),
    orderId = trackingId(order?.orderUUID);
  if (!workflowId || !orderId)
    throw Object.assign(
      new Error('The delivery has no supported workflow and order identity'),
      { code: 'EATS_TRACKING_INVALID' },
    );
  const status =
      order.orderFeedV2?.header?.activeOrderStatus ??
      order.activeOrderStatus ??
      {},
    overview = order.activeOrderOverview ?? {};
  const feed = list(order.activeOrderFeed);
  const payload = (key) => feed.find((e) => e.payload?.[key])?.payload[key];
  const courier = list(payload('courierPayload')?.courierInfos)[0];
  const dropoff = payload('deliveryPayload');
  const progress = {
    current: Number.isInteger(status.currentProgress)
      ? status.currentProgress
      : null,
    total:
      Number.isInteger(status.totalProgressSegments) &&
      status.totalProgressSegments <= 20
        ? status.totalProgressSegments
        : null,
    color: /^#[0-9a-f]{6}$/i.test(status.progressColor?.color)
      ? status.progressColor.color
      : '#05944f',
    animated: status.animateCurrentProgressSegment === true,
  };
  const waypoints = [],
    routes = [],
    warnings = [];
  let position = null,
    path = [],
    vehicleMapIcons = null;
  for (const entity of list(order.featureDisplay?.mapEntities)) {
    const point = trackingPoint(entity.location);
    const kind = entity.type;
    if (point && ['STORE', 'EATER'].includes(kind))
      waypoints.push({
        ...point,
        kind: kind === 'STORE' ? 'restaurant' : 'dropoff',
        title:
          trackingText(entity.subtitle) ??
          (kind === 'STORE'
            ? text(overview.header?.title)
            : text(entity.location?.address?.title)),
      });
    if (kind === 'COURIER') {
      path = list(entity.pathPoints, 2000)
        .map((p) => ({
          ...trackingPoint(p),
          epoch: Number.isFinite(p.epoch) ? p.epoch : null,
          course: Number.isFinite(p.course) ? p.course : null,
        }))
        .filter((p) => Number.isFinite(p.lat));
      position = point
        ? { ...point, epoch: null, course: null }
        : (path.at(-1) ?? null);
      const marker = entity.marker;
      const sprite = image(marker?.spriteSheetUrl),
        standard = image(marker?.iconUrl ?? entity.markerIconUrl);
      if (sprite || standard)
        vehicleMapIcons = {
          standardMapIcon: { dayImageURL: standard },
          spritesheetMapIcon: { dayImageURL: sprite },
          spriteDivisionCount:
            Number.isInteger(marker?.spriteCount) && marker.spriteCount <= 360
              ? marker.spriteCount
              : 1,
        };
      const routePoints = [],
        routeKeys = [];
      for (const leg of list(entity.routelineLegs, 30)) {
        const points = trackingRoute(leg.encodedPolyline);
        if (points?.length > 1 && routePoints.length + points.length <= 20000) {
          routeKeys.push(leg.encodedPolyline);
          for (const p of points) {
            const last = routePoints.at(-1);
            if (!last || last.lat !== p.lat || last.lon !== p.lon)
              routePoints.push(p);
          }
        }
      }
      if (routePoints.length > 1) {
        routes.push({
          kind: 'provider',
          source: 'native_eats_map_entity',
          points: routePoints,
          geometryKey: createHash('sha256')
            .update(routeKeys.join('|'))
            .digest('hex'),
          ...(routeKeys.length === 1 ? { encodedPolyline: routeKeys[0] } : {}),
        });
        // Native km5.e.b concatenates route legs and uses their first point as
        // the courier position. Receipt time is not a made-up GPS timestamp.
        position = {
          ...routePoints[0],
          epoch: position?.epoch ?? null,
          course: nativeGeodesy.heading(routePoints[0], routePoints[1]),
        };
      }
    }
  }
  if (!waypoints.some((p) => p.kind === 'restaurant') && !position) {
    const point = trackingPoint(order.orderInfo?.storeInfo?.location);
    if (point)
      waypoints.push({
        ...point,
        kind: 'restaurant',
        title: text(overview.header?.title),
      });
  }
  const { stage, source } = stageFor(order);
  const delivery = {
    orderId,
    workflowId,
    stage,
    stageSource: source,
    nativeStatus: text(order.analytics?.data?.order_status),
    nativeState: text(order.analytics?.data?.cfc_state),
    storeName: text(overview.header?.title),
    displayId: trackingText(overview.summary?.subtitle),
    statusTitle:
      trackingText(status.titleSummary) ??
      trackingText(overview.summary?.title),
    statusDetail: trackingText(status.timelineSummary),
    progress,
    eta: {
      display: trackingText(status.title),
      detail: trackingText(status.subtitleSummary),
      estimatedArrivalEpochSeconds: epochSeconds(
        order.analytics?.data?.point_estimate_eta,
      ),
      latestArrivalEpochSeconds: epochSeconds(
        order.analytics?.data?.latest_arrival_by,
      ),
    },
    delay:
      status.activeOrderStatusDelayType || status.statusSummary
        ? {
            type: text(status.activeOrderStatusDelayType),
            message: trackingText(status.statusSummary),
            detail: trackingText(status.statusSummary?.info?.body),
          }
        : null,
    courier: courier
      ? {
          id: trackingId(courier.courierUUID),
          name: text(courier.title)?.split(' • ')[0],
          description: text(courier.description),
          vehicleDescription: trackingText(courier.subtitle),
          photoUrl: image(courier.courierIconUrl),
          vehicleIconUrl: image(courier.vehicleIconUrl),
        }
      : null,
    items: list(overview.items).map((i) => ({
      title: text(i.title),
      quantity: Number.isSafeInteger(i.quantity) ? i.quantity : null,
    })),
    total: text(overview.total),
    dropoff: {
      address: text(dropoff?.address?.formattedAddress),
      instructions: text(dropoff?.deliveryType?.deliveryDescription),
    },
  };
  if (!position)
    warnings.push('Uber has not supplied a courier location in this snapshot.');
  return {
    schemaVersion: 1,
    kind: 'eats',
    observedAt: new Date(now).toISOString(),
    tripId: workflowId,
    orderId,
    state: 'active',
    status: delivery.statusTitle,
    delivery,
    driver: {
      position,
      path,
      prediction: [],
      positionAgeMs: null,
      source: 'native_eats_map_entity',
    },
    vehicleMapIcons,
    routes,
    waypoints,
    eta: {},
    pollingIntervalMs: 8000,
    warnings,
  };
}

/** Native encoded paths only. Never substitute a straight line for a road route. */
export function trackingRoute(encoded) {
  if (typeof encoded !== 'string' || !encoded) return null;
  try {
    return decodePolyline(encoded);
  } catch {
    return null;
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function epochSeconds(value) {
  const n =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
export function deliveryChanges(previous, scene) {
  const d = scene.delivery,
    p = previous?.delivery,
    changes = [];
  const add = (type, data) => changes.push({ type, ...data });
  if (!previous) add('snapshot', { stage: d.stage });
  else {
    if (
      p.stage !== d.stage ||
      p.statusTitle !== d.statusTitle ||
      !same(p.progress, d.progress)
    )
      add('stage_changed', {
        stage: d.stage,
        previousStage: p.stage,
        title: d.statusTitle,
        progress: d.progress,
      });
    if (
      p.stage !== d.stage &&
      scene.state !== 'ended' &&
      [
        'order_received',
        'preparing',
        'courier_to_restaurant',
        'on_the_way',
        'time_to_meet_courier',
        'arrived',
      ].includes(d.stage)
    )
      add(d.stage, { stage: d.stage, previousStage: p.stage });
    if (!same(p.eta, d.eta)) add('eta_changed', { eta: d.eta });
    if (!same(p.delay, d.delay)) add('delay_changed', { delay: d.delay });
    if (!same(p.courier?.id, d.courier?.id))
      add(d.courier ? 'courier_assigned' : 'courier_unassigned', {
        courier: d.courier,
      });
    if (!same(previous.driver?.position, scene.driver?.position))
      add('courier_location', { position: scene.driver?.position });
    if (previous.state !== 'ended' && scene.state === 'ended')
      add(d.stage, { stage: d.stage });
    if (p.statusDetail !== d.statusDetail)
      add('activity_changed', { detail: d.statusDetail });
  }
  return changes;
}
