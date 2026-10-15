/**
 * Static reconstruction of the native vehicle planner and frame sampler.
 * Port scope: Uber Android com.ubercab 4.651.10003 APK SHA256
 * 2a92686a421d1d37bd16d287869ac9dbc5c71f36a6b0793b187f0a2bc1c24a91.
 * Sources: hub.g.{b,c,d}, hub.c.{b,d,e,f,g}, hub.c.a.run,
 * TripMapVehicleMapLayerInteractor.Eu, ym9.b.a, w72.k.a, lub.a.{b,d}.
 * See docs/map-parity.md for provenance and coverage limits. Static port, not runtime parity proof.
 *
 * Shapes:
 * point={lat,lon}; edge={start,end,length,heading};
 * agent={index,fraction,heading}; vehicle={route:edge[],agent,position:point};
 * relative={start,duration,kind:'vehicle'|'polyline',entity,reset:boolean}.
 *
 * Geodesy dependency deliberately REQUIRED. Both native distance (mj8.b.b) and
 * heading (lub.a.a) call Android Location.distanceBetween WGS84 and round to
 * float32. Reviewed port is native-geodesy.mjs; no haversine substitute.
 * geo.distance(a,b), geo.heading(a,b), geo.onSegment(point,a,b,toleranceMeters).
 * geo.onSegment must implement shipped yt.a.a(...,false,.1) boundary behavior.
 */
const defaults = Object.freeze({
  catchUp: false,
  initialSeconds: 5,
  catchUpFraction: 0.5,
  minSeconds: 0.5,
  teleportLinearMeters: 500,
  teleportPathMeters: 225,
  rerouteTeleportMeters: 150,
  maxDistanceFromPathMeters: 10,
  handlerMs: 16,
});
const rad = (x) => x * 0.017453292519943295,
  deg = (x) => x * 57.29577951308232;
