const svgNS = 'http://www.w3.org/2000/svg';

// Captured native reference profile; primary marker size/model branches remain
// documented in docs/map-parity.md. Never invent an ETA when the API omits it.
export function createWaypoint(point) {
  const container = document.createElement('div');
  container.className = 'waypoint-container';
  const anchor = document.createElement('div');
  anchor.className = `waypoint ${point.kind === 'pickup' ? 'pickup' : ''}`;
  anchor.setAttribute('aria-label', point.kind ?? 'Waypoint');
  container.append(anchor);
  return container;
}

export function updateWaypoint(container, point, scene) {
  const label =
    point.kind === 'pickup' &&
    ['active', 'dispatching', 'replay'].includes(scene.state)
      ? scene.eta?.pickupDisplay
      : null;
  let callout = container.querySelector('.waypoint-callout');
  if (typeof label !== 'string' || !label.trim()) {
    callout?.remove();
    return;
  }
  if (!callout) {
    callout = document.createElement('div');
    callout.className = 'waypoint-callout';
    const arrow = document.createElementNS(svgNS, 'svg');
    arrow.setAttribute('viewBox', '0 0 24 24');
    arrow.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svgNS, 'path');
    // Native CalloutView R path: bottom-start, LTR.
    path.setAttribute('d', 'M0 24L24 16L8 0L0 24Z');
    arrow.append(path);
    const body = document.createElement('span');
    body.className = 'waypoint-callout-body';
    callout.append(arrow, body);
    container.append(callout);
  }
  callout.querySelector('.waypoint-callout-body').textContent = label;
}
