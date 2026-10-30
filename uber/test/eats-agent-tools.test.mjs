import test from 'node:test';
import assert from 'node:assert/strict';
import { backend, id } from '../eval/agent-tools/backend.mjs';
import { runEatsTool } from '../src/eats/tool-dispatch.mjs';
import { eatsAgentView } from '../src/eats/agent-view.mjs';
const choice = (n, options) => ({ uuid: id(n), childOptions: { options } });
const option = (n, quantity = 1, children = []) => ({
  uuid: id(n),
  quantity,
  customizationV2List: children,
});
const call = (f, name, args) => runEatsTool(name, args, { execute: f.execute });

test('structured native choices create a cart, change to three total and retain nested choices/instructions', async () => {
  const f = backend();
  const detail = await call(f, 'eats_menu', {
    storeId: id(2),
    itemId: id(11),
    sectionId: id(3),
    near: '34,-118',
    mode: 'pickup',
  });
  assert.equal(detail.standardSelectionsVerified, true);
  assert.equal(detail.itemDetail, undefined);
  const line = {
    ...detail.cartItem,
    quantity: 2,
    specialInstructions: 'Extra hot',
    customizationV2s: [
      choice(30, [option(32)]),
      choice(34, [option(36, 1, [choice(40, [option(42)])])]),
      choice(37, [option(38, 2)]),
    ],
  };
  const created = await call(f, 'eats_cart', {
    action: 'create',
    request: {
      storeId: id(2),
      diningMode: 'pickup',
      deliveryAddress: f.address,
      items: [line],
    },
  });
  const before = structuredClone(created.cart.items[0]);
  const changed = await call(f, 'eats_cart', {
    action: 'update',
    draftId: created.cart.draftId,
    lineId: before.shoppingCartItemUUID,
    request: { quantity: 3 },
  });
  assert.equal(changed.cart.items[0].quantity, 3);
  assert.deepEqual(
    changed.cart.items[0].customizationV2s,
    before.customizationV2s,
  );
  assert.equal(changed.cart.items[0].specialInstructions, 'Extra hot');
  assert.equal(f.drafts.length, 1);
  assert.equal(
    f.calls.some((c) => c.endpoint.includes('checkout-orders-by-draft-orders')),
    false,
  );
});
test('simulated checkout preserves the explicit decimal tip and reports a server total without buying', async () => {
  const f = backend();
  const detail = await call(f, 'eats_menu', {
    storeId: id(2),
    itemId: id(10),
    sectionId: id(3),
    near: '34,-118',
  });
  const created = await call(f, 'eats_cart', {
    action: 'create',
    request: {
      storeId: id(2),
      diningMode: 'delivery',
      deliveryAddress: f.address,
      items: [detail.cartItem],
    },
  });
  const plan = await call(f, 'eats_checkout', {
    draftId: created.cart.draftId,
    tipAmount: '2.50',
  });
  assert.equal(plan.status, 'confirmation_required');
  assert.equal(plan.total.formatted, '$14.00');
  assert.equal(plan.tip.amountE5, '250000');
  assert.equal(
    f.calls.some((c) => c.endpoint.includes('checkout-orders-by-draft-orders')),
    false,
  );
});
test('unknown accepted addition is inspected via its actual injected journal without repeating or discarding', async () => {
  const f = backend({ unknownCreate: true });
  const detail = await call(f, 'eats_menu', {
    storeId: id(2),
    itemId: id(10),
    sectionId: id(3),
    near: '34,-118',
  });
  let failure;
  try {
    await call(f, 'eats_cart', {
      action: 'create',
      request: {
        storeId: id(2),
        diningMode: 'delivery',
        deliveryAddress: f.address,
        items: [detail.cartItem],
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, 'outcome_unknown');
  const result = await call(f, 'eats_operation', {
    operationId: failure.operationId,
  });
  assert.equal(result.state, 'unknown');
  assert.equal(f.writeCount, 1);
  assert.equal(f.drafts.length, 1);
});
test('missing required defaults never produce a supposedly standard cart template', () => {
  const result = eatsAgentView('menu', {
    itemId: id(10),
    sectionId: id(3),
    modifierGroups: [
      {
        groupId: id(20),
        name: 'Choose milk',
        minPermitted: 1,
        maxPermitted: 1,
        options: [
          {
            optionId: id(21),
            name: 'Oat',
            defaultQuantity: 0,
            childGroups: [],
          },
        ],
      },
    ],
  });
  assert.equal(result.standardSelectionsVerified, false);
  assert.equal(result.cartItem, undefined);
});

test('compact views retain every item, page cursor and nested option constraint without raw duplication', () => {
  const source = {
    restaurants: [
      {
        storeId: id(2),
        name: 'Harbor Kitchen',
        items: [
          {
            itemId: id(11),
            sectionId: id(3),
            name: 'Latte',
            fareInfo: { large: 'payload' },
          },
        ],
      },
    ],
    nextOffset: 5,
    pagination: { cursor: 'opaque' },
  };
  const result = eatsAgentView('search', source);
  assert.equal(result.restaurants[0].items[0].itemId, id(11));
  assert.equal(result.restaurants[0].items[0].fareInfo, undefined);
  assert.equal(result.nextOffset, 5);
  assert.deepEqual(result.pagination, source.pagination);
  assert.equal(result.orderPlaced, false);
  assert.equal(result.priceSource, 'menu_not_checkout');
});

test('sold-out defaults are never offered as a verified standard recipe', () => {
  const result = eatsAgentView('menu', {
    itemId: id(10),
    sectionId: id(3),
    modifierGroups: [
      {
        groupId: id(20),
        name: 'Milk',
        minPermitted: 1,
        maxPermitted: 1,
        options: [
          {
            optionId: id(21),
            name: 'Oat',
            defaultQuantity: 1,
            isSoldOut: true,
            childGroups: [],
          },
        ],
      },
    ],
  });
  assert.equal(result.standardSelectionsVerified, false);
  assert.equal(result.cartItem, undefined);
});

test('live Pi evaluation blocks every cart/checkout/order write before invoking the real CLI', async () => {
  const { default: extension } = await import(
    '../eval/agent-tools/pi-live-extension.mjs'
  );
  const tools = new Map();
  extension({ registerTool: (t) => tools.set(t.name, t), on() {} });
  for (const action of ['create', 'add', 'update', 'remove', 'discard']) {
    const result = await tools.get('eats_cart').execute('test', { action });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /EVALUATION_READ_ONLY/);
  }
  for (const [name, args] of [
    ['eats_checkout', {}],
    ['eats_order', { action: 'confirm' }],
    ['eats_order', { action: 'cancel' }],
    ['eats_track', { action: 'serve' }],
    ['eats_track', { action: 'stream' }],
  ]) {
    const result = await tools.get(name).execute('test', args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No mutation was submitted/);
  }
});

test('advanced profile preserves all seven original tool definitions byte for byte', async () => {
  const { createHash } = await import('node:crypto');
  const { legacyEatsTools, advancedEatsToolManifest } = await import(
    '../src/eats/tools.mjs'
  );
  assert.equal(
    createHash('sha256').update(JSON.stringify(legacyEatsTools)).digest('hex'),
    '1bc4408a3f588cb07adeb779d29288d50c9f576bafd078d6c09794dbe85b78d2',
  );
  assert.deepEqual(advancedEatsToolManifest.tools.slice(0, 7), legacyEatsTools);
});

test('agent item options retain all normalized prices, bounds and nested branches; raw remains reachable', async () => {
  const groups = [
    {
      groupId: 'milk',
      minPermitted: 1,
      maxPermitted: 1,
      options: [
        {
          optionId: 'oat',
          price: 125,
          quantity: 0,
          defaultQuantity: 1,
          minPermitted: 1,
          maxPermitted: 2,
          childGroups: [{ groupId: 'foam', options: [] }],
        },
      ],
    },
  ];
  const view = eatsAgentView('menu', {
    itemId: 'latte',
    modifierGroups: groups,
    itemDetail: { secretRaw: 'value' },
  });
  assert.deepEqual(view.modifierGroups, groups);
  assert.equal(view.itemDetail, undefined);
  const { eatsToolArguments } = await import('../src/eats/tool-dispatch.mjs');
  const { eatsTools } = await import('../src/eats/tools.mjs');
  for (const name of ['eats_search', 'eats_menu']) {
    assert.ok(
      eatsTools.find((t) => t.name === name).inputSchema.properties.raw,
    );
    const args = eatsToolArguments(name, { raw: true });
    assert.ok(args.includes('--raw'));
    assert.ok(!args.includes('--compact'));
  }
});

test('flat named choices compile fresh native nested options and a quantity-only edit preserves them', async () => {
  const f = backend();
  const d = await call(f, 'eats_menu', {
    storeId: id(2),
    itemId: id(11),
    sectionId: id(3),
    near: '34,-118',
    mode: 'pickup',
  });
  const created = await call(f, 'eats_cart', {
    action: 'create',
    storeId: id(2),
    diningMode: 'pickup',
    deliveryAddress: f.address,
    items: [
      {
        ...d.standardItem,
        quantity: 2,
        specialInstructions: 'Extra hot',
        choices: [
          { group: 'Size', option: 'Large 16 oz' },
          { group: 'Milk', option: 'Oat Milk' },
          { group: 'Foam', option: 'No foam' },
          { group: 'Extras', option: 'Espresso Shot', quantity: 2 },
        ],
      },
    ],
  });
  const line = created.cart.items[0];
  assert.equal(line.quantity, 2);
  assert.equal(
    line.customizationV2s[1].childOptions.options[0].customizationV2List[0]
      .childOptions.options[0].uuid,
    id(42),
  );
  assert.equal(line.customizationV2s[2].childOptions.options[0].quantity, 2);
  const updated = await call(f, 'eats_cart', {
    action: 'update',
    draftId: created.cart.draftId,
    lineId: line.shoppingCartItemUUID,
    quantity: 3,
  });
  assert.equal(updated.cart.items[0].quantity, 3);
  assert.deepEqual(
    updated.cart.items[0].customizationV2s,
    line.customizationV2s,
  );
  assert.equal(updated.cart.items[0].specialInstructions, 'Extra hot');
  await assert.rejects(
    call(f, 'eats_cart', {
      action: 'update',
      draftId: created.cart.draftId,
      quantity: 2,
      request: { quantity: 3 },
    }),
    /flat cart fields or request/,
  );
});

test('named unavailable choices and inactive child choices fail without any cart mutation', async () => {
  for (const [config, choices, pattern] of [
    [
      { unavailableOat: true },
      [{ group: 'Milk', option: 'Oat Milk' }],
      /unavailable/,
    ],
    [{}, [{ group: 'Foam', option: 'No foam' }], /unselected parent/],
    [{}, [{ group: 'Milk', option: 'Soy' }], /Unknown or ambiguous/],
    [
      {},
      [
        { group: 'Size', option: 'Large 16 oz' },
        { group: 'Size', option: 'Large 16 oz' },
      ],
      /Duplicate/,
    ],
  ]) {
    const f = backend(config);
    await assert.rejects(
      call(f, 'eats_cart', {
        action: 'create',
        storeId: id(2),
        diningMode: 'delivery',
        deliveryAddress: f.address,
        items: [{ itemId: id(11), sectionId: id(3), quantity: 1, choices }],
      }),
      pattern,
    );
    assert.equal(f.writeCount, 0);
    assert.equal(f.drafts.length, 0);
  }
});

test('ambiguous named groups require their full path, and native choices cannot be mixed with named choices', async () => {
  const { resolveEatsChoices } = await import('../src/eats/choices.mjs');
  const option = (name, childGroups = []) => ({
    optionId: name,
    name,
    defaultQuantity: 1,
    childGroups,
  });
  const group = (id, name, options) => ({ groupId: id, name, options });
  const detail = {
    modifierGroups: [
      group('milk', 'Milk', [
        option('Oat', [group('oat-foam', 'Foam', [option('None')])]),
        option('Whole', [group('whole-foam', 'Foam', [option('None')])]),
      ]),
    ],
  };
  assert.throws(
    () => resolveEatsChoices(detail, [{ group: 'Foam', option: 'None' }]),
    /ambiguous/,
  );
  const selected = resolveEatsChoices(detail, [
    { group: 'Milk', option: 'Oat' },
    { group: 'Foam', option: 'None', path: ['Milk', 'Oat', 'Foam'] },
  ]);
  assert.equal(
    selected[0].childOptions.options[0].customizationV2List[0].uuid,
    'oat-foam',
  );
  const f = backend();
  await assert.rejects(
    call(f, 'eats_cart', {
      action: 'create',
      storeId: id(2),
      diningMode: 'delivery',
      deliveryAddress: f.address,
      items: [
        {
          itemId: id(10),
          sectionId: id(3),
          quantity: 1,
          choices: [],
          customizationV2s: [],
        },
      ],
    }),
    /not both/,
  );
  assert.equal(f.writeCount, 0);
});

test('named paths distinguish repeated group IDs in separate active branches', async () => {
  const { resolveEatsChoices } = await import('../src/eats/choices.mjs');
  const branch = (name) => ({
    optionId: name,
    name,
    defaultQuantity: 1,
    childGroups: [
      {
        groupId: 'reused',
        name: 'Sauce',
        options: [
          { optionId: 'normal', name: 'Regular', defaultQuantity: 1 },
          { optionId: 'none', name: 'None', defaultQuantity: 0 },
        ],
      },
    ],
  });
  const detail = {
    modifierGroups: [
      {
        groupId: 'halves',
        name: 'Halves',
        options: [branch('Left'), branch('Right')],
      },
    ],
  };
  const result = resolveEatsChoices(detail, [
    { group: 'Sauce', option: 'None', path: ['Halves', 'Left', 'Sauce'] },
  ]);
  assert.equal(
    result[0].childOptions.options[0].customizationV2List[0].childOptions
      .options[0].uuid,
    'none',
  );
  assert.equal(
    result[0].childOptions.options[1].customizationV2List[0].childOptions
      .options[0].uuid,
    'normal',
  );
});

test('named nested paths accept exact ancestors as well as full paths and never ignore a wrong path', async () => {
  const f = backend();
  const detail = await call(f, 'eats_menu', {
    storeId: id(2),
    itemId: id(11),
    sectionId: id(3),
    near: '34,-118',
  });
  const { resolveEatsChoices } = await import('../src/eats/choices.mjs');
  const selections = (path) =>
    resolveEatsChoices(detail, [
      { group: 'Milk', option: 'Oat Milk' },
      { group: 'Foam', option: 'No foam', path },
    ]);
  assert.deepEqual(
    selections(['Milk', 'Oat Milk']),
    selections(['Milk', 'Oat Milk', 'Foam']),
  );
  assert.throws(
    () => selections(['Milk', 'Whole Milk']),
    /Unknown or ambiguous/,
  );
});