export function sphericalInterpolate(a, b, f) {
  const aLat = rad(a.lat),
    aLon = rad(a.lon),
    bLat = rad(b.lat),
    bLon = rad(b.lon);
  const latSin = Math.sin((aLat - bLat) * 0.5),
    lonSin = Math.sin((aLon - bLon) * 0.5);
  const omega =
    Math.asin(
      Math.sqrt(
        Math.cos(bLat) * Math.cos(aLat) * lonSin * lonSin + latSin * latSin,
      ),
    ) * 2;
  const sin = Math.sin(omega);
  if (sin < 1e-6)
    return {
      lat: a.lat + (b.lat - a.lat) * f,
      lon: a.lon + (b.lon - a.lon) * f,
    };
  const wa = Math.sin((1 - f) * omega) / sin,
    wb = Math.sin(f * omega) / sin;
  const x =
    Math.cos(aLat) * wa * Math.cos(aLon) + Math.cos(bLat) * wb * Math.cos(bLon);
  const y =
    Math.cos(aLat) * wa * Math.sin(aLon) + Math.cos(bLat) * wb * Math.sin(bLon);
  const z = Math.sin(aLat) * wa + Math.sin(bLat) * wb;
  return {
    lat: deg(Math.atan2(z, Math.sqrt(y * y + x * x))),
    lon: deg(Math.atan2(y, x)),
  };
}
export function projectSegment(a, b, p) {
  const x = b.lat - a.lat,
    y = b.lon - a.lon,
    px = p.lat - a.lat,
    py = p.lon - a.lon;
  const dot = x * px + y * py;
  if (dot <= 0) return { ...a };
  const length = x * x + y * y;
  if (length <= dot) return { ...b };
  const f = dot / length;
  return { lat: a.lat + x * f, lon: a.lon + y * f };
}
export class NativeFrameSampler {
  constructor(delayMs = 0) {
    this.delayMs = delayMs;
    this.points = [];
    this.previous = null;
  }
  replace(points) {
    this.points = points
      .filter((p) => p.lat != null && p.lon != null)
      .map((p) => ({
        ...p,
        course: p.course ?? 0,
        epoch: Math.trunc(p.epoch ?? 0),
      }));
  }
  sample(nowMs) {
    const t = nowMs - this.delayMs,
      target = this.points[0] ?? null,
      previous = this.previous;
    if (target && t >= target.epoch) this.points.shift();
    let result;
    if (!target) result = previous ? { ...previous, epoch: t } : null;
    else if (!previous) result = { ...target, epoch: t };
    else {
      const f =
        target.epoch > previous.epoch
          ? Math.min(1, (t - previous.epoch) / (target.epoch - previous.epoch))
          : 1;
      result = {
        ...sphericalInterpolate(previous, target, f),
        course: target.course,
        epoch: t,
      };
    }
    this.previous = result;
    return result;
  }
}
export function edge(a, b, geo) {
  const length = geo.distance(a, b);
  return {
    start: a,
    end: b,
    length,
    heading: length > 0 ? geo.heading(a, b) : null,
  };
}
function routeLength(route) {
  return route.reduce((n, e) => n + e.length, 0);
}
export function pointAt(route, agent) {
  const e = route[agent.index];
  return e ? sphericalInterpolate(e.start, e.end, agent.fraction) : null;
}
function positionOnRoute(route, p, geo) {
  let best = null,
    distance = Number.MAX_VALUE;
  for (let i = 0; i < route.length; i++) {
    const e = route[i],
      projection = projectSegment(e.start, e.end, p),
      d = geo.distance(p, projection);
    if (d < distance) {
      best = { index: i, projection };
      distance = d;
    }
  }
  if (!best || distance > 10) return null;
  const e = route[best.index],
    q = best.projection;
  const same = (a, b) => a.lat === b.lat && a.lon === b.lon;
  if (
    !same(q, e.start) &&
    !same(q, e.end) &&
    !geo.onSegment(q, e.start, e.end, 0.1)
  )
    return null;
  const length = geo.distance(e.start, e.end);
  return {
    index: best.index,
    fraction: length === 0 ? 0 : geo.distance(e.start, q) / length,
    heading: geo.heading(e.start, e.end),
  };
}
function subroute(route, a, b, geo) {
  const forward =
    a.index < b.index || (a.index === b.index && a.fraction <= b.fraction);
  if (!forward)
    return subroute(route, b, a, geo)
      .map((e) => edge(e.end, e.start, geo))
      .reverse();
  if (a.index < 0 || b.index >= route.length) return [];
  const result = route.slice(a.index, b.index + 1);
  if (!result.length) return result;
  const first = result[0],
    last = result.at(-1),
    start = sphericalInterpolate(first.start, first.end, a.fraction),
    end = sphericalInterpolate(last.start, last.end, b.fraction);
  if (first === last) result[0] = edge(start, end, geo);
  else {
    result[0] = edge(start, first.end, geo);
    result[result.length - 1] = edge(last.start, end, geo);
  }
  return result;
}
function remaining(route, agent, geo) {
  return agent
    ? subroute(route, agent, { index: route.length - 1, fraction: 1 }, geo)
    : route;
}
function geometry(route) {
  return route.length ? [...route.map((e) => e.start), route.at(-1).end] : [];
}
export function relativeAnimations(
  fullRoute,
  traversed,
  heading,
  reset,
  linear,
  geo,
) {
  const vehicle = [],
    polyline = [],
    total = routeLength(traversed);
  let cursor = 0,
    currentHeading = heading;
  if (reset && traversed.length) {
    const first = traversed[0];
    vehicle.push({
      start: 0,
      duration: 0,
      kind: 'vehicle',
      entity: { ...first.start, course: first.heading ?? heading },
    });
    cursor = 0.001;
  }
  for (let i = 0; i < traversed.length; i++) {
    const e = traversed[i];
    if (e.heading != null) currentHeading = e.heading;
    let duration = total !== 0 ? e.length / total : 1;
    if (reset && i === 0) duration -= 0.001;
    vehicle.push({
      start: cursor,
      duration,
      kind: 'vehicle',
      entity: { ...e.end, course: currentHeading },
    });
    cursor += duration;
  }
  cursor = 0;
  if (reset && traversed.length) {
    const p = positionOnRoute(fullRoute, traversed[0].start, geo);
    polyline.push({
      start: 0,
      duration: 0,
      kind: 'polyline',
      entity: geometry(remaining(fullRoute, p, geo)),
      reset: true,
    });
    cursor = 0.001;
  }
  for (let i = 0; i < traversed.length; i++) {
    const e = traversed[i],
      p = positionOnRoute(fullRoute, e.end, geo);
    let duration = total === 0 ? 1 : e.length / total;
    if (reset && i === 0) duration -= 0.001;
    polyline.push({
      start: cursor,
      duration,
      kind: 'polyline',
      entity: geometry(remaining(fullRoute, p, geo)),
      reset: linear || reset,
    });
    cursor += duration;
  }
  return [...vehicle, ...polyline];
}
const sameRoute = (a, b) =>
  a.length === b.length &&
  a.every((e, i) => {
    const f = b[i];
    return (
      e.length === f.length &&
      e.start.lat === f.start.lat &&
      e.start.lon === f.start.lon &&
      e.end.lat === f.end.lat &&
      e.end.lon === f.end.lon
    );
  }); // AutoValue_Edge equals: start,end,length.
