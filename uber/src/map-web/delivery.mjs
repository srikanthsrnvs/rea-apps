const text = (value) =>
  typeof value === 'string' ? value.trim().slice(0, 2000) : '';

// Retain native status text and counts. Missing estimates remain missing rather
// than turning a polling interval into a promised delivery time.
export function deliveryPresentation(scene) {
  if (scene?.kind !== 'eats' || !scene.delivery) return null;
  const delivery = scene.delivery;
  const total = Number.isInteger(delivery.progress?.total)
    ? Math.max(0, Math.min(20, delivery.progress.total))
    : 0;
  const current = Number.isInteger(delivery.progress?.current)
    ? Math.max(0, Math.min(total, delivery.progress.current))
    : 0;
  const color = text(delivery.progress?.color);
  return {
    orderId: text(delivery.orderId),
    workflowId: text(delivery.workflowId),
    storeName: text(delivery.storeName),
    displayId: text(delivery.displayId),
    stage: text(delivery.stage),
    title: text(delivery.statusTitle),
    detail: text(delivery.statusDetail),
    eta: text(delivery.eta?.display),
    etaDetail: text(delivery.eta?.detail),
    delay: text(delivery.delay?.message),
    progress: {
      total,
      current,
      animated:
        delivery.progress?.animated === true && scene.state === 'active',
      color: /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color) ? color : null,
    },
    courier: delivery.courier
      ? {
          name: text(delivery.courier.name),
          description: text(delivery.courier.description),
          vehicleDescription: text(delivery.courier.vehicleDescription),
          photoUrl: imageUrl(delivery.courier.photoUrl),
        }
      : null,
    items: (Array.isArray(delivery.items) ? delivery.items : [])
      .slice(0, 100)
      .map((item) => ({
        title: text(item.title),
        quantity:
          Number.isInteger(item.quantity) && item.quantity > 0
            ? item.quantity
            : null,
      }))
      .filter((item) => item.title),
    total: text(delivery.total?.formatted) || text(delivery.total),
    address: text(delivery.dropoff?.address),
    instructions: text(delivery.dropoff?.instructions),
  };
}

export function deliveryMapPadding({ width, height, panelWidth, panelHeight }) {
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

function imageUrl(value) {
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
    /* An absent image must not prevent order tracking. */
  }
  return null;
}

