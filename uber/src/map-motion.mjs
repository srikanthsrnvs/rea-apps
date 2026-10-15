import {
  NativeServerPredictionPlanner,
  agentAhead,
  predictionRoutesEqual,
} from './native-prediction.mjs';
import { nativeGeodesy as geo } from './native-geodesy.mjs';
import {
  NativeFrameSampler,
  NativeRoutePlanner,
  NativeTimingQueue,
  normalizeNativeRouteObservation,
  vehicleBatchPath,
  projectSegment,
} from './native-motion.mjs';

// Native lub.a.e: nearest lat/lon segment projection, Android distance ranking.
// Trimming follows the animated point, not the most recent network snapshot.
export function trimRouteAt(points, position) {
  if (!position || points.length < 2) return points;
  let best = null,
    distance = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const projection = projectSegment(points[i], points[i + 1], position);
    const d = geo.distance(position, projection);
    if (d < distance) {
      best = { projection, index: i };
      distance = d;
    }
  }
  return best ? [best.projection, ...points.slice(best.index + 1)] : points;
}

const valid = (p) =>
  Number.isFinite(p?.lat) &&
  Number.isFinite(p?.lon) &&
  Math.abs(p.lat) <= 90 &&
  Math.abs(p.lon) <= 180;

/** Browser adapter for the reconstructed native motion pipeline.
 * Recommendations are not the native currentRoute stream: they may animate
 * road-following only when their first point agrees with real GPS within 10m.
 * Otherwise retain the observed position and use native path-fallback motion.
 * Bounds are adapter resource limits, not claimed native application constants.
 */
export class MapMotion {
  constructor() {
    this.reset();
  }

  reset() {
    this.planner = new NativeRoutePlanner(geo);
    this.predictions = new NativeServerPredictionPlanner();
    this.lastPrediction = null;
    this.queue = new NativeTimingQueue();
    this.sampler = new NativeFrameSampler();
    this.retainedRoute = null;
    this.observation = null;
    this.position = null;
    this.mode = null;
    this.route = null;
  }

  update(scene, nowMs) {
    const position = scene.driver?.position;
    if (
      !valid(position) ||
      !['active', 'dispatching', 'replay'].includes(scene.state)
    ) {
      this.reset();
      return;
    }
    const route = scene.routes?.find((r) =>
      ['provider', 'provider_recommended'].includes(r.kind),
    );
    this.predictions.observePredictions(scene.driver?.prediction ?? []);
    const identity = `${scene.driver?.streamSequence ?? ''}:${scene.tripId}:${scene.status}:${position.epoch}:${position.lat}:${position.lon}:${position.course}:${route?.encodedPolyline ?? ''}`;
    if (identity === this.observation) return;
    const points =
      route?.points?.length <= 2000 && route.points.every(valid)
        ? route.points
        : [];
    const recommendation =
      route?.source === 'uber_routing_recommendation' ||
      route?.kind === 'provider_recommended';
    const canUseRoute =
      points.length &&
      (!recommendation || geo.distance(points[0], position) <= 10);
    // Retained native geometry can grow as a trip progresses; cap it explicitly.
    if (
      (this.retainedRoute?.length ?? 0) > 4000 ||
      this.queue.pending.length >= 32
    )
      this.reset();
    const observation = normalizeNativeRouteObservation(
      this.retainedRoute,
      canUseRoute ? points : [],
      [position],
      geo,
    );
    this.observation = identity;
    this.retainedRoute = observation.retainedRoute;
    this.route = route;
    if (!observation.vehicle) return;
    // The initial marker appears immediately; later updates follow the native
    // queued timeline and freeze at its end. No dead reckoning past real data.
    if (!this.position) {
      this.position = {
        ...observation.vehicle.position,
        course: position.course ?? observation.vehicle.agent.heading ?? 0,
        epoch: nowMs,
      };
      this.sampler.previous = this.position;
    }
    this.predictions.observeRouteline(observation.vehicle, nowMs);
    if (
      this.lastPrediction &&
      predictionRoutesEqual(
        this.lastPrediction.target.route,
        observation.vehicle.route,
      ) &&
      agentAhead(this.lastPrediction.target.agent, observation.vehicle.agent)
    )
      return;
    const plan = this.planner.plan(observation.vehicle);
    this.mode = plan.mode;
    this.queue.enqueue(plan.animations, nowMs / 1000);
  }

  frame(nowMs) {
    for (const prediction of this.predictions.advanceTo(nowMs)) {
      const plan = this.planner.plan(prediction.target);
      this.queue.enqueue(plan.animations, prediction.atMs / 1000, {
        predictionDuration: prediction.durationSeconds,
      });
      this.lastPrediction = prediction;
    }
    const events = this.queue.tick(nowMs / 1000);
    const path = vehicleBatchPath(events, nowMs);
    if (path.length) this.sampler.replace(path);
    this.position = this.sampler.sample(nowMs) ?? this.position;
    return this.position;
  }

  routePoints(route) {
    if (route !== this.route || !this.retainedRoute?.length)
      return route.points;
    return [
      ...this.retainedRoute.map((edge) => edge.start),
      this.retainedRoute.at(-1).end,
    ];
  }
}