export class NativeRoutePlanner {
  constructor(geo, params = {}) {
    for (const n of ['distance', 'heading', 'onSegment'])
      if (typeof geo?.[n] !== 'function')
        throw new TypeError('Missing native geodesy ' + n);
    this.geo = geo;
    this.params = { ...defaults, ...params };
    this.previous = null;
  }
  initial(v) {
    const a = v.agent,
      start =
        a.index === 0 && a.fraction === 0
          ? a
          : {
              index: a.fraction > 0 ? a.index : a.index - 1,
              fraction: 0,
              heading: a.heading,
            };
    return relativeAnimations(
      v.route,
      subroute(v.route, start, a, this.geo),
      start.heading,
      true,
      false,
      this.geo,
    );
  }
  plan(v) {
    const prior = this.previous,
      geo = this.geo;
    let animations, mode;
    if (!prior) {
      animations = this.initial(v);
      mode = 'initial';
    } else {
      const distance = geo.distance(prior.position, v.position);
      if (distance >= this.params.teleportLinearMeters) {
        animations = this.initial(v);
        mode = 'teleport';
      } else {
        const priorOnNew = sameRoute(prior.route, v.route)
          ? prior.agent
          : positionOnRoute(v.route, prior.position, geo);
        const traversed = priorOnNew
          ? subroute(v.route, priorOnNew, v.agent, geo)
          : null;
        if (
          traversed &&
          routeLength(traversed) < this.params.teleportPathMeters
        ) {
          animations = relativeAnimations(
            v.route,
            traversed,
            priorOnNew.heading,
            false,
            false,
            geo,
          );
          mode = 'route';
        } else if (distance > this.params.rerouteTeleportMeters) {
          animations = this.initial(v);
          mode = 'teleport';
        } else {
          animations = relativeAnimations(
            v.route,
            [edge(prior.position, v.position, geo)],
            prior.agent.heading,
            false,
            true,
            geo,
          );
          mode = 'linear';
        }
      }
    }
    // Both accepted real observations and emitted predictions update this prior.
    // Caller applies c9b.h suppression before planning older real observations.
    this.previous = v;
    return { animations, mode };
  }
}
export class NativeTimingQueue {
  constructor(params = {}) {
    this.params = { ...defaults, ...params };
    this.pending = [];
    this.current = [];
    this.intervals = Array(5).fill(this.initial());
    this.counter = 0;
    this.lastArrival = 0;
    this.nextAt = 0;
    this.duration = this.initial();
    this.catchUpTime = 0;
    this.paused = true;
  }
  initial() {
    return this.params.catchUp ? this.params.initialSeconds : 5;
  }
  baseDuration() {
    const avg = this.intervals.reduce((a, b) => a + b, 0) / 5,
      cap =
        this.initial() *
        (this.params.catchUp ? 1 + this.params.catchUpFraction : 1);
    return (
      Math.min(avg, cap) / Math.max(Math.trunc(this.pending.length / 2), 1)
    );
  }
  enqueue(animations, nowSeconds, { predictionDuration } = {}) {
    if (this.params.catchUp)
      this.catchUpTime = Math.max(
        0,
        this.nextAt - nowSeconds + this.baseDuration() * this.pending.length,
      );
    this.pending.push({
      animations: [...animations].sort((a, b) => a.start - b.start),
      predictionDuration,
    });
    this.paused = false;
    if (this.lastArrival !== 0)
      this.intervals[this.counter % 5] = nowSeconds - this.lastArrival;
    this.lastArrival = nowSeconds;
    this.counter++;
  }
  tick(nowSeconds) {
    if (this.paused || nowSeconds <= this.nextAt) return [];
    if (!this.current.length && this.pending.length) {
      const group = this.pending[0];
      this.duration = group.predictionDuration ?? this.baseDuration();
      if (group.predictionDuration == null && this.params.catchUp) {
        this.duration = Math.max(
          this.params.minSeconds,
          this.duration - this.params.catchUpFraction * this.catchUpTime,
        );
        this.catchUpTime = 0;
      }
      this.current = this.pending.shift().animations;
    }
    if (!this.current.length) {
      this.paused = true;
      return [];
    }
    const start = this.current[0].start,
      events = [];
    while (this.current.length && this.current[0].start === start) {
      const relative = this.current.shift();
      events.push({ ...relative, duration: relative.duration * this.duration });
    }
    this.nextAt =
      nowSeconds + ((this.current[0]?.start ?? 1) - start) * this.duration;
    return events;
  }
  clear() {
    this.pending = [];
    this.current = [];
    this.paused = true;
  }
}
/** TripMapVehicleMapLayerInteractor.Eu: caller replaces sampler queue for each emitted batch. */
export function vehicleBatchPath(events, nowMs) {
  let epoch = nowMs;
  const out = [];
  for (const e of events)
    if (e.kind === 'vehicle') {
      epoch += e.duration * 1000;
      out.push({ ...e.entity, epoch });
    }
  return out;
}

