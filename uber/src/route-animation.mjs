import { nativePathAt } from './native-path-interpolator.mjs';

// Uber Android 4.651.10003 UMDFPolylineNativeAdapter / PolylineViewV2.
// Source: uber/docs/map-parity.md. Active account renderer/style flags remain unverified.
const routePulseProfiles = Object.freeze({
  migrated: Object.freeze({
    periodMs: 2500,
    revealMs: 0,
    delayMs: 0,
    alpha: 178 / 255,
    distanceCurve: [0.4, 0, 0.2, 1],
    colorCurve: [1, 0, 1, 1],
  }),
  legacy: Object.freeze({
    periodMs: 2500,
    revealMs: 1000,
    delayMs: 1000,
    alpha: 1,
    distanceCurve: [0.4, 0, 0.2, 1],
    colorCurve: [0, 0, 1, 1],
  }),
});

export function cubicBezierAt(x, [x1, y1, x2, y2]) {
  if (
    ![x, x1, y1, x2, y2].every(Number.isFinite) ||
    x1 < 0 ||
    x1 > 1 ||
    x2 < 0 ||
    x2 > 1
  )
    throw new Error('Invalid timing curve');
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x1 === y1 && x2 === y2) return x;
  const at = (t, a, b) =>
    3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid, x1, x2) < x) lo = mid;
    else hi = mid;
  }
  return at((lo + hi) / 2, y1, y2);
}

export function routePulseAt(elapsedMs, profile = 'migrated') {
  const p = routePulseProfiles[profile];
  if (!p || !Number.isFinite(elapsedMs))
    throw new Error('Invalid native pulse profile or time');
  const elapsed = Math.max(0, elapsedMs);
  const distanceAt = (x) =>
    profile === 'legacy' ? nativePathAt(x) : cubicBezierAt(x, p.distanceCurve);
  const baseEnd = p.revealMs
    ? distanceAt(Math.min(1, elapsed / p.revealMs))
    : 1;
  if (elapsed < p.delayMs) return { baseEnd, divider: 0, alpha: 0 };
  const t = ((elapsed - p.delayMs) % p.periodMs) / p.periodMs;
  // Legacy ObjectAnimator.ofInt(255, 0), LinearInterpolator, IntEvaluator.
  // Java evaluates the multiply and addition as float, then truncates to int.
  const alpha =
    profile === 'legacy'
      ? Math.trunc(Math.fround(255 + Math.fround(Math.fround(t) * -255))) / 255
      : p.alpha * (1 - cubicBezierAt(t, p.colorCurve));
  return {
    baseEnd,
    divider: distanceAt(t),
    alpha,
  };
}

// MapLibre line-progress is a rendering adapter. Its edge rasterizer is not
// Uber's native quartic fragment shader; that pixel-parity gap remains explicit.
export function pulseGradient(frame, { night = false } = {}) {
  const rgb = night ? '0,0,0' : '255,255,255';
  const clear = `rgba(${rgb},0)`;
  if (frame.divider <= 0 || frame.alpha <= 0)
    return ['interpolate', ['linear'], ['line-progress'], 0, clear, 1, clear];
  const color = `rgba(${rgb},${frame.alpha})`;
  if (frame.divider >= 1)
    return ['interpolate', ['linear'], ['line-progress'], 0, color, 1, color];
  const end = Math.min(1 - 1e-6, Math.max(1e-6, frame.divider));
  const gradient = [
    'interpolate',
    ['linear'],
    ['line-progress'],
    0,
    color,
    end,
    color,
    end + 1e-6,
    clear,
  ];
  if (end + 1e-6 < 1) gradient.push(1, clear);
  return gradient;
}

export function routeBaseGradient(frame, { night = false } = {}) {
  // Legacy route reveal uses the same distance interpolator. Subsequent
  // highlights remain a separate inverse-color layer over this solid base.
  const rgb = night ? '222,222,222' : '0,0,0';
  const solid = `rgba(${rgb},1)`,
    clear = `rgba(${rgb},0)`;
  if (frame.baseEnd >= 1)
    return ['interpolate', ['linear'], ['line-progress'], 0, solid, 1, solid];
  if (frame.baseEnd <= 0)
    return ['interpolate', ['linear'], ['line-progress'], 0, clear, 1, clear];
  const end = Math.min(1 - 1e-6, Math.max(1e-6, frame.baseEnd));
  const gradient = [
    'interpolate',
    ['linear'],
    ['line-progress'],
    0,
    solid,
    end,
    solid,
    end + 1e-6,
    clear,
  ];
  if (end + 1e-6 < 1) gradient.push(1, clear);
  return gradient;
}
