import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeliveryBridge,
  createDeliveryView,
  deliveryMapPadding,
  deliveryPresentation,
} from '../src/map-web/delivery.mjs';

// The view deliberately uses a small DOM surface and textContent exclusively.
// This fixture catches HTML interpolation without a browser runtime dependency.
class Element {
  constructor(tag, document) {
    this.tagName = tag;
    this.ownerDocument = document;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.events = [];
    this.style = {
      setProperty: (name, value) => {
        this.attributes[name] = value;
      },
    };
  }
  set innerHTML(_) {
    throw new Error('HTML interpolation is forbidden');
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  querySelector(tag) {
    return (
      this.children.find((node) => node.tagName === tag) ??
      this.children.map((node) => node.querySelector(tag)).find(Boolean)
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
        constructor(type, options) {
          this.type = type;
          Object.assign(this, options);
        }
      },
    },
  };
  const container = new Element('section', document);
  return { container, view: createDeliveryView(container) };
}
function scene() {
  return {
    kind: 'eats',
    state: 'active',
    tripId: 'workflow',
    delivery: {
      orderId: 'order',
      workflowId: 'workflow',
      storeName: 'Restaurant',
      displayId: '#123',
      stage: 'preparing',
      statusTitle: 'Preparing your order',
      statusDetail: 'The restaurant is working on it.',
      progress: { current: 1, total: 5, animated: true, color: '#06c167' },
      eta: { display: '6:26–6:53 PM', detail: 'Latest arrival 6:53 PM' },
      items: [{ title: 'Risotto', quantity: 1 }],
      total: '$92.60',
      dropoff: {
        address: '519 Santa Clara Ave',
        instructions: 'Leave at door',
      },
    },
    deliveryEvents: [{ id: 'event1', type: 'preparing' }],
  };
}
function nodes(root) {
  return [root, ...root.children.flatMap(nodes)];
}
function byClass(root, name) {
  return nodes(root).filter((node) =>
    node.className?.split(' ').includes(name),
  );
}

test('delivery panel uses native ETA, status, item and address text and preserves details expansion', () => {
  const { view, container } = fixture();
  const input = scene();
  view.render(input);
  assert.equal(container.hidden, false);
  assert.equal(
    byClass(container, 'delivery-eta')[0].textContent,
    '6:26–6:53 PM',
  );
  assert.equal(
    byClass(container, 'delivery-title')[0].textContent,
    'Preparing your order',
  );
  assert.equal(
    byClass(container, 'delivery-address')[0].textContent,
    '519 Santa Clara Ave',
  );
  assert.equal(container.querySelector('li').textContent, '1 × Risotto');
  const segments = byClass(container, 'delivery-progress-segment');
  assert.deepEqual(
    segments.map((node) => node.dataset.state),
    ['complete', 'active', 'pending', 'pending', 'pending'],
  );
  container.querySelector('details').open = true;
  input.delivery.statusDetail = 'Still preparing';
  view.render(input);
  assert.equal(container.querySelector('details').open, true);
});

test('does not invent estimates, inflate progress or render untrusted markup and images', () => {
  const input = scene();
  input.delivery.eta = null;
  input.delivery.statusTitle = '<img src=x onerror=alert(1)>';
  input.delivery.progress = {
    total: Infinity,
    current: -900,
    color: 'url(https://bad.example)',
  };
  input.delivery.courier = {
    name: 'Courier',
    photoUrl: 'https://uber.com.evil.example/p.jpg',
  };
  const { view, container } = fixture();
  view.render(input);
  assert.equal(byClass(container, 'delivery-eta').length, 0);
  assert.equal(
    byClass(container, 'delivery-title')[0].textContent,
    input.delivery.statusTitle,
  );
  assert.equal(byClass(container, 'delivery-progress').length, 0);
  assert.equal(container.querySelector('img'), undefined);
  assert.equal(deliveryPresentation(input).progress.color, null);
});

test('emits each delivery event once even when order presentation has not changed', () => {
  const { view, container } = fixture();
  const input = scene();
  view.render(input);
  view.render(input);
  input.deliveryEvents.push({ id: 'event2', type: 'arrival' });
  view.render(input);
  assert.deepEqual(
    container.events
      .filter((event) => event.type === 'deliveryevent')
      .map((event) => event.detail.id),
    ['event1', 'event2'],
  );
  assert.equal(
    container.events.filter((event) => event.type === 'deliverychange').length,
    1,
  );
  input.delivery.stage = 'en_route';
  view.render(input);
  assert.equal(
    container.events.filter((event) => event.type === 'deliverychange').at(-1)
      .detail.stage,
    'en_route',
  );
});

test('completed delivery stops progress animation and ride scenes remove delivery information', () => {
  const { view, container } = fixture();
  const input = scene();
  input.state = 'ended';
  input.delivery.progress.current = 5;
  view.render(input);
  assert.ok(
    byClass(container, 'delivery-progress-segment').every(
      (node) => node.dataset.state === 'complete',
    ),
  );
  view.render({ kind: 'ride', state: 'active', tripId: 'ride' });
  assert.equal(container.hidden, true);
  assert.equal(container.children.length, 0);
  assert.equal(deliveryPresentation({ kind: 'ride' }), null);
});

