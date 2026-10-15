import { Map as MapLibreMap, Marker, LngLatBounds } from 'https://unpkg.com/maplibre-gl@6.14.0/dist/maplibre-gl.mjs';
import { adaptNativeMapStyle, nativeStyles } from './map-style.mjs';
import { mapAssetUrl, spriteFrame, vehicleSpriteScale } from './vehicle-style.mjs';

const key = new URLSearchParams(location.hash.slice(1)).get('key');
// A renewed viewer lease can change only the fragment in an existing browser tab.
// Reload so its requests use the new key and an expired poller can restart.
addEventListener('hashchange', () => location.reload());
const status = document.querySelector('#status');
const night = matchMedia('(prefers-color-scheme: dark)');
let map, latest, markers = [], follow = true, stopped = false, timer;
let vehicleDraw = null, vehicleGeneration = 0;
const vehicleImages = new Map();
const coordinate = point => [point.lon, point.lat];
const show = message => { status.textContent = message; };
function imageSize(url) {
  if (!vehicleImages.has(url)) vehicleImages.set(url, new Promise((resolve, reject) => {
    const image = new Image(); image.referrerPolicy = 'no-referrer';
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('Vehicle image could not load'));
    image.src = url;
  }));
  return vehicleImages.get(url);
}
async function decorateVehicle(node, scene, generation) {
  const icons = scene.vehicleMapIcons;
  const select = pair => mapAssetUrl(night.matches ? pair?.nightImageURL ?? pair?.dayImageURL : pair?.dayImageURL ?? pair?.nightImageURL);
  const sprite = select(icons?.spritesheetMapIcon), standard = select(icons?.standardMapIcon) ?? mapAssetUrl(scene.vehicleMapIconUrl);
  for (const [url, count] of [[sprite, icons?.spriteDivisionCount], [standard, 1]]) {
    if (!url) continue;
    try {
      const dimensions = await imageSize(url);
      if (generation !== vehicleGeneration || stopped) return;
      if (!Number.isInteger(count) || count < 1 || count > 360 || dimensions.width !== dimensions.height * count) continue;
      node.className = 'vehicle-artwork';
      node.style.width = node.style.height = count > 1 ? '56px' : '40px';
      node.style.backgroundImage = `url(${JSON.stringify(url)})`;
      node.style.backgroundSize = `${count * 100}% 100%`;
      node.dataset.spriteCount = String(count);
      vehicleDraw = () => {
        const heading = scene.driver.position.course;
        if (count > 1 && Number.isFinite(heading)) {
          const frame = spriteFrame(heading, map.getBearing(), count);
          node.style.backgroundPosition = `${frame / (count - 1) * 100}% 0`;
          node.style.transform = `scale(${vehicleSpriteScale(map.getZoom())})`;
        } else if (count === 1 && Number.isFinite(heading)) node.style.transform = `rotate(${heading - map.getBearing()}deg)`;
      };
      vehicleDraw();
      return;
    } catch { /* Retain the position indicator if original artwork is unavailable. */ }
  }
}
function points(scene) {
  return [...(scene.waypoints ?? []), ...(scene.driver?.position ? [scene.driver.position] : []), ...(scene.routes ?? []).flatMap(route => route.points ?? [])];
}
function recenter() {
  if (!map || !latest) return;
  const items = points(latest);
  if (!items.length) return;
  const bounds = items.reduce((b, p) => b.extend(coordinate(p)), new LngLatBounds());
  const northeast = bounds.getNorthEast(), southwest = bounds.getSouthWest();
  if (northeast.lng === southwest.lng && northeast.lat === southwest.lat) map.easeTo({ center: coordinate(items[0]), zoom: 15 });
  else map.fitBounds(bounds, { padding: { top: 90, bottom: 80, left: 48, right: 48 }, maxZoom: 16, duration: 600 });
}
function render(scene) {
  const changedTrip = latest?.tripId !== scene.tripId;
  latest = scene;
  if (!map?.isStyleLoaded()) return;
  for (const marker of markers) marker.remove();
  markers = [];
  vehicleDraw = null;
  const generation = ++vehicleGeneration;
  for (const point of scene.waypoints ?? []) {
    const node = document.createElement('div');
    node.className = `waypoint ${point.kind === 'pickup' ? 'pickup' : ''}`;
    node.setAttribute('aria-label', point.kind ?? 'Waypoint');
    markers.push(new Marker({ element: node }).setLngLat(coordinate(point)).addTo(map));
  }
  if (scene.driver?.position) {
    // A point is explicitly a position indicator, not a substitute 3D car asset.
    const node = document.createElement('div'); node.className = 'driver'; node.setAttribute('aria-label', 'Driver position');
    // Keep MapLibre's positioning transform on a parent; sprite orientation owns
    // only the child so camera changes cannot overwrite marker placement.
    const container = document.createElement('div'); container.append(node);
    markers.push(new Marker({ element: container }).setLngLat(coordinate(scene.driver.position)).addTo(map));
    decorateVehicle(node, scene, generation);
  }
  const routes = { type: 'FeatureCollection', features: (scene.routes ?? []).filter(r => r.points?.length > 1).map(route => ({ type: 'Feature', properties: { kind: route.kind }, geometry: { type: 'LineString', coordinates: route.points.map(coordinate) } })) };
  if (!map.getSource('ride-routes')) {
    map.addSource('ride-routes', { type: 'geojson', data: routes });
    map.addLayer({ id: 'ride-route', type: 'line', source: 'ride-routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['case', ['==', ['get', 'kind'], 'trip_recommended'], night.matches ? '#aaa' : '#777', night.matches ? '#fff' : '#000'], 'line-width': 4 } });
  } else map.getSource('ride-routes').setData(routes);
  const hasCoordinates = points(scene).length > 0;
  document.querySelector('#map').hidden = !hasCoordinates;
  document.querySelector('#recenter').hidden = !hasCoordinates;
  if (hasCoordinates) { map.resize(); if (changedTrip || follow) recenter(); }
  if (scene.state === 'idle') show('No active ride');
  else if (scene.state === 'ended') show(['ClientCanceled', 'DriverCanceled', 'Canceled', 'CANCELED'].includes(scene.status) ? 'Ride cancelled' : 'Ride ended');
  else if (scene.state === 'unavailable') show('Trip details are unavailable');
  else show([typeof scene.status === 'string' ? scene.status : null, scene.eta?.pickupDisplay, Number.isFinite(scene.driver?.positionAgeMs) && scene.driver.positionAgeMs > 30000 ? `Driver location ${Math.floor(scene.driver.positionAgeMs / 1000)}s old` : null].filter(Boolean).join(' · '));
}
async function loadStyle() {
  const response = await fetch(nativeStyles.default, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error('Uber map style is unavailable');
  const result = adaptNativeMapStyle(await response.json(), { night: night.matches });
  window.uberMapFidelity = result.fidelity;
  return result.style;
}
async function poll() {
  if (stopped) return;
  let interval = 8000;
  try {
    const response = await fetch(new URL('./state', location.href), { headers: { authorization: `Bearer ${key}` }, cache: 'no-store', referrerPolicy: 'no-referrer' });
    if ([401, 403, 410].includes(response.status)) { document.querySelector('#map').hidden = true; document.querySelector('#recenter').hidden = true; stopped = true; show(response.status === 410 ? 'Map viewer expired' : 'Map access is unavailable'); markers.forEach(m => m.remove()); map?.getSource('ride-routes')?.setData({ type: 'FeatureCollection', features: [] }); return; }
    if (!response.ok) throw new Error('Trip refresh failed');
    const payload = await response.json();
    interval = Math.max(8000, Math.min(3600000, payload.scene.pollingIntervalMs ?? 8000));
    render(payload.scene);
  } catch { show(latest && points(latest).length ? 'Trip refresh failed · showing last received locations' : 'Trip details unavailable · retrying'); }
  timer = setTimeout(poll, interval);
}
document.querySelector('#recenter').addEventListener('click', () => { follow = true; recenter(); });
addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); });
try {
  if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Open the complete map link returned by the CLI');
  // Obtain a real scene before constructing the map. A global default camera
  // must never masquerade as the booked ride while the trip request fails.
  await poll();
  if (stopped) throw new Error(status.textContent);
  const initial = latest && points(latest)[0];
  map = new MapLibreMap({ container: 'map', style: await loadStyle(), center: initial ? coordinate(initial) : [0, 0], zoom: 15, attributionControl: false });
  map.on('dragstart', () => { follow = false; });
  map.on('rotate', () => { vehicleDraw?.(); });
  map.on('zoom', () => { vehicleDraw?.(); });
  map.on('zoomstart', event => { if (event.originalEvent) follow = false; });
  map.on('error', () => { show('Some map resources could not load'); });
  map.on('load', () => { if (latest) render(latest); });
  night.addEventListener('change', async () => { try { map.setStyle(await loadStyle()); map.once('style.load', () => { if (latest) render(latest); }); } catch { show('Unable to change map theme'); } });
} catch (error) { show(error.message); }
