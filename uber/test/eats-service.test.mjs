import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createEatsService,
  validateEatsSelections,
} from '../src/eats/service.mjs';
import { normalizeEatsItemDetail } from '../src/eats/discovery.mjs';
import { eatsInteger64 } from '../src/eats/cart-protocol.mjs';

const id = (number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const ids = {
  owner: id(1),
  draft: id(2),
  cart: id(3),
  store: id(4),
  item: id(5),
  section: id(6),
  line: id(7),
  payment: id(8),
  order: id(9),
  otherOwner: id(10),
};

function harness() {
  const state = new Map();
  const calls = [];
  const h = {
    state,
    calls,
    session: { userUUID: ids.owner },
    now: Date.now(),
    total: '1200000',
    activePayment: true,
    drafts: [],
    draft: {
      uuid: ids.draft,
      eaterUUID: ids.owner,
      restaurantUUID: ids.store,
      state: 'UNORDERED',
      diningMode: 'DELIVERY',
      useCredits: true,
      deliveryAddress: {
        latitude: 34,
        longitude: -118,
        address: { address1: 'Example address' },
      },
      paymentProfileUUID: ids.payment,
      upfrontTipOption: { amount: { amountE5: '0', currencyCode: 'USD' } },
      shoppingCart: {
        cartUUID: ids.cart,
        storeInfo: { storeUUID: ids.store },
        items: [
          {
            shoppingCartItemUUID: ids.line,
            skuUUID: ids.item,
            storeUUID: ids.store,
            sectionUUID: ids.section,
            quantity: 1,
            title: 'Coffee',
            customizationV2s: [],
          },
        ],
      },
    },
  };
  const checkout = () => ({
    checkoutPayloads: {
      total: {
        total: {
          value: { amountE5: h.total, currencyCode: 'USD' },
          formattedValue: '$12.00',
        },
      },
      upfrontTipping: {
        payload: {
          options: [],
          customTipOption: {
            isSelectedTip: true,
            amount: {
              amount: Number(
                eatsInteger64(h.draft.upfrontTipOption.amount.amountE5),
              ),
              currencyCode: 'USD',
            },
          },
        },
      },
    },
    draftOrders: [structuredClone(h.draft)],
  });
  h.send = async (endpoint, body, options = {}) => {
    calls.push({
      endpoint,
      body: structuredClone(body),
      options: structuredClone(options),
    });
    if (endpoint.endsWith('get-draft-order-by-uuid'))
      return { draftOrder: structuredClone(h.draft) };
    if (endpoint.endsWith('get-draft-orders-by-eater-uuid'))
      return { draftOrders: structuredClone(h.drafts) };
    if (endpoint.endsWith('checkout-mobile-presentation'))
      return h.onCheckout ? h.onCheckout(checkout) : checkout();
    if (endpoint === '/rt/payment/v3/payment-profiles')
      return {
        paymentProfiles: [
          {
            uuid: ids.payment,
            status: h.activePayment ? 'active' : 'inactive',
            isExpired: false,
            displayable: { displayName: 'Example card' },
          },
        ],
      };
    if (endpoint.endsWith('update-draft-order')) {
      h.draft.paymentProfileUUID = body.request.paymentProfileUUID;
      h.draft.upfrontTipOption = structuredClone(body.request.upfrontTipOption);
      return {};
    }
    if (endpoint === '/rt/eats/v1/eater-items')
      return {
        currencyInfo: { currencyCode: 'USD', currencyNumDigitsAfterDecimal: 2 },
        itemsMap: {
          [ids.item]: {
            uuid: ids.item,
            title: 'Coffee',
            sectionUuid: ids.section,
            customizationsList: [],
          },
        },
      };
    if (endpoint.endsWith('create-draft-order')) {
      if (h.cartFailure) throw h.cartFailure;
      h.draft.shoppingCart = {
        ...structuredClone(body.request.shoppingCart),
        cartUUID: ids.cart,
        storeInfo: { storeUUID: ids.store },
      };
      return { draftOrder: { uuid: ids.draft } };
    }
    if (endpoint.endsWith('add-items-to-draft-order')) {
      if (h.cartFailure) throw h.cartFailure;
      h.draft.shoppingCart.items.push(
        ...structuredClone(body.request.addItemsToCartRequest.items),
      );
      return {};
    }
    if (endpoint.endsWith('checkout-orders-by-draft-orders')) {
      if (h.purchaseFailure) throw h.purchaseFailure;
      return {
        draftOrder: { uuid: ids.draft, orderUUID: ids.order, state: 'ORDERED' },
      };
    }
    if (endpoint === '/rt/eats/v2/search')
      return {
        feed: { feedItems: [], storesMap: {} },
        reachedEndOfList: false,
      };
    if (endpoint.endsWith('/active-orders'))
      return { activeEaterOrdersMobileView: [] };
    throw new Error(`Unexpected test endpoint ${endpoint}`);
  };
  h.execute = createEatsService({
    operation: (callback) => callback({ session: h.session, send: h.send }),
    read: async (key) => structuredClone(state.get(key)),
    write: async (key, value) => {
      state.set(key, structuredClone(value));
      if (h.onWrite) await h.onWrite(key, value);
    },
    uuid: randomUUID,
    now: () => h.now,
  });
  h.prepare = () =>
    h.execute('checkout', { 'draft-id': ids.draft, 'tip-amount': '0' });
  h.confirm = (plan) =>
    h.execute('order', {
      action: 'confirm',
      'plan-id': plan.planId,
      confirm: true,
    });
  h.purchases = () =>
    calls.filter(({ endpoint }) =>
      endpoint.endsWith('checkout-orders-by-draft-orders'),
    );
  h.cartWrites = () =>
    calls.filter(({ endpoint }) =>
      /\/(create-draft-order|add-items-to-draft-order)$/.test(endpoint),
    );
  return h;
}

test('priced checkout only updates tip/payment and confirmation submits one reviewed order', async () => {
  const h = harness();
  const plan = await h.prepare();
  assert.equal(plan.status, 'confirmation_required');
  assert.equal(plan.total.amountE5, '1200000');
  assert.equal(plan.tip.amountE5, '0');
  assert.equal(h.purchases().length, 0);
  const result = await h.confirm(plan);
  assert.equal(result.orderId, ids.order);
  assert.equal(h.purchases().length, 1);
  assert.deepEqual(h.purchases()[0].body, {
    request: {
      draftOrderUUIDs: [ids.draft],
      shareCPFWithRestaurant: false,
      clientAttestationData: '',
    },
  });
  assert.equal(h.purchases()[0].options.readOnly, false);
  assert.ok(
    h.calls
      .filter(({ endpoint }) => endpoint === '/rt/payment/v3/payment-profiles')
      .every(({ options }) => options.method === 'GET'),
  );
  await h.confirm(plan);
  assert.equal(
    h.purchases().length,
    1,
    'accepted operation is returned from its journal',
  );
});

test('a requested two-dollar tip sends 200 native minor units despite the wire field being named amountE5', async () => {
  const h = harness();
  const plan = await h.execute('checkout', {
    'draft-id': ids.draft,
    'tip-amount': '2.00',
  });
  const update = h.calls.find(({ endpoint }) =>
    endpoint.endsWith('/update-draft-order'),
  );
  assert.equal(
    eatsInteger64(update.body.request.upfrontTipOption.amount.amountE5),
    '200',
  );
  assert.equal(update.body.request.upfrontTipOption.amount.currencyCode, 'USD');
  assert.equal(plan.status, 'confirmation_required');
  assert.equal(h.purchases().length, 0);
});

test('a mismatched server-selected custom tip blocks approval even when the draft echoes the request', async () => {
  const h = harness();
  h.onCheckout = (make) => {
    const response = make();
    response.checkoutPayloads.upfrontTipping.payload.customTipOption.amount.amount = 200000;
    return response;
  };
  await assert.rejects(
    h.execute('checkout', { 'draft-id': ids.draft, 'tip-amount': '2.00' }),
    { code: 'EATS_TIP_UNVERIFIED' },
  );
  assert.equal(
    [...h.state.keys()].some((key) => key.startsWith('plan-')),
    false,
  );
  assert.equal(h.purchases().length, 0);
});

test('fresh changes to price, cart, address, tip or payment prevent purchase', async (t) => {
  const changes = {
    price: (h) => {
      h.total = '1300000';
    },
    cart: (h) => {
      h.draft.shoppingCart.items[0].quantity = 2;
    },
    address: (h) => {
      h.draft.deliveryAddress.address.address1 = 'Different address';
    },
    tip: (h) => {
      h.draft.upfrontTipOption.amount.amountE5 = '100000';
    },
    payment: (h) => {
      h.draft.paymentProfileUUID = id(11);
    },
    credits: (h) => {
      h.draft.useCredits = false;
    },
    instructions: (h) => {
      h.draft.storeInstructions = 'Different instructions';
    },
    interaction: (h) => {
      h.draft.interactionType = 'LEAVE_AT_DOOR';
    },
    singleUseItems: (h) => {
      h.draft.isSingleUseItemsIncluded = true;
    },
  };
  for (const [label, change] of Object.entries(changes))
    await t.test(label, async () => {
      const h = harness();
      const plan = await h.prepare();
      change(h);
      await assert.rejects(
        h.confirm(plan),
        (error) =>
          error.code === 'EATS_PLAN_CHANGED' ||
          (label === 'tip' && error.code === 'EATS_TIP_UNVERIFIED'),
      );
      assert.equal(h.purchases().length, 0);
    });
});

test('unknown purchase outcome is journaled and a repeated confirmation never resubmits', async () => {
  const h = harness();
  const plan = await h.prepare();
  h.purchaseFailure = Object.assign(new Error('Socket closed after sending'), {
    code: 'ECONNRESET',
  });
  await assert.rejects(h.confirm(plan), { code: 'outcome_unknown' });
  assert.equal(h.state.get(`operation-${plan.operationId}`).state, 'unknown');
  await assert.rejects(h.confirm(plan), { code: 'outcome_unknown' });
  assert.equal(h.purchases().length, 1);
});

test('failure to persist a purchase journal prevents its network request', async () => {
  const h = harness();
  const plan = await h.prepare();
  h.onWrite = (key, record) => {
    if (
      key === `operation-${plan.operationId}` &&
      record.state === 'submitting'
    )
      throw new Error('Private journal storage is unavailable');
  };
  await assert.rejects(h.confirm(plan), /journal storage/);
  assert.equal(h.purchases().length, 0);
});

test('a changed presentation draft cannot slip past the earlier draft read with the same total', async () => {
  const h = harness();
  const plan = await h.prepare();
  h.onCheckout = (make) => {
    const response = make();
    response.draftOrders[0].shoppingCart.items[0].quantity = 2;
    return response;
  };
  await assert.rejects(h.confirm(plan), /changed|match|binding/i);
  assert.equal(h.purchases().length, 0);
});

test('an approval that expires during durable journal preparation cannot submit a purchase', async () => {
  const h = harness();
  const plan = await h.prepare();
  h.onWrite = (key, record) => {
    if (
      key === `operation-${plan.operationId}` &&
      record.state === 'submitting'
    )
      h.now = Date.parse(plan.expiresAt) + 1;
  };
  await assert.rejects(h.confirm(plan), /expired|outcome|repeat/i);
  assert.equal(h.purchases().length, 0);
});

test('cart creation recovers an accepted operation without generating another native request', async () => {
  const h = harness();
  const operationId = randomUUID();
  const values = {
    action: 'create',
    'operation-id': operationId,
    request: {
      storeId: ids.store,
      deliveryAddress: structuredClone(h.draft.deliveryAddress),
      items: [{ itemId: ids.item, sectionId: ids.section, quantity: 1 }],
    },
  };
  const first = await h.execute('cart', values);
  const calls = h.calls.length;
  const recovered = await h.execute('cart', values);
  assert.equal(first.operationId, operationId);
  assert.equal(recovered.operationId, operationId);
  assert.equal(h.cartWrites().length, 1);
  assert.equal(
    h.calls.length,
    calls,
    'recovery uses the stored operation before rebuilding or issuing reads',
  );
});

test('unknown cart additions are never sent again when recovering the original operation', async () => {
  const h = harness();
  const operationId = randomUUID();
  h.cartFailure = Object.assign(
    new Error('Socket closed after sending cart update'),
    { code: 'ECONNRESET' },
  );
  const values = {
    action: 'add',
    'operation-id': operationId,
    'draft-id': ids.draft,
    request: {
      items: [{ itemId: ids.item, sectionId: ids.section, quantity: 1 }],
    },
  };
  await assert.rejects(h.execute('cart', values), { code: 'outcome_unknown' });
  await assert.rejects(h.execute('cart', values), { code: 'outcome_unknown' });
  assert.equal(h.cartWrites().length, 1);
});

test('accepted cart operation cannot be reused for a changed selection or another account', async () => {
  const h = harness();
  const operationId = randomUUID();
  const values = {
    action: 'add',
    'operation-id': operationId,
    'draft-id': ids.draft,
    request: {
      items: [{ itemId: ids.item, sectionId: ids.section, quantity: 1 }],
    },
  };
  await h.execute('cart', values);
  const count = h.calls.length;
  const changed = structuredClone(values);
  changed.request.items[0].quantity = 2;
  await assert.rejects(
    h.execute('cart', changed),
    /different account or cart request/,
  );
  h.session.userUUID = ids.otherOwner;
  await assert.rejects(
    h.execute('cart', values),
    /different account or cart request/,
  );
  assert.equal(h.calls.length, count);
});

test('plan account ownership and fresh payment eligibility are checked before purchase', async (t) => {
  await t.test('changed account cannot use an approved plan', async () => {
    const h = harness();
    const plan = await h.prepare();
    h.session.userUUID = ids.otherOwner;
    const before = h.calls.length;
    await assert.rejects(h.confirm(plan), /another signed-in rider/);
    assert.equal(h.calls.length, before);
  });
  await t.test('payment disabled after review blocks checkout', async () => {
    const h = harness();
    const plan = await h.prepare();
    h.activePayment = false;
    await assert.rejects(h.confirm(plan), /active, unexpired payment/);
    assert.equal(h.purchases().length, 0);
  });
  await t.test('foreign draft cannot be read or modified', async () => {
    const h = harness();
    h.draft.eaterUUID = ids.otherOwner;
    await assert.rejects(
      h.execute('cart', { action: 'get', 'draft-id': ids.draft }),
      /different account/,
    );
    assert.equal(h.state.size, 0);
  });
});

test('checkout confirmation requirements and unretained tips prevent an approval plan', async (t) => {
  await t.test(
    'extra payment authentication is not implicitly approved',
    async () => {
      const h = harness();
      h.onCheckout = (make) => {
        const value = make();
        value.checkoutPayloads.total.paymentAuthInfoList = [
          { challenge: 'required' },
        ];
        return value;
      };
      await assert.rejects(h.prepare(), { code: 'EATS_ACTION_REQUIRED' });
      assert.equal(
        [...h.state.keys()].some((key) => key.startsWith('plan-')),
        false,
      );
      assert.equal(h.purchases().length, 0);
    },
  );
  await t.test(
    'unverified tip cannot silently become an approved total',
    async () => {
      const h = harness();
      h.onCheckout = (make) => {
        const value = make();
        value.draftOrders[0].upfrontTipOption.amount.amountE5 = '100000';
        return value;
      };
      await assert.rejects(h.prepare(), (error) =>
        ['EATS_TIP_UNVERIFIED', 'EATS_PLAN_CHANGED'].includes(error.code),
      );
      assert.equal(
        [...h.state.keys()].some((key) => key.startsWith('plan-')),
        false,
      );
    },
  );
});

test('search carries selected location in native headers and preserves requested page size', async () => {
  const h = harness();
  const result = await h.execute('search', {
    query: 'coffee',
    near: '34.1,-118.2',
    mode: 'pickup',
    offset: 20,
    limit: 10,
  });
  const call = h.calls[0];
  assert.deepEqual(call.body.pageInfo, { offset: 20, pageSize: 10 });
  assert.equal(call.body.diningMode, 'PICKUP');
  assert.equal(call.body.targetLocation.latitude, 34.1);
  assert.deepEqual(call.options.extraHeaders, {
    'x-uber-target-location-latitude': '34.1',
    'x-uber-target-location-longitude': '-118.2',
  });
  assert.equal(result.nextOffset, 30);
  assert.equal(h.state.size, 0);
});

test('creating a cart never replaces an existing unordered cart for the restaurant', async () => {
  const h = harness();
  h.drafts = [structuredClone(h.draft)];
  const original = structuredClone(h.draft);
  await assert.rejects(
    h.execute('cart', {
      action: 'create',
      request: {
        storeId: ids.store,
        deliveryAddress: original.deliveryAddress,
        items: [{ itemId: ids.item, sectionId: ids.section, quantity: 1 }],
      },
    }),
    { code: 'EATS_CART_EXISTS' },
  );
  assert.deepEqual(h.draft, original);
  assert.equal(h.cartWrites().length, 0);
  assert.equal(
    h.calls.some(({ endpoint }) => endpoint === '/rt/eats/v1/eater-items'),
    false,
  );
  assert.equal(h.state.size, 0);
});

test('required nested modifier groups remain required when their parent option is selected', () => {
  const group = id(20),
    option = id(21),
    childGroup = id(22),
    childOption = id(23);
  const detail = normalizeEatsItemDetail(
    {
      itemsMap: {
        [ids.item]: {
          uuid: ids.item,
          customizationsList: [
            {
              uuid: group,
              title: 'Milk',
              minPermitted: 1,
              maxPermitted: 1,
              optionsList: {
                options: [
                  {
                    uuid: option,
                    title: 'Whole',
                    maxPermitted: 1,
                    childCustomizationList: [
                      {
                        uuid: childGroup,
                        title: 'Temperature',
                        minPermitted: 1,
                        maxPermitted: 1,
                        optionsList: {
                          options: [
                            {
                              uuid: childOption,
                              title: 'Hot',
                              childCustomizationList: [],
                            },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    },
    ids.item,
  );
  assert.throws(() => validateEatsSelections(detail, []), /at least 1/);
  assert.throws(
    () =>
      validateEatsSelections(detail, [
        {
          uuid: group,
          childOptions: { options: [{ uuid: option, quantity: 1 }] },
        },
      ]),
    /Temperature/,
  );
  const selected = [
    {
      uuid: group,
      childOptions: {
        options: [
          {
            uuid: option,
            quantity: 1,
            customizationV2List: [
              {
                uuid: childGroup,
                childOptions: { options: [{ uuid: childOption, quantity: 1 }] },
              },
            ],
          },
        ],
      },
    },
  ];
  assert.doesNotThrow(() => validateEatsSelections(detail, selected));
  assert.throws(
    () => validateEatsSelections(detail, [...selected, ...selected]),
    /Duplicate/,
  );
  selected[0].childOptions.options[0].quantity = 2;
  assert.throws(
    () => validateEatsSelections(detail, selected),
    /Too many selections/,
  );
});

test('unavailable modifier groups and sold-out options cannot be selected', () => {
  const group = id(20),
    option = id(21);
  const native = {
    uuid: ids.item,
    customizationsList: [
      {
        uuid: group,
        title: 'Milk',
        isAvailable: false,
        minPermitted: 0,
        maxPermitted: 1,
        optionsList: {
          options: [
            {
              uuid: option,
              title: 'Whole',
              isSoldOut: false,
              childCustomizationList: [],
            },
          ],
        },
      },
    ],
  };
  const detail = normalizeEatsItemDetail(
    { itemsMap: { [ids.item]: native } },
    ids.item,
  );
  assert.equal(detail.modifierGroups[0].isAvailable, false);
  const selected = [
    { uuid: group, childOptions: { options: [{ uuid: option, quantity: 1 }] } },
  ];
  assert.throws(
    () => validateEatsSelections(detail, selected),
    /unavailable|sold out/i,
  );
  detail.modifierGroups[0].isAvailable = true;
  detail.modifierGroups[0].options[0].isSoldOut = true;
  assert.throws(
    () => validateEatsSelections(detail, selected),
    /unavailable|sold out/i,
  );
});

test('cancellation stays unavailable when the requested order is absent from active orders', async () => {
  const h = harness();
  await assert.rejects(
    h.execute('order', { action: 'cancel', 'order-id': ids.order }),
    { code: 'EATS_CANCELLATION_UNAVAILABLE' },
  );
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].endpoint.endsWith('/active-orders'));
});

test('zero tip requires the retained zero and equal native pre-tip/final totals when UI leaves options unselected', async () => {
  const h = harness();
  h.onCheckout = (create) => {
    const response = create();
    delete response.checkoutPayloads.upfrontTipping;
    response.checkoutPayloads.fareBreakdown = {
      charges: [
        {
          fareBreakdownChargeMetadata: {
            fareInfoID: 'eats_fare.presentation_total',
            analyticsInfo: [
              {
                fareInfoID: 'eats_fare.presentation_total',
                currencyAmount: { amountE5: h.total, currencyCode: 'USD' },
              },
            ],
          },
        },
      ],
    };
    return response;
  };
  const plan = await h.prepare();
  assert.equal(plan.tip.amountE5, '0');
  assert.equal(h.purchases().length, 0);
  const valid = h.onCheckout;
  h.onCheckout = (create) => {
    const response = valid(create);
    response.checkoutPayloads.fareBreakdown.charges[0].fareBreakdownChargeMetadata.analyticsInfo[0].currencyAmount.amountE5 =
      '1100000';
    return response;
  };
  await assert.rejects(h.prepare(), { code: 'EATS_TIP_UNVERIFIED' });
  assert.equal(h.purchases().length, 0);
});

test('advanced multi-participant or scheduled carts are rejected before checkout', async () => {
  for (const extra of [
    { businessDetails: { account: 'business' } },
    { targetDeliveryTimeRange: { date: '2030-01-01' } },
    {
      participantDetails: [
        { userUUID: ids.owner },
        { userUUID: ids.otherOwner },
      ],
    },
  ]) {
    const h = harness();
    Object.assign(h.draft, extra);
    await assert.rejects(h.prepare(), { code: 'EATS_CART_UNSUPPORTED' });
    assert.equal(h.purchases().length, 0);
  }
});

test('cart edits reject ignored fields and conflicting store selectors before mutation', async () => {
  const h = harness();
  await assert.rejects(
    h.execute('cart', {
      action: 'update',
      'draft-id': ids.draft,
      request: {
        lineId: ids.line,
        quantity: 2,
        deliveryAddress: { latitude: 0, longitude: 0 },
      },
    }),
    /unsupported fields/,
  );
  await assert.rejects(
    h.execute('cart', {
      action: 'update',
      'draft-id': ids.draft,
      'store-id': ids.otherOwner,
      request: { lineId: ids.line, quantity: 2 },
    }),
    /does not match/,
  );
  assert.equal(
    h.calls.filter((call) => call.options.readOnly === false).length,
    0,
  );
});
