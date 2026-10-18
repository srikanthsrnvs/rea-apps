export const trackingText = (value) =>
  typeof value === 'string' ? value.trim().slice(0, 2000) : '';

export function replayNotice(scene) {
  if (scene?.state !== 'replay') return null;
  return (
    trackingText(scene.replay?.label) ||
    (scene.kind === 'eats'
      ? 'Recorded delivery · no active order'
      : scene.kind === 'ride'
        ? 'Recorded ride · no active booking'
        : trackingText(scene.status))
  );
}

export function trackingImageUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (url.hostname === 'uber.com' ||
        url.hostname.endsWith('.uber.com') ||
        [
          'd1a3f4spazzrp4.cloudfront.net',
          'd1w2poirtb3as9.cloudfront.net',
        ].includes(url.hostname))
    )
      return url.href;
  } catch {
    /* A missing image must not prevent tracking. */
  }
  return null;
}

export function trackingMapPadding({ width, height, panelWidth, panelHeight }) {
  if (height <= 500 && width >= 600)
    return {
      top: 24,
      right: 24,
      bottom: 24,
      left: Math.min(panelWidth + 40, width - 120),
    };
  return {
    top: Math.min(64, height * 0.15),
    right: 24,
    bottom: Math.max(24, Math.min(panelHeight + 40, height - 120)),
    left: 24,
  };
}

export function panelElements(doc) {
  const element = (tag, className, value) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (value) node.textContent = value;
    return node;
  };
  return {
    element,
    status({ title, eta, detail, etaDetail }) {
      const heading = element('div', 'delivery-heading');
      heading.append(element('h1', 'delivery-title', title));
      if (eta) heading.append(element('p', 'delivery-eta', eta));
      const status = element('div', 'delivery-live');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.setAttribute('aria-atomic', 'true');
      status.append(heading);
      if (etaDetail)
        status.append(element('p', 'delivery-secondary', etaDetail));
      if (detail) status.append(element('p', 'delivery-detail', detail));
      return status;
    },
    profile({ name, photoUrl, details = [] }) {
      const profile = element('div', 'delivery-courier');
      const url = trackingImageUrl(photoUrl);
      if (url) {
        const photo = element('img', 'delivery-courier-photo');
        photo.alt = '';
        photo.referrerPolicy = 'no-referrer';
        photo.onerror = () => {
          photo.hidden = true;
        };
        photo.src = url;
        profile.append(photo);
      }
      const content = element('div', 'tracking-profile-detail');
      if (name) content.append(element('p', 'delivery-courier-name', name));
      for (const value of details)
        if (value) content.append(element('p', 'delivery-secondary', value));
      profile.append(content);
      return profile;
    },
  };
}

const bridgeKinds = {
  eats: {
    namespace: 'uber-eats',
    detail: 'delivery',
    events: 'deliveryEvents',
    event: 'delivery',
  },
  ride: {
    namespace: 'uber-ride',
    detail: 'ride',
    events: 'rideEvents',
    event: 'ride',
  },
};

// One authenticated child viewer can serve either application. The parent must
// match the explicit embedding policy and initiate a namespace-specific handshake.
export function createTrackingBridge({ window: win, frameOrigins = [], kind }) {
  let origins = new Set(),
    subscriber = null,
    latest = null,
    identity = null,
    closed = false;
  const eventIds = new Set();
  function send(packet, origin = subscriber?.origin) {
    if (!origin || closed) return;
    try {
      win.parent.postMessage(packet, origin);
    } catch {
      subscriber = null;
    }
  }
  function unavailable() {
    if (subscriber)
      send({ type: `${bridgeKinds[subscriber.kind].namespace}:unavailable` });
  }
  function configure(values) {
    origins = new Set(
      (Array.isArray(values) ? values : []).slice(0, 32).filter((value) => {
        try {
          const url = new URL(value);
          return (
            ['https:', 'http:'].includes(url.protocol) && url.origin === value
          );
        } catch {
          return false;
        }
      }),
    );
    if (subscriber && !origins.has(subscriber.origin)) {
      unavailable();
      subscriber = null;
    }
  }
  function clear() {
    unavailable();
    subscriber = latest = identity = null;
    eventIds.clear();
  }
  function receive(event) {
    if (
      closed ||
      win.parent === win ||
      event.source !== win.parent ||
      !origins.has(event.origin)
    )
      return;
    for (const [requestedKind, config] of Object.entries(bridgeKinds)) {
      if (kind && kind !== requestedKind) continue;
      if (event.data?.type === `${config.namespace}:subscribe`) {
        if (latest && latest.kind !== requestedKind) return;
        subscriber = { origin: event.origin, kind: requestedKind };
        if (latest)
          send({ type: `${config.namespace}:snapshot`, scene: latest });
        return;
      }
      if (
        event.data?.type === `${config.namespace}:unsubscribe` &&
        subscriber?.origin === event.origin &&
        subscriber?.kind === requestedKind
      ) {
        subscriber = null;
        return;
      }
    }
  }
  configure(frameOrigins);
  win.addEventListener('message', receive);
  return {
    update(scene, nextOrigins) {
      if (closed) return;
      if (nextOrigins !== undefined) configure(nextOrigins);
      const config = bridgeKinds[scene?.kind];
      if (!config || (kind && kind !== scene.kind) || !scene[config.detail]) {
        clear();
        return;
      }
      const first = latest === null || latest.kind !== scene.kind;
      if (subscriber && subscriber.kind !== scene.kind) {
        unavailable();
        subscriber = null;
      }
      // Copy only the closed scene, never the response, fragment or configuration.
      latest = structuredClone(scene);
      if (first && win.parent !== win)
        for (const origin of origins)
          send({ type: `${config.namespace}:ready` }, origin);
      if (first && subscriber)
        send({ type: `${config.namespace}:snapshot`, scene: latest });
      const nextIdentity = `${scene.kind}:${scene.kind === 'eats' ? scene.delivery.workflowId || scene.delivery.orderId : scene.ride.tripId || scene.tripId}`;
      if (identity !== nextIdentity) eventIds.clear();
      identity = nextIdentity;
      for (const event of (Array.isArray(latest[config.events])
        ? latest[config.events]
        : []
      ).slice(-1000)) {
        if (typeof event?.id !== 'string' || eventIds.has(event.id)) continue;
        eventIds.add(event.id);
        if (eventIds.size > 1000)
          eventIds.delete(eventIds.values().next().value);
        send({ type: `${config.namespace}:${config.event}`, event });
      }
    },
    close() {
      if (closed) return;
      clear();
      origins.clear();
      closed = true;
      win.removeEventListener('message', receive);
    },
  };
}
