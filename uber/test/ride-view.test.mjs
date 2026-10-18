import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRideView,
  displayMapScene,
  ridePresentation,
} from '../src/map-web/ride.mjs';
import {
  createTrackingBridge,
  replayNotice,
} from '../src/map-web/tracking-panel.mjs';

function scene() {
  return {
    kind: 'ride',
    state: 'active',
    tripId: 'trip1',
    ride: {
      tripId: 'trip1',
      phase: 'approaching',
      statusTitle: 'Alex is on the way',
      statusDetail: 'Meet at your pickup point',
      product: 'UberX',
      driver: {
        name: 'Alex',
        rating: 4.98,
        photoUrl: 'https://d1w2poirtb3as9.cloudfront.net/driver.jpg',
      },
      vehicle: {
        make: 'Toyota',
        model: 'Prius',
        color: 'White',
        licensePlate: '8ABC123',
      },
      pickup: { title: '519 Santa Clara Ave', address: 'Venice, CA' },
      destination: { title: 'Ralphs', address: '910 Lincoln Blvd' },
    },
    eta: {
      pickupDisplay: '3 min',
      pickupMinutes: 3,
      destinationDisplay: '12 min',
      destinationMinutes: 12,
    },
    driver: { position: { lat: 33.99, lon: -118.46 } },
    waypoints: [
      { kind: 'pickup', lat: 33.98, lon: -118.45 },
      { kind: 'dropoff', lat: 34.01, lon: -118.48 },
    ],
    routes: [
      {
        kind: 'provider',
        points: [
          { lat: 33.99, lon: -118.46 },
          { lat: 33.98, lon: -118.45 },
        ],
      },
      {
        kind: 'destination',
        points: [
          { lat: 33.98, lon: -118.45 },
          { lat: 34.01, lon: -118.48 },
        ],
      },
    ],
    rideEvents: [{ id: 'event1', type: 'approaching' }],
  };
}

