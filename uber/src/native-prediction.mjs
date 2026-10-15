// Static reconstruction of native server-authored prediction playback.
// kub.g.F/a, c66.o.accept, WaypointRoute.a/d in APK com.ubercab 4.651.10003.
import { pointAt } from './native-motion.mjs';

const predictionDebounceMs = 6000;

// WaypointRoute.d: strict ordering, including identical-agent equality=false.
export function agentAhead(a, b) {
  return a.index > b.index || (a.index === b.index && a.fraction > b.fraction);
}

// WaypointRoute.a: distance is meters from the original observation's agent,
// not from the last predicted agent. Exact-boundary advances to the next edge.
export function advanceAgent(route, agent, distance) {
  if (!Number.isFinite(distance))
    throw new TypeError('prediction distance must be finite meters');
  if (distance <= 0 || route.length === 0) return agent;
  let index = agent.index,
    covered = 0;
  while (index < route.length) {
    const e = route[index];
    const fraction = index === agent.index ? agent.fraction : 0;
    const throughEdge = (1 - fraction) * e.length + covered;
    if (throughEdge > distance)
      return {
        index,
        fraction: (distance - covered) / e.length + fraction,
        heading: e.heading ?? agent.heading,
      };
    index++;
    covered = throughEdge;
  }
  return {
    index: route.length - 1,
    fraction: 1,
    heading: route.at(-1).heading ?? agent.heading,
  };
}

function pointEqual(a, b) {
  return a.lat === b.lat && a.lon === b.lon;
}
export function predictionRoutesEqual(a, b) {
  return (
    a === b ||
    (a.length === b.length &&
      a.every((e, i) => {
        const f = b[i];
        return (
          pointEqual(e.start, f.start) &&
          pointEqual(e.end, f.end) &&
          e.length === f.length
        ); // AutoValue_Edge stores no heading; heading is derived.
      }))
  );
}
function validatePredictions(points) {
  if (!Array.isArray(points))
    throw new TypeError('prediction must be an array');
  let previous = -Infinity;
  return points.map((p) => {
    if (!Number.isFinite(p.distanceInMeters))
      throw new TypeError('distanceInMeters must be finite');
    if (!Number.isSafeInteger(p.timestamp))
      throw new TypeError(
        'prediction timestamp must be an exact integer in seconds',
      );
    if (p.timestamp < previous)
      throw new RangeError('prediction timestamps must be nondecreasing');
    previous = p.timestamp;
    return { distanceInMeters: p.distanceInMeters, timestamp: p.timestamp };
  });
}

// Deterministic timer adapter. Caller drives monotonic receipt time in milliseconds.
// advanceTo returns target/duration messages for the existing native motion queue;
// it never estimates speed or creates coordinates absent from server predictions.
export class NativeServerPredictionPlanner {
  constructor({ enabled = true, routesEqual = predictionRoutesEqual } = {}) {
    this.enabled = enabled;
    this.routesEqual = routesEqual;
    this.predictions = [];
    this.pending = null;
    this.active = null;
    this.lastPrediction = null;
    this.clock = -Infinity;
  }
  checkTime(nowMs) {
    if (!Number.isFinite(nowMs) || nowMs < this.clock)
      throw new RangeError(
        'prediction receipt clock must be finite and monotonic',
      );
    this.clock = nowMs;
  }
  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      this.pending = null;
      this.active = null;
    }
    // Native retains its lastPrediction when deactivated.
  }
  observePredictions(points) {
    this.predictions = validatePredictions(points);
  }
  observeRouteline(routeline, receiptMs) {
    this.checkTime(receiptMs);
    // c66.o.accept disposes the current prediction timer on EVERY real update.
    this.active = null;
    this.pending = this.enabled
      ? { routeline, dueMs: receiptMs + predictionDebounceMs }
      : null;
  }
  advanceTo(nowMs) {
    this.checkTime(nowMs);
    const emitted = [];
    if (!this.enabled) return emitted;
    if (this.pending && this.pending.dueMs <= nowMs) {
      const { routeline, dueMs } = this.pending;
      this.pending = null;
      const previous = this.lastPrediction;
      const suppress =
        previous &&
        this.routesEqual(routeline.route, previous.target.route) &&
        agentAhead(previous.target.agent, routeline.agent);
      // withLatestFrom reads current server points at debounce expiry, then the
      // recursive timer captures this list for its entire prediction sequence.
      if (!suppress && this.predictions.length > 1)
        this.active = {
          base: routeline,
          points: this.predictions,
          index: 1,
          dueMs,
        };
    }
    while (this.active && this.active.dueMs <= nowMs) {
      const state = this.active;
      const p = state.points[state.index];
      const previous = state.points[state.index - 1];
      const durationSeconds = p.timestamp - previous.timestamp;
      const agent = advanceAgent(
        state.base.route,
        state.base.agent,
        p.distanceInMeters,
      );
      const target = {
        ...state.base,
        agent,
        position: pointAt(state.base.route, agent),
      };
      const prediction = {
        kind: 'prediction',
        atMs: state.dueMs,
        durationSeconds,
        target,
        source: 'uber-server-prediction',
        predictionIndex: state.index,
      };
      this.lastPrediction = prediction;
      emitted.push(prediction);
      state.index++;
      if (state.index >= state.points.length) this.active = null;
      else state.dueMs += durationSeconds * 1000;
    }
    return emitted;
  }
}