test('camera reserves the delivery panel in portrait and landscape without excessive bottom padding', () => {
  assert.deepEqual(
    deliveryMapPadding({
      width: 390,
      height: 844,
      panelWidth: 358,
      panelHeight: 280,
    }),
    { top: 64, right: 24, bottom: 320, left: 24 },
  );
  assert.deepEqual(
    deliveryMapPadding({
      width: 844,
      height: 390,
      panelWidth: 320,
      panelHeight: 358,
    }),
    { top: 24, right: 24, bottom: 24, left: 360 },
  );
  assert.ok(
    deliveryMapPadding({
      width: 360,
      height: 300,
      panelWidth: 328,
      panelHeight: 500,
    }).bottom <= 180,
  );
});

function bridgeFixture(frameOrigins = ['https://client.example']) {
  const messages = [];
  const listeners = new Map();
  const win = {
    parent: {
      postMessage: (packet, origin) => messages.push({ packet, origin }),
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    location: { hash: '#key=never-expose-this-value' },
  };
  const bridge = createDeliveryBridge({ window: win, frameOrigins });
  const message = (
    type,
    { origin = 'https://client.example', source = win.parent } = {},
  ) => listeners.get('message')?.({ source, origin, data: { type } });
  return { bridge, win, messages, message, listeners };
}

test('iframe bridge requires the configured exact parent origin and parent window before sharing a scene', () => {
  const { bridge, messages, message } = bridgeFixture();
  const input = scene();
  bridge.update(input);
  assert.deepEqual(
    messages.map((m) => m.packet),
    [{ type: 'uber-eats:ready' }],
  );
  messages.length = 0;
  message('uber-eats:subscribe', { source: {} });
  message('uber-eats:subscribe', {
    origin: 'https://client.example.evil.test',
  });
  message('uber-eats:subscribe', { origin: 'http://client.example' });
  message('uber-eats:subscribe', { origin: 'null' });
  assert.equal(messages.length, 0);
  message('uber-eats:subscribe');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].origin, 'https://client.example');
  assert.deepEqual(messages[0].packet, {
    type: 'uber-eats:snapshot',
    scene: input,
  });
  assert.doesNotMatch(JSON.stringify(messages), /never-expose|#key=/);
  input.delivery.storeName = 'Caller mutation';
  assert.equal(messages[0].packet.scene.delivery.storeName, 'Restaurant');
});

test('empty, wildcard, opaque and non-origin iframe allowlists share no data', () => {
  for (const origins of [
    [],
    ['*'],
    ['null'],
    ['https://client.example/path'],
    ['https://client.example/'],
  ]) {
    const { bridge, messages, message } = bridgeFixture(origins);
    bridge.update(scene());
    message('uber-eats:subscribe');
    assert.equal(messages.length, 0);
  }
});

test('iframe bridge deduplicates delivery hooks and unsubscribe stops events without affecting the iframe', () => {
  const { bridge, messages, message } = bridgeFixture();
  const input = scene();
  bridge.update(input);
  messages.length = 0;
  message('uber-eats:subscribe');
  bridge.update(input);
  input.deliveryEvents.push({ id: 'event2', type: 'arrival' });
  bridge.update(input);
  bridge.update(input);
  assert.deepEqual(
    messages.map(({ packet }) => packet.type),
    ['uber-eats:snapshot', 'uber-eats:delivery'],
  );
  assert.equal(messages[1].packet.event.id, 'event2');
  message('uber-eats:unsubscribe');
  input.deliveryEvents.push({ id: 'event3', type: 'delivered' });
  bridge.update(input);
  assert.equal(messages.length, 2);
  message('uber-eats:subscribe');
  assert.equal(messages.at(-1).packet.scene.deliveryEvents.at(-1).id, 'event3');
});

test('iframe policy changes and viewer closure revoke subscriptions and clear private scenes', () => {
  const { bridge, messages, message, listeners } = bridgeFixture();
  bridge.update(scene());
  message('uber-eats:subscribe');
  bridge.update(scene(), []);
  assert.deepEqual(messages.at(-1).packet, { type: 'uber-eats:unavailable' });
  const revokedCount = messages.length;
  message('uber-eats:subscribe');
  assert.equal(messages.length, revokedCount);
  bridge.update(scene(), ['https://client.example']);
  message('uber-eats:subscribe');
  bridge.close();
  assert.deepEqual(messages.at(-1).packet, { type: 'uber-eats:unavailable' });
  assert.equal(listeners.has('message'), false);
  const closedCount = messages.length;
  bridge.update(scene(), ['https://client.example']);
  message('uber-eats:subscribe');
  assert.equal(messages.length, closedCount);
});