class Element {
  constructor(tag, doc) {
    this.tagName = tag;
    this.ownerDocument = doc;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.events = [];
  }
  set innerHTML(_) {
    throw new Error('No HTML interpolation');
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  querySelector(selector) {
    return (
      this.children.find((child) =>
        selector.startsWith('.')
          ? child.className?.split(' ').includes(selector.slice(1))
          : child.tagName === selector,
      ) ??
      this.children.map((child) => child.querySelector(selector)).find(Boolean)
    );
  }
  dispatchEvent(event) {
    this.events.push(event);
  }
}
function fixture() {
  const document = {
    createElement: (tag) => new Element(tag, document),
    defaultView: {
      CustomEvent: class {
        constructor(type, data) {
          this.type = type;
          Object.assign(this, data);
        }
      },
    },
  };
  const container = new Element('section', document);
  return { container, view: createRideView(container) };
}

test('ride panel shows native ETA, driver, rating, vehicle, plate and trip stops using shared style', () => {
  const { view, container } = fixture();
  view.render(scene());
  assert.equal(container.hidden, false);
  assert.equal(
    container.querySelector('.delivery-title').textContent,
    'Alex is on the way',
  );
  assert.equal(container.querySelector('.delivery-eta').textContent, '3 min');
  assert.equal(
    container.querySelector('.delivery-courier-name').textContent,
    'Alex',
  );
  assert.equal(
    container.querySelector('.delivery-courier-photo').src,
    'https://d1w2poirtb3as9.cloudfront.net/driver.jpg',
  );
  assert.equal(
    container.querySelector('.ride-license-plate').textContent,
    '8ABC123',
  );
  assert.equal(
    container
      .querySelector('.ride-stop-destination')
      .querySelector('.ride-stop-title').textContent,
    'Ralphs',
  );
  assert.equal(container.querySelector('.delivery-progress'), undefined);
});

test('phase selects the native ETA leg, omits missing estimates and handles completed rides without an estimate', () => {
  const input = scene();
  input.ride.phase = 'riding';
  assert.equal(ridePresentation(input).eta, '12 min');
  input.eta.destinationDisplay = null;
  assert.equal(ridePresentation(input).eta, '12 min');
  input.eta.destinationMinutes = undefined;
  assert.equal(ridePresentation(input).eta, '');
  input.ride.phase = 'searching';
  assert.equal(ridePresentation(input).eta, '');
  input.ride.phase = 'completed';
  input.ride.statusTitle = null;
  assert.equal(ridePresentation(input).title, 'Ride completed');
  assert.equal(ridePresentation(input).eta, '');
});

test('ride panel is safe without assignment data and treats markup as text', () => {
  const input = scene();
  input.ride.driver.photoUrl = 'https://uber.com.evil.test/photo';
  input.ride.statusTitle = '<img src=x onerror=bad()>';
  const { view, container } = fixture();
  view.render(input);
  assert.equal(
    container.querySelector('.delivery-title').textContent,
    input.ride.statusTitle,
  );
  assert.equal(container.querySelector('img'), undefined);
  input.ride.driver = input.ride.vehicle = null;
  input.ride.phase = 'searching';
  view.render(input);
  assert.equal(container.querySelector('.ride-driver'), undefined);
  view.render({ kind: 'eats' });
  assert.equal(container.hidden, true);
  assert.equal(container.children.length, 0);
});

test('ride events are deduplicated independently of presentation updates', () => {
  const input = scene();
  const { view, container } = fixture();
  view.render(input);
  view.render(input);
  input.rideEvents.push({ id: 'event2', type: 'arriving' });
  view.render(input);
  assert.deepEqual(
    container.events
      .filter((event) => event.type === 'rideevent')
      .map((event) => event.detail.id),
    ['event1', 'event2'],
  );
  input.ride.phase = 'arriving';
  view.render(input);
  assert.equal(
    container.events.filter((event) => event.type === 'ridechange').at(-1)
      .detail.phase,
    'arriving',
  );
});

test('phase-focused map filters endpoints and route legs without changing observations or the source scene', () => {
  const input = scene();
  const unchanged = structuredClone(input);
  assert.equal(displayMapScene(input), input);
  input.mapPresentation = {
    phase: 'approaching',
    waypointKinds: ['pickup'],
    routeKinds: ['provider'],
  };
  const approach = displayMapScene(input);
  assert.deepEqual(
    approach.waypoints.map((point) => point.kind),
    ['pickup'],
  );
  assert.deepEqual(
    approach.routes.map((route) => route.kind),
    ['provider'],
  );
  assert.equal(approach.driver, input.driver);
  input.mapPresentation = {
    phase: 'riding',
    waypointKinds: ['dropoff'],
    routeKinds: ['destination'],
  };
  assert.deepEqual(
    displayMapScene(input).waypoints.map((point) => point.kind),
    ['dropoff'],
  );
  assert.deepEqual(
    displayMapScene(input).routes.map((route) => route.kind),
    ['destination'],
  );
  input.mapPresentation = { waypointKinds: [], routeKinds: [] };
  assert.deepEqual(displayMapScene(input).routes, []);
  assert.deepEqual(input.routes, unchanged.routes);
  assert.deepEqual(input.waypoints, unchanged.waypoints);
});

test('recorded ride is clearly labeled without presenting historical location age as a live warning', () => {
  const input = scene();
  input.state = 'replay';
  input.driver.positionAgeMs = 999999999;
  input.replay = {
    label: 'Recorded ride · no active booking',
    sourceObservedAt: 123,
  };
  assert.equal(replayNotice(input), 'Recorded ride · no active booking');
  assert.doesNotMatch(replayNotice(input), /old|live/i);
  input.replay = null;
  assert.equal(replayNotice(input), 'Recorded ride · no active booking');
  assert.equal(replayNotice(scene()), null);
});

test('one iframe listener routes exact-origin ride hooks and denies wrong namespace/source', () => {
  const listeners = new Map(),
    messages = [];
  const win = {
    parent: {
      postMessage: (packet, origin) => messages.push({ packet, origin }),
    },
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: (type) => listeners.delete(type),
  };
  const bridge = createTrackingBridge({
    window: win,
    frameOrigins: ['https://client.example'],
  });
  const input = scene();
  bridge.update(input);
  assert.deepEqual(
    messages.map((message) => message.packet.type),
    ['uber-ride:ready'],
  );
  messages.length = 0;
  const send = (type, origin = 'https://client.example', source = win.parent) =>
    listeners.get('message')?.({ source, origin, data: { type } });
  send('uber-ride:subscribe', 'https://evil.test');
  send('uber-ride:subscribe', 'https://client.example', {});
  send('uber-eats:subscribe');
  assert.equal(messages.length, 0);
  send('uber-ride:subscribe');
  assert.equal(messages[0].packet.type, 'uber-ride:snapshot');
  input.rideEvents.push({ id: 'event2', type: 'arriving' });
  bridge.update(input);
  bridge.update(input);
  assert.deepEqual(
    messages.map((message) => message.packet.type),
    ['uber-ride:snapshot', 'uber-ride:ride'],
  );
  assert.ok(
    messages.every((message) => message.origin === 'https://client.example'),
  );
  send('uber-ride:unsubscribe');
  input.rideEvents.push({ id: 'event3', type: 'riding' });
  bridge.update(input);
  assert.equal(messages.length, 2);
  send('uber-ride:subscribe');
  bridge.close();
  assert.equal(messages.at(-1).packet.type, 'uber-ride:unavailable');
  assert.equal(listeners.size, 0);
});
