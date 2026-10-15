import { watchScenes } from './live-stream.mjs';
import {
  Map as MapLibreMap,
  Marker,
  LngLatBounds,
} from 'https://unpkg.com/maplibre-gl@6.14.0/dist/maplibre-gl.mjs';
import { adaptNativeMapStyle, nativeStyles } from './map-style.mjs';
import {
  mapAssetUrl,
  spriteFrame,
  vehicleSpriteScale,
} from './vehicle-style.mjs';
import {
  routePulseAt,
  pulseGradient,
  routeBaseGradient,
} from './route-animation.mjs';
import { MapMotion, trimRouteAt } from './map-motion.mjs';
import { createWaypoint, updateWaypoint } from './waypoint.mjs';

const key = new URLSearchParams(location.hash.slice(1)).get('key');
// A renewed viewer lease can change only the fragment in an existing browser tab.
// Reload so its requests use the new key and an expired poller can restart.
addEventListener('hashchange', () => location.reload());
const status = document.querySelector('#status');
const night = matchMedia('(prefers-color-scheme: dark)');
let map,
  latest,
  markers = [],
  follow = true,
  stopped = false,
  timer;
let vehicleDraw = null,
  vehicleGeneration = 0,
  vehicleMarker = null,
  vehicleNode = null;
let renderedPosition = null,
  renderedRoutePosition = null;
const motion = new MapMotion();
const waypoints = new Map();
let pulseStart = null,
  animationFrameId = null;
const vehicleImages = new Map();
let liveEnabled = false,
  liveController = null,
  liveRetryTimer = null;
