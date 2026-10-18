import {
  panelElements,
  trackingText as text,
  trackingImageUrl,
} from './tracking-panel.mjs';

const phases = {
  searching: 'Finding your driver',
  approaching: 'Your driver is on the way',
  arriving: 'Your driver is arriving',
  waiting: 'Your driver is waiting',
  riding: 'On your way',
  completed: 'Ride completed',
  cancelled: 'Ride cancelled',
  unknown: 'Ride details',
};

function etaText(scene, phase) {
  const leg =
    phase === 'riding'
      ? 'destination'
      : ['approaching', 'arriving', 'waiting'].includes(phase)
        ? 'pickup'
        : null;
  if (!leg) return '';
  const display = text(scene.eta?.[`${leg}Display`]);
  if (display) return display;
  const minutes = scene.eta?.[`${leg}Minutes`];
  return Number.isFinite(minutes) && minutes >= 0 ? `${minutes} min` : '';
}

export function ridePresentation(scene) {
  if (scene?.kind !== 'ride' || !scene.ride) return null;
  const ride = scene.ride;
  const phase = Object.hasOwn(phases, ride.phase) ? ride.phase : 'unknown';
  const rating =
    typeof ride.driver?.rating === 'number'
      ? Number.isFinite(ride.driver.rating) &&
        ride.driver.rating >= 0 &&
        ride.driver.rating <= 5
        ? String(ride.driver.rating)
        : ''
      : text(ride.driver?.rating);
  const stop = (value) =>
    value ? { title: text(value.title), address: text(value.address) } : null;
  return {
    tripId: text(ride.tripId) || text(scene.tripId),
    phase,
    title: text(ride.statusTitle) || phases[phase],
    detail: text(ride.statusDetail),
    eta: etaText(scene, phase),
    product: text(ride.product),
    driver: ride.driver
      ? {
          name: text(ride.driver.name),
          photoUrl: trackingImageUrl(ride.driver.photoUrl),
          rating,
        }
      : null,
    vehicle: ride.vehicle
      ? {
          description: [
            ride.vehicle.color,
            ride.vehicle.make,
            ride.vehicle.model,
          ]
            .map(text)
            .filter(Boolean)
            .join(' '),
          licensePlate: text(ride.vehicle.licensePlate),
          imageUrl: trackingImageUrl(ride.vehicle.imageUrl),
        }
      : null,
    pickup: stop(ride.pickup),
    destination: stop(ride.destination),
  };
}

// Native phase selection controls presentation only. The observation and smooth
// motion pipeline is shared with delivery; no coordinates or routes are invented.
export function displayMapScene(scene) {
  const presentation = scene?.mapPresentation;
  if (!presentation) return scene;
  return {
    ...scene,
    waypoints: Array.isArray(presentation.waypointKinds)
      ? (scene.waypoints ?? []).filter((point) =>
          presentation.waypointKinds.includes(point.kind),
        )
      : scene.waypoints,
    routes: Array.isArray(presentation.routeKinds)
      ? (scene.routes ?? []).filter((route) =>
          presentation.routeKinds.includes(route.kind),
        )
      : scene.routes,
  };
}

export function createRideView(
  container,
  { document: doc = container.ownerDocument } = {},
) {
  const { element, status, profile } = panelElements(doc);
  let rendered = null;
  let identity = null;
  let phase = null;
  const eventIds = new Set();
  return {
    render(scene) {
      const view = ridePresentation(scene);
      container.hidden = !view;
      if (!view) {
        container.replaceChildren();
        rendered = identity = phase = null;
        eventIds.clear();
        return;
      }
      if (identity !== view.tripId) eventIds.clear();
      const CustomEvent = doc.defaultView?.CustomEvent;
      for (const event of (Array.isArray(scene.rideEvents)
        ? scene.rideEvents
        : []
      ).slice(-1000)) {
        if (typeof event?.id !== 'string' || eventIds.has(event.id)) continue;
        eventIds.add(event.id);
        if (eventIds.size > 1000)
          eventIds.delete(eventIds.values().next().value);
        if (CustomEvent)
          container.dispatchEvent(
            new CustomEvent('rideevent', { bubbles: true, detail: event }),
          );
      }
      const signature = JSON.stringify(view);
      if (signature === rendered) return;
      rendered = signature;
      container.dataset.phase = view.phase;
      const content = [
        status({ title: view.title, eta: view.eta, detail: view.detail }),
      ];
      if (
        view.driver?.name ||
        view.driver?.rating ||
        view.vehicle?.description ||
        view.vehicle?.licensePlate
      ) {
        const driver = profile({
          name: view.driver?.name,
          photoUrl: view.driver?.photoUrl,
          details: [
            view.driver?.rating ? `★ ${view.driver.rating}` : '',
            view.vehicle?.description,
          ],
        });
        driver.className += ' ride-driver';
        const info = driver.querySelector('.tracking-profile-detail');
        if (view.vehicle?.licensePlate)
          (info ?? driver).append(
            element('p', 'ride-license-plate', view.vehicle.licensePlate),
          );
        if (view.vehicle?.imageUrl) {
          const image = element('img', 'ride-vehicle-image');
          image.alt = view.vehicle.description || 'Vehicle';
          image.referrerPolicy = 'no-referrer';
          image.onerror = () => {
            image.hidden = true;
          };
          image.src = view.vehicle.imageUrl;
          driver.append(image);
        }
        content.push(driver);
      }
      if (view.product)
        content.push(
          element('p', 'delivery-secondary ride-product', view.product),
        );
      const stops = element('ol', 'ride-stops');
      for (const [kind, label, stop] of [
        ['pickup', 'Pickup', view.pickup],
        ['destination', 'Destination', view.destination],
      ]) {
        if (!stop || !(stop.title || stop.address)) continue;
        const item = element('li', `ride-stop ride-stop-${kind}`);
        item.append(element('p', 'ride-stop-label', label));
        item.append(
          element('p', 'ride-stop-title', stop.title || stop.address),
        );
        if (stop.title && stop.address && stop.title !== stop.address)
          item.append(element('p', 'delivery-secondary', stop.address));
        stops.append(item);
      }
      if (stops.children.length) content.push(stops);
      container.replaceChildren(...content);
      if (identity !== view.tripId || phase !== view.phase) {
        identity = view.tripId;
        phase = view.phase;
        if (CustomEvent)
          container.dispatchEvent(
            new CustomEvent('ridechange', {
              bubbles: true,
              detail: { tripId: identity, phase, title: view.title },
            }),
          );
      }
    },
  };
}
