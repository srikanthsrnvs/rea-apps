import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import * as state from './state.mjs';

export async function mapSessionGuard(store = state) {
  const owner = await store.withStateLock(async () => {
    const session = await store.readState('session');
    if (!session?.userUUID || !session.accessToken)
      throw new Error('A logged-in rider session is required; run uber login');
    if (!session.mapViewerGeneration) {
      session.mapViewerGeneration = randomBytes(24).toString('base64url');
      await store.saveState('session', session);
    }
    return {
      userUUID: session.userUUID,
      generation: session.mapViewerGeneration,
    };
  });
  return async () => {
    const current = await store.readState('session');
    return (
      current?.userUUID === owner.userUUID &&
      current.mapViewerGeneration === owner.generation
    );
  };
}

const directory = new URL('./map-web/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/viewer.mjs', ['viewer.mjs', 'text/javascript; charset=utf-8']],
  ['/viewer.css', ['viewer.css', 'text/css; charset=utf-8']],
  ['/delivery.mjs', ['delivery.mjs', 'text/javascript; charset=utf-8']],
  ['/ride.mjs', ['ride.mjs', 'text/javascript; charset=utf-8']],
  [
    '/tracking-panel.mjs',
    ['tracking-panel.mjs', 'text/javascript; charset=utf-8'],
  ],
  [
    '/live-stream.mjs',
    [new URL('./live-stream.mjs', directory), 'text/javascript; charset=utf-8'],
  ],
  [
    '/waypoint.mjs',
    [new URL('./waypoint.mjs', directory), 'text/javascript; charset=utf-8'],
  ],
  [
    '/map-style.mjs',
    [
      new URL('./map-style.mjs', import.meta.url),
      'text/javascript; charset=utf-8',
    ],
  ],
  [
    '/map-motion.mjs',
    [
      new URL('./map-motion.mjs', import.meta.url),
      'text/javascript; charset=utf-8',
    ],
  ],
  [
    '/native-path-interpolator.mjs',
    [
      new URL('./native-path-interpolator.mjs', import.meta.url),
      'text/javascript; charset=utf-8',
    ],
  ],
  [
    '/native-prediction.mjs',
    [
      new URL('./native-prediction.mjs', import.meta.url),
      'text/javascript; charset=utf-8',
    ],
  ],
  [
    '/native-motion.mjs',
    [
      new URL('./native-motion.mjs', import.meta.url),
      'text/javascript; charset=utf-8',
    ],
  ],
  [
    '/native-geodesy.mjs',
    [
      new URL('./native-geodesy.mjs', import.meta.url),
      'text/javascript; charset=utf-8',
    ],
  ],
  [
    '/route-animation.mjs',
    [
      new URL('./route-animation.mjs', import.meta.url),
      'text/javascript; charset=utf-8',
    ],
  ],
  [
    '/vehicle-style.mjs',
    [
      new URL('./map-vehicle-style.mjs', import.meta.url),
      'text/javascript; charset=utf-8',
    ],
  ],
]);