/** WaypointRoute.g + jub.c.invoke case0 + kp7.h: retain overlapping travelled prefix. */
const nativeApprox = (a, b) => a === b || Math.abs(a - b) < 1.192093e-7;
const nativePointApprox = (a, b) =>
  (a.type ?? 0) === (b.type ?? 0) &&
  nativeApprox(a.lat, b.lat) &&
  nativeApprox(a.lon, b.lon);
export function overlapEdge(a, b) {
  const slopeA = (a.end.lon - a.start.lon) / (a.end.lat - a.start.lat),
    slopeB = (b.end.lon - b.start.lon) / (b.end.lat - b.start.lat);
  return (
    nativeApprox(slopeA, slopeB) &&
    (nativePointApprox(a.start, b.start) || nativePointApprox(a.end, b.end))
  );
}
function mergeOverlappingRoutes(previous, incoming, currentFirstPoint, geo) {
  for (let i = 0; i < previous.length; i++) {
    const j = incoming.findIndex((e) => overlapEdge(previous[i], e));
    if (j < 0) continue;
    const prefix = positionOnRoute(previous, currentFirstPoint, geo)
      ? previous.slice(0, i + 1)
      : incoming.slice(0, j + 1);
    return [...prefix, ...incoming.slice(Math.min(j + 1, incoming.length))];
  }
  return null;
}
/**
 * DriverLocationRoutelineStream.scan mapper normalized boundary.
 * decodedPoints are original currentRoute decoder points (precision1e-5).
 * vehiclePath is the wire array in wire order. Native currentlocation is FIRST
 * decoded route point, not newest wire path point, when currentRoute exists.
 * Missing/empty route falls back to last path sample represented as zero edge.
 * `detached` is already resolved parameter-enable&&serverDetached (defaultfalse).
 * Return retainedRoute on valid result; invalid failure clears the scan route.
 * Observation receipt/epoch/anomaly metadata omitted here (not used in planner).
 */
export function normalizeNativeRouteObservation(
  previousRoute,
  decodedPoints,
  vehiclePath,
  geo,
  { detached = false } = {},
) {
  const points = [];
  for (const p of decodedPoints ?? [])
    if (
      !points.length ||
      points.at(-1).lat !== p.lat ||
      points.at(-1).lon !== p.lon
    )
      points.push(p);
  if (detached || !points.length) {
    const latest = vehiclePath?.at(-1);
    if (latest?.lat == null || latest?.lon == null)
      return { kind: 'invalid', retainedRoute: null, vehicle: null };
    const location = { lat: latest.lat, lon: latest.lon },
      route = [edge(location, location, geo)],
      agent = { index: 0, fraction: 0, heading: latest.course ?? 0 };
    return {
      kind: 'path-fallback',
      retainedRoute: null,
      vehicle: { route, agent, position: location },
    };
  }
  const route = [];
  for (let i = 0; i < points.length - 1; i++)
    route.push(edge(points[i], points[i + 1], geo));
  if (!route.length && points.length)
    route.push(edge(points[0], points[0], geo));
  const current = points[0],
    merged = previousRoute
      ? mergeOverlappingRoutes(previousRoute, route, current, geo)
      : null;
  let selected = merged ?? route,
    agent = positionOnRoute(selected, current, geo);
  if (!agent && merged) {
    selected = route;
    agent = positionOnRoute(selected, current, geo);
  }
  if (!agent) return { kind: 'invalid', retainedRoute: null, vehicle: null };
  return {
    kind: 'route',
    retainedRoute: selected,
    vehicle: { route: selected, agent, position: pointAt(selected, agent) },
  };
}