// The viewer key stays in the child. A parent must both match the server's
// explicit embedding policy and initiate the handshake before receiving data.
export function createDeliveryBridge({ window: win, frameOrigins = [] }) {
  let origins = new Set();
  let subscriber = null;
  let latest = null;
  let identity = null;
  let closed = false;
  const eventIds = new Set();
  function send(packet, origin = subscriber) {
    if (!origin || closed) return;
    try {
      win.parent.postMessage(packet, origin);
    } catch {
      // A parent can navigate or close between the handshake and an update.
      subscriber = null;
    }
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
    if (subscriber && !origins.has(subscriber)) {
      send({ type: 'uber-eats:unavailable' });
      subscriber = null;
    }
  }
  function clear() {
    send({ type: 'uber-eats:unavailable' });
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
    if (event.data?.type === 'uber-eats:subscribe') {
      subscriber = event.origin;
      if (latest) send({ type: 'uber-eats:snapshot', scene: latest });
    } else if (
      event.data?.type === 'uber-eats:unsubscribe' &&
      subscriber === event.origin
    ) {
      subscriber = null;
    }
  }
  configure(frameOrigins);
  win.addEventListener('message', receive);
  return {
    update(scene, nextOrigins) {
      if (closed) return;
      if (nextOrigins !== undefined) configure(nextOrigins);
      if (scene?.kind !== 'eats' || !scene.delivery) {
        clear();
        return;
      }
      // The server provides a closed public scene. Copy only that value, never
      // the enclosing response, viewer configuration, location or fragment.
      const first = latest === null;
      latest = structuredClone(scene);
      if (first && win.parent !== win)
        for (const origin of origins) send({ type: 'uber-eats:ready' }, origin);
      if (first) send({ type: 'uber-eats:snapshot', scene: latest });
      const nextIdentity = scene.delivery.workflowId || scene.delivery.orderId;
      if (identity !== nextIdentity) eventIds.clear();
      identity = nextIdentity;
      for (const event of (Array.isArray(latest.deliveryEvents)
        ? latest.deliveryEvents
        : []
      ).slice(-1000)) {
        if (typeof event?.id !== 'string' || eventIds.has(event.id)) continue;
        eventIds.add(event.id);
        if (eventIds.size > 1000)
          eventIds.delete(eventIds.values().next().value);
        send({ type: 'uber-eats:delivery', event });
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

export function createDeliveryView(
  container,
  { document: doc = container.ownerDocument } = {},
) {
  let identity = null;
  let stage = null;
  let rendered = null;
  const eventIds = new Set();
  const element = (tag, className, value) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (value) node.textContent = value;
    return node;
  };
  return {
    render(scene) {
      const view = deliveryPresentation(scene);
      container.hidden = !view;
      if (!view) {
        container.replaceChildren();
        identity = stage = rendered = null;
        eventIds.clear();
        return;
      }
      const nextIdentity = view.workflowId || view.orderId;
      if (identity !== nextIdentity) eventIds.clear();
      const CustomEvent = doc.defaultView?.CustomEvent;
      for (const event of (Array.isArray(scene.deliveryEvents)
        ? scene.deliveryEvents
        : []
      ).slice(-1000)) {
        if (typeof event?.id !== 'string' || eventIds.has(event.id)) continue;
        eventIds.add(event.id);
        if (eventIds.size > 1000)
          eventIds.delete(eventIds.values().next().value);
        if (CustomEvent)
          container.dispatchEvent(
            new CustomEvent('deliveryevent', {
              bubbles: true,
              detail: event,
            }),
          );
      }
      const signature = JSON.stringify(view);
      if (signature === rendered) return;
      rendered = signature;
      container.dataset.stage = view.stage;
      const heading = element('div', 'delivery-heading');
      heading.append(
        element('h1', 'delivery-title', view.title || view.storeName),
      );
      if (view.eta) heading.append(element('p', 'delivery-eta', view.eta));
      const status = element('div', 'delivery-live');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.setAttribute('aria-atomic', 'true');
      status.append(heading);
      if (view.etaDetail)
        status.append(element('p', 'delivery-secondary', view.etaDetail));
      if (view.detail)
        status.append(element('p', 'delivery-detail', view.detail));
      if (view.progress.total) {
        const progress = element('div', 'delivery-progress');
        progress.setAttribute('role', 'progressbar');
        progress.setAttribute('aria-label', view.title || 'Delivery progress');
        progress.setAttribute('aria-valuemin', '0');
        progress.setAttribute('aria-valuemax', String(view.progress.total));
        progress.setAttribute('aria-valuenow', String(view.progress.current));
        if (view.progress.color)
          progress.style.setProperty(
            '--delivery-progress-color',
            view.progress.color,
          );
        for (let index = 0; index < view.progress.total; index++) {
          const segment = element('span', 'delivery-progress-segment');
          segment.setAttribute('aria-hidden', 'true');
          segment.dataset.state =
            index < view.progress.current
              ? 'complete'
              : index === view.progress.current && view.progress.animated
                ? 'active'
                : 'pending';
          progress.append(segment);
        }
        status.append(progress);
      }
      if (view.delay) status.append(element('p', 'delivery-delay', view.delay));
      const content = [status];
      if (
        view.courier &&
        (view.courier.name ||
          view.courier.description ||
          view.courier.vehicleDescription)
      ) {
        const courier = element('div', 'delivery-courier');
        if (view.courier.photoUrl) {
          const photo = element('img', 'delivery-courier-photo');
          photo.alt = '';
          photo.referrerPolicy = 'no-referrer';
          photo.src = view.courier.photoUrl;
          courier.append(photo);
        }
        const profile = element('div');
        if (view.courier.name)
          profile.append(
            element('p', 'delivery-courier-name', view.courier.name),
          );
        for (const value of [
          view.courier.description,
          view.courier.vehicleDescription,
        ])
          if (value) profile.append(element('p', 'delivery-secondary', value));
        courier.append(profile);
        content.push(courier);
      }
      const details = element('details', 'delivery-order');
      const summary = element('summary');
      summary.append(element('span', '', view.storeName || 'Order details'));
      if (view.displayId)
        summary.append(element('span', 'delivery-order-id', view.displayId));
      details.append(summary);
      if (view.items.length) {
        const list = element('ul', 'delivery-items');
        for (const item of view.items)
          list.append(
            element(
              'li',
              '',
              `${item.quantity ? `${item.quantity} × ` : ''}${item.title}`,
            ),
          );
        details.append(list);
      }
      if (view.total)
        details.append(element('p', 'delivery-total', view.total));
      if (view.address)
        details.append(element('p', 'delivery-address', view.address));
      if (view.instructions)
        details.append(element('p', 'delivery-secondary', view.instructions));
      const previousDetails = container.querySelector('details');
      if (previousDetails?.open) details.open = true;
      content.push(details);
      container.replaceChildren(...content);
      if (nextIdentity !== identity || view.stage !== stage) {
        identity = nextIdentity;
        stage = view.stage;
        // A containing page can subscribe locally. Credentials and private
        // order data are never broadcast to arbitrary iframe parent origins.
        if (CustomEvent)
          container.dispatchEvent(
            new CustomEvent('deliverychange', {
              bubbles: true,
              detail: {
                orderId: view.orderId,
                workflowId: view.workflowId,
                stage,
                title: view.title,
              },
            }),
          );
      }
    },
  };
}