export function mapServerOptions({
  host = '127.0.0.1',
  port = 0,
  publicUrl,
  frameOrigins = [],
  durationSeconds = 3600,
} = {}) {
  if (typeof host !== 'string' || !host || /[\s/?#@]/.test(host))
    throw new Error('Invalid map listening host');
  port = Number(port);
  durationSeconds = Number(durationSeconds);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Map port must be between 0 and 65535');
  if (
    !Number.isInteger(durationSeconds) ||
    durationSeconds < 10 ||
    durationSeconds > 86400
  )
    throw new Error('Map duration must be between 10 and 86400 seconds');
  let base = null;
  if (publicUrl !== undefined) {
    base = new URL(publicUrl);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error(
        'Map public URL must be an HTTP(S) origin or proxy path without credentials, query or fragment',
      );
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  }
  if (!base && !['127.0.0.1', 'localhost', '::1'].includes(host))
    throw new Error('--public-url is required when listening outside loopback');
  if (!Array.isArray(frameOrigins))
    throw new Error('Frame origins must be a list');
  const origins = frameOrigins.map((value) => {
    const origin = new URL(value);
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.href !== `${origin.origin}/`
    )
      throw new Error('Frame origin must be an exact HTTP(S) origin');
    return origin.origin;
  });
  return { host, port, base, origins, durationSeconds };
}

/** An expiring read-only viewer lease. No Uber credentials enter its responses. */
export async function startMapServer(
  options = {},
  {
    getScene,
    now = Date.now,
    isAuthorized = async () => true,
    subscribeToScenes,
    onClose = () => {},
    fidelity: fidelityOverrides = {},
  } = {},
) {
  const config = mapServerOptions(options);
  if (typeof getScene !== 'function')
    throw new Error('A map scene reader is required');
  const key = randomBytes(32).toString('base64url');
  const credential = Buffer.from(`Bearer ${key}`);
  const expiresAt = now() + config.durationSeconds * 1000;
  let cached = null,
    nextReadAt = 0,
    pending = null,
    closed = false,
    readFailed = false,
    revoked = false;
  const peers = new Set();
  const trackingCursors = new WeakMap();
  let eventTimer = null,
    eventRead = false,
    unsubscribe = null,
    pushQueue = Promise.resolve();
  const fidelity = {
    experimental: true,
    nativeRenderer: false,
    pixelParityVerified: false,
    updates: subscribeToScenes
      ? 'ramen_push_with_status_fallback'
      : 'status_snapshot_polling',
    ...fidelityOverrides,
  };
  const packet = (value) => ({
    scene: value,
    expiresAt: new Date(expiresAt).toISOString(),
    fidelity,
    viewer: { frameOrigins: config.origins },
  });
  function trackingEvents(peer, value) {
    let cursor = trackingCursors.get(peer) ?? 0;
    for (const event of value.kind === 'eats'
      ? (value.deliveryEvents ?? [])
      : value.kind === 'ride'
        ? (value.rideEvents ?? [])
        : []) {
      if (event.sequence <= cursor) continue;
      if (
        !peer.write(
          `id: ${event.id}\nevent: ${value.kind === 'ride' ? 'ride' : 'delivery'}\ndata: ${JSON.stringify(event)}\n\n`,
        )
      ) {
        peer.destroy();
        break;
      }
      cursor = event.sequence;
    }
    trackingCursors.set(peer, cursor);
  }
  function broadcast(value) {
    const event = `event: scene\ndata: ${JSON.stringify(packet(value))}\n\n`;
    for (const peer of peers) {
      if (!peer.write(event)) peer.destroy();
      else trackingEvents(peer, value);
    }
  }
  function revokePeers(event = 'revoked') {
    revoked = true;
    cached = null;
    for (const peer of peers) peer.end(`event: ${event}\ndata: {}\n\n`);
    peers.clear();
    clearInterval(eventTimer);
    eventTimer = null;
  }
  const paths = new Map();
  for (const [name, [file, type]] of assets) {
    paths.set(name, {
      body: await fs.readFile(
        file instanceof URL ? file : new URL(file, directory),
      ),
      type,
    });
  }
  async function scene() {
    if (cached?.state === 'ended') return cached;
    if (pending) return pending;
    if (cached && now() < nextReadAt) {
      if (readFailed) throw new Error('Trip refresh failed');
      return cached;
    }
    if (!pending)
      pending = (async () => {
        // Back off on read failures too; multiple viewers never cause request storms.
        nextReadAt = now() + Math.max(8000, cached?.pollingIntervalMs ?? 8000);
        let value;
        try {
          value = await getScene();
          readFailed = false;
        } catch (error) {
          readFailed = true;
          throw error;
        }
        if (cached?.state === 'ended' && value.state !== 'ended')
          value = cached;
        cached = value;
        nextReadAt =
          now() +
          Math.max(8000, Math.min(3600000, value.pollingIntervalMs ?? 8000));
        return value;
      })().finally(() => {
        pending = null;
      });
    return pending;
  }
  // Fail before advertising a URL when login or response shape is unusable.
  const initial = await scene();
  if (!(await isAuthorized()))
    throw new Error('Map session is no longer available');
  const points = [
    ...(initial.waypoints ?? []),
    ...(initial.driver?.position ? [initial.driver.position] : []),
    ...(initial.routes ?? []).flatMap((route) => route.points ?? []),
  ];
  const hasCoordinates = points.some(
    (point) =>
      Number.isFinite(point?.lat) &&
      Math.abs(point.lat) <= 90 &&
      Number.isFinite(point?.lon) &&
      Math.abs(point.lon) <= 180,
  );
  if (initial.state !== 'idle' && !hasCoordinates) {
    const error = new Error(
      'No usable trip coordinates are available. Map link was not created.',
    );
    error.code = 'MAP_GEOMETRY_UNAVAILABLE';
    throw error;
  }
  const prefix = config.base?.pathname.replace(/\/$/, '') ?? '';
  const frameAncestors = config.origins.length
    ? ["'self'", ...config.origins].join(' ')
    : '*';
  const csp = `default-src 'none'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; connect-src 'self' https://tc2.uber.com https://unpkg.com; img-src 'self' data: blob: https://*.uber.com https://d1a3f4spazzrp4.cloudfront.net https://duyt4h9nfnj50.cloudfront.net https://d1w2poirtb3as9.cloudfront.net; worker-src blob: https://unpkg.com; font-src 'self' https://tb-static.uber.com; base-uri 'none'; form-action 'none'; frame-ancestors ${frameAncestors}`;
  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy': csp,
      });
      res.end(
        typeof body === 'string' || Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body),
      );
    };
    try {
      if (now() >= expiresAt || closed)
        return send(410, { error: 'Map viewer expired' });
      if (req.method !== 'GET')
        return send(405, { error: 'Only read requests are supported' });
      const url = new URL(req.url, 'http://localhost');
      if (url.search || (prefix && !url.pathname.startsWith(`${prefix}/`)))
        return send(404, { error: 'Not found' });
      const route = url.pathname.slice(prefix.length);
      if (route === '/state' || route === '/events') {
        const supplied = Buffer.from(req.headers.authorization ?? '');
        if (
          supplied.length !== credential.length ||
          !timingSafeEqual(supplied, credential)
        )
          return send(401, { error: 'A valid viewer key is required' });
        if (revoked || !(await isAuthorized())) {
          revokePeers();
          return send(410, { error: 'Map session is no longer available' });
        }
        // Browsers cannot read another origin's scene, even with a guessed header.
        if (
          req.headers.origin &&
          req.headers.origin !== config.base?.origin &&
          req.headers.origin !== boundOrigin
        )
          return send(403, {
            error: 'Cross-origin scene requests are not supported',
          });
        if (route === '/events') {
          let initial;
          try {
            initial = await scene();
          } catch {
            return send(503, { error: 'Trip refresh failed' });
          }
          if (
            revoked ||
            closed ||
            now() >= expiresAt ||
            !(await isAuthorized())
          )
            return send(410, { error: 'Map session is no longer available' });
          let resume = 0,
            gap = null;
          if (
            ['eats', 'ride'].includes(initial.kind) &&
            req.headers['last-event-id'] !== undefined
          ) {
            const match = /^([a-f\d-]{36}):([0-9]+)$/i.exec(
              req.headers['last-event-id'],
            );
            if (
              !match ||
              match[1].toLowerCase() !== initial.tripId?.toLowerCase() ||
              !Number.isSafeInteger(Number(match[2]))
            )
              return send(400, {
                error: 'Invalid tracking event cursor for this trip',
              });
            resume = Number(match[2]);
            if (resume > (initial.eventCursor ?? 0))
              return send(409, {
                error: 'Tracking event cursor is ahead of this trip',
              });
            const oldest = (
              initial.kind === 'ride'
                ? initial.rideEvents
                : initial.deliveryEvents
            )?.[0]?.sequence;
            if (oldest && resume < oldest - 1)
              gap = { after: resume, oldestAvailable: oldest };
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
            'x-accel-buffering': 'no',
            'content-security-policy': csp,
          });
          res.write(
            `event: scene\ndata: ${JSON.stringify(packet(initial))}\n\n`,
          );
          trackingCursors.set(res, resume);
          if (gap) res.write(`event: gap\ndata: ${JSON.stringify(gap)}\n\n`);
          trackingEvents(res, initial);
          peers.add(res);
          res.once('close', () => {
            peers.delete(res);
            if (!peers.size) {
              clearInterval(eventTimer);
              eventTimer = null;
            }
          });
          if (!eventTimer)
            eventTimer = setInterval(async () => {
              if (eventRead || closed) return;
              eventRead = true;
              try {
                if (now() >= expiresAt || !(await isAuthorized())) {
                  revokePeers();
                  return;
                }
                const value = await scene();
                if (
                  closed ||
                  revoked ||
                  now() >= expiresAt ||
                  !(await isAuthorized())
                ) {
                  revokePeers();
                  return;
                }
                broadcast(value);
              } catch {
                for (const peer of peers)
                  peer.write('event: refresh-error\ndata: {}\n\n');
              } finally {
                eventRead = false;
              }
            }, 8000);
          eventTimer?.unref();
          return;
        }
        try {
          const value = await scene();
          if (
            closed ||
            revoked ||
            now() >= expiresAt ||
            !(await isAuthorized())
          ) {
            revokePeers();
            return send(410, { error: 'Map session is no longer available' });
          }
          return send(200, packet(value));
        } catch {
          return send(503, {
            error: 'Trip refresh failed; no new location is available',
            retryAfterMs: 8000,
          });
        }
      }
      const asset = paths.get(route);
      if (!asset) return send(404, { error: 'Not found' });
      return send(200, asset.body, asset.type);
    } catch {
      if (!res.headersSent) send(400, { error: 'Invalid viewer request' });
      else res.destroy();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  const boundOrigin = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${address.port}`;
  const base = config.base ?? new URL(`${boundOrigin}/`);
  const mapUrl = `${base.href}#key=${key}`;
  if (subscribeToScenes)
    unsubscribe = subscribeToScenes((value) => {
      pushQueue = pushQueue
        .then(async () => {
          if (closed || revoked || now() >= expiresAt) return;
          if (!(await isAuthorized())) {
            revokePeers();
            return;
          }
          if (cached?.tripId && value.tripId !== cached.tripId) return;
          if (cached?.state === 'ended' && value.state !== 'ended') return;
          cached = value;
          readFailed = false;
          broadcast(value);
        })
        .catch(() => revokePeers());
    });
  let expiryTimer;
  async function close() {
    if (closed) return;
    closed = true;
    clearTimeout(expiryTimer);
    clearInterval(eventTimer);
    try {
      unsubscribe?.();
    } catch {
      /* Continue closing the lease. */
    }
    try {
      onClose();
    } catch {
      /* Continue closing the lease. */
    }
    for (const peer of peers) peer.end('event: expired\ndata: {}\n\n');
    peers.clear();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections();
    });
    cached = null;
  }
  expiryTimer = setTimeout(() => {
    close().catch(() => {});
  }, config.durationSeconds * 1000);
  expiryTimer.unref();
  return {
    server,
    close,
    mapUrl,
    expiresAt: new Date(expiresAt).toISOString(),
    listening: { host: config.host, port: address.port },
    tripId: cached.tripId ?? null,
    state: cached.state,
    fidelity,
  };
}
