import {
  trackingText as text,
  trackingImageUrl as imageUrl,
  trackingMapPadding,
  panelElements,
  createTrackingBridge,
} from './tracking-panel.mjs';

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

export const deliveryMapPadding = trackingMapPadding;
export const createDeliveryBridge = (options) =>
  createTrackingBridge({ ...options, kind: 'eats' });

export function createDeliveryView(
  container,
  { document: doc = container.ownerDocument } = {},
) {
  let identity = null;
  let stage = null;
  let rendered = null;
  const eventIds = new Set();
  const { element, status: statusBlock, profile } = panelElements(doc);
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
      const status = statusBlock({
        title: view.title || view.storeName,
        eta: view.eta,
        detail: view.detail,
        etaDetail: view.etaDetail,
      });
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
        content.push(
          profile({
            name: view.courier.name,
            photoUrl: view.courier.photoUrl,
            details: [
              view.courier.description,
              view.courier.vehicleDescription,
            ],
          }),
        );
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