const coordinate = (point) => [point.lon, point.lat];
const animationTime = () => performance.timeOrigin + performance.now();
const show = (message) => {
  status.textContent = message;
};
function imageSize(url) {
  if (!vehicleImages.has(url))
    vehicleImages.set(
      url,
      new Promise((resolve, reject) => {
        const image = new Image();
        image.referrerPolicy = 'no-referrer';
        image.onload = () =>
          resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error('Vehicle image could not load'));
        image.src = url;
      }),
    );
  return vehicleImages.get(url);
}
async function decorateVehicle(node, scene, generation) {
  const icons = scene.vehicleMapIcons;
  const select = (pair) =>
    mapAssetUrl(
      night.matches
        ? (pair?.nightImageURL ?? pair?.dayImageURL)
        : (pair?.dayImageURL ?? pair?.nightImageURL),
    );
  const sprite = select(icons?.spritesheetMapIcon),
    standard =
      select(icons?.standardMapIcon) ?? mapAssetUrl(scene.vehicleMapIconUrl);
  for (const [url, count] of [
    [sprite, icons?.spriteDivisionCount],
    [standard, 1],
  ]) {
    if (!url) continue;
    try {
      const dimensions = await imageSize(url);
      if (generation !== vehicleGeneration || stopped) return;
      if (
        !Number.isInteger(count) ||
        count < 1 ||
        count > 360 ||
        dimensions.width !== dimensions.height * count
      )
        continue;
      node.className = 'vehicle-artwork';
      node.style.width = node.style.height = count > 1 ? '56px' : '40px';
      node.style.backgroundImage = `url(${JSON.stringify(url)})`;
      node.style.backgroundSize = `${count * 100}% 100%`;
      node.dataset.spriteCount = String(count);
      vehicleDraw = () => {
        const heading =
          renderedPosition?.course ?? scene.driver.position.course;
        if (count > 1 && Number.isFinite(heading)) {
          const frame = spriteFrame(heading, map.getBearing(), count);
          node.style.backgroundPosition = `${(frame / (count - 1)) * 100}% 0`;
          node.style.transform = `scale(${vehicleSpriteScale(map.getZoom())})`;
        } else if (count === 1 && Number.isFinite(heading))
          node.style.transform = `rotate(${heading - map.getBearing()}deg)`;
      };
      vehicleDraw();
      return;
    } catch {
      /* Retain the position indicator if original artwork is unavailable. */
    }
  }
}
function points(scene) {
  return [
    ...(scene.waypoints ?? []),
    ...(scene.driver?.position ? [scene.driver.position] : []),
    ...(scene.routes ?? []).flatMap((route) => route.points ?? []),
  ];
}
function recenter() {
  if (!map || !latest) return;
  const items = points(latest);
  if (!items.length) return;
  const bounds = items.reduce(
    (b, p) => b.extend(coordinate(p)),
    new LngLatBounds(),
  );
  const northeast = bounds.getNorthEast(),
    southwest = bounds.getSouthWest();
  if (northeast.lng === southwest.lng && northeast.lat === southwest.lat)
    map.easeTo({ center: coordinate(items[0]), zoom: 15 });
  else map.fitBounds(bounds, { padding: 16, maxZoom: 16, duration: 500 });
}
function routeData(scene, position) {
  return {
    type: 'FeatureCollection',
    features: (scene.routes ?? [])
      .filter((r) => r.points?.length > 1)
      .map((route) => ({
        type: 'Feature',
        properties: { kind: route.kind },
        geometry: {
          type: 'LineString',
          coordinates: (['provider', 'provider_recommended'].includes(
            route.kind,
          ) && position
            ? trimRouteAt(motion.routePoints(route), position)
            : route.points
          ).map(coordinate),
        },
      })),
  };
}
function animateRoute(now) {
  animationFrameId = null;
  if (
    stopped ||
    !latest ||
    !['active', 'dispatching', 'replay'].includes(latest.state) ||
    !map?.getSource('ride-routes')
  )
    return;
  const position = motion.frame(animationTime());
  if (position && vehicleMarker) {
    renderedPosition = position;
    vehicleMarker.setLngLat(coordinate(position));
    vehicleDraw?.();
    if (
      !renderedRoutePosition ||
      position.lat !== renderedRoutePosition.lat ||
      position.lon !== renderedRoutePosition.lon
    ) {
      map.getSource('ride-routes')?.setData(routeData(latest, position));
      renderedRoutePosition = position;
    }
  }
  if (map.getLayer('ride-route-pulse')) {
    pulseStart ??= now;
    // The captured native route-choice video fits the legacy linear-alpha
    // branch (RMSE 1.45 versus 11.15 for migrated); active-trip flag is unknown.
    const frame = routePulseAt(now - pulseStart, 'legacy');
    map.setPaintProperty(
      'ride-route',
      'line-gradient',
      routeBaseGradient(frame, { night: night.matches }),
    );
    map.setPaintProperty(
      'ride-route-pulse',
      'line-gradient',
      pulseGradient(frame, { night: night.matches }),
    );
  }
  animationFrameId = requestAnimationFrame(animateRoute);
}
function startRouteAnimation() {
  if (animationFrameId === null)
    animationFrameId = requestAnimationFrame(animateRoute);
}
function removeVehicle() {
  ++vehicleGeneration;
  vehicleMarker?.remove();
  vehicleMarker =
    vehicleNode =
    vehicleDraw =
    renderedPosition =
    renderedRoutePosition =
      null;
}
function render(scene) {
  const changedTrip = latest?.tripId !== scene.tripId;
  latest = scene;
  if (changedTrip) {
    pulseStart = null;
    motion.reset();
    removeVehicle();
  }
  motion.update(scene, animationTime());
  if (!map || (!map.getLayer('ride-route') && !map.isStyleLoaded())) return;
  const ids = new Set();
  for (const [index, point] of (scene.waypoints ?? []).entries()) {
    const id = `${point.kind}:${point.uuid ?? index}`;
    ids.add(id);
    let marker = waypoints.get(id);
    if (!marker) {
      const node = createWaypoint(point);
      marker = new Marker({ element: node })
        .setLngLat(coordinate(point))
        .addTo(map);
      waypoints.set(id, marker);
    } else marker.setLngLat(coordinate(point));
    updateWaypoint(marker.getElement(), point, scene);
  }
  for (const [id, marker] of waypoints)
    if (!ids.has(id)) {
      marker.remove();
      waypoints.delete(id);
    }
  if (
    scene.driver?.position &&
    ['active', 'dispatching', 'replay'].includes(scene.state)
  ) {
    if (!vehicleMarker) {
      vehicleNode = document.createElement('div');
      vehicleNode.className = 'driver';
      vehicleNode.setAttribute('aria-label', 'Driver position');
      const container = document.createElement('div');
      container.append(vehicleNode);
      renderedPosition = motion.position ?? scene.driver.position;
      vehicleMarker = new Marker({ element: container })
        .setLngLat(coordinate(renderedPosition))
        .addTo(map);
      decorateVehicle(vehicleNode, scene, ++vehicleGeneration);
    }
  } else removeVehicle();
  markers = [...waypoints.values(), ...(vehicleMarker ? [vehicleMarker] : [])];
  const routes = routeData(scene, renderedPosition);
  if (!map.getSource('ride-routes')) {
    map.addSource('ride-routes', {
      type: 'geojson',
      data: routes,
      lineMetrics: true,
    });
    map.addLayer({
      id: 'ride-route',
      type: 'line',
      source: 'ride-routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': 3,
        'line-gradient': routeBaseGradient(
          { baseEnd: 0 },
          { night: night.matches },
        ),
      },
    });
    map.addLayer({
      id: 'ride-route-pulse',
      type: 'line',
      source: 'ride-routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': 3,
        'line-gradient': pulseGradient({ divider: 0, alpha: 0 }),
      },
    });
  } else map.getSource('ride-routes').setData(routes);
  if (['active', 'dispatching', 'replay'].includes(scene.state))
    startRouteAnimation();
  else if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  const hasCoordinates = points(scene).length > 0;
  document.querySelector('#map').hidden = !hasCoordinates;
  document.querySelector('#recenter').hidden = !hasCoordinates;
  if (hasCoordinates) {
    map.resize();
    if (changedTrip || follow) recenter();
  }
  if (scene.state === 'idle') show('No active ride');
  else if (scene.state === 'ended')
    show(
      ['ClientCanceled', 'DriverCanceled', 'Canceled', 'CANCELED'].includes(
        scene.status,
      )
        ? 'Ride cancelled'
        : 'Ride ended',
    );
  else if (scene.state === 'unavailable') show('Trip details are unavailable');
  else
    show(
      [
        ['failed', 'reconnecting', 'revoked'].includes(
          scene.liveTransport?.state,
        )
          ? 'Live updates unavailable · using status snapshots'
          : null,
        scene.state === 'replay' && typeof scene.status === 'string'
          ? scene.status
          : null,
        Number.isFinite(scene.driver?.positionAgeMs) &&
        scene.driver.positionAgeMs > 30000
          ? `Driver location ${Math.floor(scene.driver.positionAgeMs / 1000)}s old`
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
    );
}
async function loadStyle() {
  const response = await fetch(nativeStyles.default, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error('Uber map style is unavailable');
  const result = adaptNativeMapStyle(await response.json(), {
    night: night.matches,
  });
  window.uberMapFidelity = result.fidelity;
  return result.style;
}
function unavailable(code) {
  document.querySelector('#map').hidden = true;
  document.querySelector('#recenter').hidden = true;
  stopped = true;
  clearTimeout(timer);
  clearTimeout(liveRetryTimer);
  liveController?.abort();
  show(code === 410 ? 'Map viewer expired' : 'Map access is unavailable');
  markers.forEach((marker) => marker.remove());
  map
    ?.getSource('ride-routes')
    ?.setData({ type: 'FeatureCollection', features: [] });
}
function startLiveDelivery() {
  if (stopped || liveController || !liveEnabled) return;
  liveController = new AbortController();
  const controller = liveController;
  watchScenes({
    url: new URL('./events', location.href),
    key,
    signal: controller.signal,
    onScene: render,
    onUnavailable: unavailable,
    onRefreshError: () =>
      show('Trip status refresh failed · using last received data'),
  })
    .catch(() => {
      if (!stopped && !controller.signal.aborted) {
        show('Live updates reconnecting · using status snapshots');
        liveRetryTimer = setTimeout(startLiveDelivery, 2000);
      }
    })
    .finally(() => {
      if (liveController === controller) liveController = null;
    });
}
async function poll() {
  if (stopped) return;
  let interval = 8000;
  try {
    const response = await fetch(new URL('./state', location.href), {
      headers: { authorization: `Bearer ${key}` },
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    if ([401, 403, 410].includes(response.status)) {
      unavailable(response.status);
      return;
    }
    if (!response.ok) throw new Error('Trip refresh failed');
    const payload = await response.json();
    interval = Math.max(
      8000,
      Math.min(3600000, payload.scene.pollingIntervalMs ?? 8000),
    );
    render(payload.scene);
    liveEnabled =
      payload.fidelity?.updates === 'ramen_push_with_status_fallback';
    startLiveDelivery();
  } catch {
    show(
      latest && points(latest).length
        ? 'Trip refresh failed · showing last received locations'
        : 'Trip details unavailable · retrying',
    );
  }
  timer = setTimeout(poll, interval);
}
document.querySelector('#recenter').addEventListener('click', () => {
  follow = true;
  recenter();
});
addEventListener('pagehide', () => {
  stopped = true;
  clearTimeout(timer);
  clearTimeout(liveRetryTimer);
  liveController?.abort();
  if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
});
try {
  if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key))
    throw new Error('Open the complete map link returned by the CLI');
  // Obtain a real scene before constructing the map. A global default camera
  // must never masquerade as the booked ride while the trip request fails.
  await poll();
  if (stopped) throw new Error(status.textContent);
  const initial = latest && points(latest)[0];
  map = new MapLibreMap({
    container: 'map',
    style: await loadStyle(),
    center: initial ? coordinate(initial) : [0, 0],
    zoom: 15,
    attributionControl: false,
  });
  map.on('dragstart', () => {
    follow = false;
  });
  map.on('rotate', () => {
    vehicleDraw?.();
  });
  map.on('zoom', () => {
    vehicleDraw?.();
  });
  map.on('zoomstart', (event) => {
    if (event.originalEvent) follow = false;
  });
  map.on('error', () => {
    show('Some map resources could not load');
  });
  map.on('load', () => {
    if (latest) render(latest);
  });
  night.addEventListener('change', async () => {
    try {
      map.setStyle(await loadStyle());
      map.once('style.load', () => {
        removeVehicle();
        if (latest) render(latest);
      });
    } catch {
      show('Unable to change map theme');
    }
  });
} catch (error) {
  show(error.message);
}
