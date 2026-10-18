import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eatsCartItem,
  eatsCreateDraftRequest,
  eatsAddItemsRequest,
  eatsUpdateItemRequest,
  eatsRemoveItemsRequest,
  eatsUpdateDraftRequest,
  eatsCheckoutPresentationRequest,
  eatsPlaceOrderRequest,
  eatsInteger64,
  eatsWireInteger64,
  normalizeEatsMoney,
  assertEatsValidation,
  normalizeEatsDraft,
  normalizeEatsCheckout,
  normalizeEatsOrderResult,
} from '../src/eats/cart-protocol.mjs';

const id = (number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const eaterId = id(1),
  storeId = id(2),
  cartId = id(3),
  draftId = id(4),
  lineId = id(5),
  itemId = id(6);
const identity = { eaterId, storeId, cartId, draftId };
const modifier = [
  {
    uuid: id(7),
    childOptions: {
      options: [
        {
          uuid: id(8),
          quantity: 1,
          customizationV2List: [
            {
              uuid: id(9),
              childOptions: { options: [{ uuid: id(10), quantity: 2 }] },
            },
          ],
        },
      ],
    },
  },
];
const item = () =>
  eatsCartItem({
    lineId,
    itemId,
    storeId,
    sectionId: id(11),
    quantity: 2,
    customizations: modifier,
  });
const address = {
  latitude: 34,
  longitude: -118,
  address: { address1: 'Example Street' },
};
const long = (low, high = 0) => ({ high, low, unsigned: false });
const money = (amountE5, formattedValue = '$20.00') => ({
  value: { amountE5, currencyCode: 'USD' },
  formattedValue,
});

test('native create/add/update/remove preserve separate menu and cart line identity and recursive modifiers', () => {
  const initial = eatsCreateDraftRequest({
    ...identity,
    items: [item()],
    deliveryAddress: address,
    diningMode: 'DELIVERY',
  });
  assert.deepEqual(initial.request.shoppingCart, {
    items: [{ ...item(), consumerUUID: eaterId }],
  });
  assert.equal(initial.request.checkMultipleDraftOrdersCap, true);
  assert.equal(initial.request.useCredits, false);
  const add = eatsAddItemsRequest({ ...identity, items: [item()] });
  assert.equal(add.request.draftOrderUUID, draftId);
  assert.equal(add.request.addItemsToCartRequest.items[0].skuUUID, itemId);
  assert.equal(
    add.request.addItemsToCartRequest.items[0].shoppingCartItemUUID,
    lineId,
  );
  const update = eatsUpdateItemRequest({
    ...identity,
    lineId,
    customizations: modifier,
    quantity: 3,
  });
  assert.deepEqual(
    update.request.updateItemInCartRequest.customizations,
    modifier,
  );
  assert.equal(
    update.request.updateItemInCartRequest.customizationV2s,
    undefined,
  );
  assert.deepEqual(
    eatsRemoveItemsRequest({ ...identity, lineIds: [lineId] }).request
      .removeItemsFromCartRequest.shoppingCartItemUUIDs,
    [lineId],
  );
  modifier[0].childOptions.options[0].quantity = 9;
  assert.equal(
    initial.request.shoppingCart.items[0].customizationV2s[0].childOptions
      .options[0].quantity,
    1,
  );
  modifier[0].childOptions.options[0].quantity = 1;
});

test('request boundaries reject wrong stores, duplicate lines, invalid counts and missing delivery location', () => {
  assert.throws(
    () => eatsCreateDraftRequest({ ...identity, items: [item()] }),
    /requires an address/,
  );
  assert.throws(
    () =>
      eatsAddItemsRequest({ ...identity, storeId: id(99), items: [item()] }),
    /selected store/,
  );
  assert.throws(
    () => eatsAddItemsRequest({ ...identity, items: [item(), item()] }),
    /unique/,
  );
  assert.throws(
    () => eatsCartItem({ lineId, itemId, storeId, quantity: 1.5 }),
    /integer/,
  );
  assert.throws(
    () => eatsUpdateItemRequest({ ...identity, lineId, quantity: 0 }),
    /positive/,
  );
  assert.throws(
    () => eatsRemoveItemsRequest({ ...identity, lineIds: [] }),
    /array/,
  );
  assert.throws(
    () => eatsRemoveItemsRequest({ ...identity, lineIds: [lineId, lineId] }),
    /unique/,
  );
  assert.doesNotThrow(() =>
    eatsCreateDraftRequest({
      ...identity,
      items: [item()],
      diningMode: 'PICKUP',
    }),
  );
});

test('customization recursion is bounded and rejects fractional quantities', () => {
  assert.throws(
    () =>
      eatsCartItem({
        lineId,
        itemId,
        storeId,
        customizations: [
          {
            uuid: id(7),
            childOptions: { options: [{ uuid: id(8), quantity: 0.5 }] },
          },
        ],
      }),
    /integer/,
  );
  let tree = [];
  for (let i = 0; i < 15; i++)
    tree = [
      {
        uuid: id(7),
        childOptions: {
          options: [{ uuid: id(8), quantity: 1, customizationV2List: tree }],
        },
      },
    ];
  assert.throws(
    () => eatsCartItem({ lineId, itemId, storeId, customizations: tree }),
    /nesting/,
  );
});

test('draft settings use explicit minor-unit tip semantics despite the native field name', () => {
  const request = eatsUpdateDraftRequest({
    draftId,
    tipAmountMinor: '0',
    tipCurrencyCode: 'USD',
    useCredits: false,
    singleUseItems: false,
    interactionType: 'DOOR_TO_DOOR',
  }).request;
  assert.deepEqual(request.upfrontTipOption, {
    amount: { amountE5: long(0), currencyCode: 'USD' },
  });
  assert.equal(request.useCredits, false);
  assert.equal(request.isSingleUseItemsIncluded, false);
  assert.equal(request.upfrontTipOption.percent, undefined);
  assert.throws(
    () =>
      eatsUpdateDraftRequest({
        draftId,
        tipAmount: { amount: 125, currencyCode: 'USD' },
      }),
    /tipAmountMinor/,
  );
  assert.throws(
    () =>
      eatsUpdateDraftRequest({
        draftId,
        tipAmountMinor: '-1',
        tipCurrencyCode: 'USD',
      }),
    /nonnegative/,
  );
  assert.throws(
    () => eatsUpdateDraftRequest({ draftId, interactionType: 'MEET_AT_DOOR' }),
    /Unsupported/,
  );
});

test('checkout presentation explicitly requests authoritative total and mandatory review data', () => {
  const request = eatsCheckoutPresentationRequest({ draftId }).request;
  assert.equal(request.draftOrderUUID, draftId);
  for (const name of [
    'TOTAL',
    'FARE_BREAKDOWN',
    'ORDER_CONFIRMATIONS',
    'RESTRICTED_ITEMS',
    'UPFRONT_TIPPING',
  ])
    assert.ok(request.payloadTypes.includes(name));
  assert.equal(request.pageType, undefined);
  const place = eatsPlaceOrderRequest({
    draftId,
    singleUseItems: false,
  }).request;
  assert.deepEqual(place.draftOrderUUIDs, [draftId]);
  for (const name of [
    'bypassAuthDeclineForTrustedUser',
    'doArrearBypass',
    'deviceData',
  ])
    assert.equal(place[name], undefined);
  assert.equal(place.shareCPFWithRestaurant, false);
  assert.equal(place.clientAttestationData, '');
});

test('64-bit E5 money preserves precision, signed discounts and unsigned high bits', () => {
  assert.equal(eatsInteger64(long(-49000, -1)), '-49000');
  assert.equal(
    eatsInteger64({ high: 2097152, low: 1, unsigned: false }),
    '9007199254740993',
  );
  assert.equal(
    eatsInteger64({ high: -1, low: -1, unsigned: true }),
    '18446744073709551615',
  );
  assert.equal(eatsInteger64('000123'), '123');
  assert.throws(() => eatsInteger64(9007199254740992), /invalid/);
  assert.throws(() => eatsInteger64({ high: 0, low: 0 }), /invalid/);
  assert.deepEqual(normalizeEatsMoney(money(long(2000000))), {
    amountE5: '2000000',
    currency: 'USD',
    formatted: '$20.00',
  });
});

test('native signed wire Long encodes both limbs without precision loss', () => {
  const cases = [
    ['0', { high: 0, low: 0, unsigned: false }],
    ['200000', { high: 0, low: 200000, unsigned: false }],
    ['2147483648', { high: 0, low: -2147483648, unsigned: false }],
    ['4294967296', { high: 1, low: 0, unsigned: false }],
    ['9007199254740993', { high: 2097152, low: 1, unsigned: false }],
    ['-1', { high: -1, low: -1, unsigned: false }],
    ['-4294967297', { high: -2, low: -1, unsigned: false }],
    ['9223372036854775807', { high: 2147483647, low: -1, unsigned: false }],
    ['-9223372036854775808', { high: -2147483648, low: 0, unsigned: false }],
  ];
  for (const [value, wire] of cases) {
    assert.deepEqual(eatsWireInteger64(value), wire);
    assert.equal(eatsInteger64(eatsWireInteger64(value)), value);
  }
  assert.throws(
    () => eatsWireInteger64('9223372036854775808'),
    /signed 64-bit/,
  );
  assert.throws(
    () => eatsWireInteger64('-9223372036854775809'),
    /signed 64-bit/,
  );
  assert.throws(() => eatsWireInteger64(9007199254740992), /invalid/);
  assert.deepEqual(
    eatsUpdateDraftRequest({
      draftId,
      tipAmountMinor: '200',
      tipCurrencyCode: 'USD',
    }).request.upfrontTipOption.amount,
    {
      amountE5: { high: 0, low: 200, unsigned: false },
      currencyCode: 'USD',
    },
  );
});

test('HTTP success with validation errors is never reported as an accepted cart', () => {
  assert.throws(
    () =>
      assertEatsValidation({
        validationErrors: [{ code: 'UNAVAILABLE_ITEM' }],
      }),
    { code: 'EATS_VALIDATION_REQUIRED' },
  );
  assert.throws(
    () =>
      assertEatsValidation({
        draftOrderPresentationResponse: {
          validationErrors: [{ code: 'PRICE_CHANGED' }],
        },
      }),
    { code: 'EATS_VALIDATION_REQUIRED' },
  );
  assert.throws(() => assertEatsValidation({ validationErrors: {} }), {
    code: 'EATS_RESPONSE_INVALID',
  });
});

test('draft response normalization preserves native modifiers without treating draft fare as checkout total', () => {
  const payload = {
    draftOrder: {
      uuid: draftId,
      eaterUUID: eaterId,
      restaurantUUID: storeId,
      shoppingCart: { cartUUID: cartId, items: [item()] },
      fare: { subtotal: money(long(1600000)) },
      state: 'ACTIVE',
    },
  };
  const result = normalizeEatsDraft(payload);
  assert.equal(result.draftId, draftId);
  assert.deepEqual(result.items[0].customizationV2s, modifier);
  assert.equal(result.total, undefined);
  assert.throws(() => normalizeEatsDraft({}), /no supported draft cart/);
});

test('checkout total is server total including tip, independently of pre-tip fare breakdown', () => {
  const payload = {
    checkoutPayloads: {
      total: { total: money(long(2000000)) },
      fareBreakdown: {
        charges: [{ title: { text: 'Total' }, value: { text: '$16.00' } }],
      },
      upfrontTipping: {
        payload: {
          options: [
            {
              amount: { amount: 400, currencyCode: 'USD' },
              percent: 2500,
              displayText: '25%',
              subtitleText: '$4.00',
              isSelectedTip: true,
            },
          ],
        },
      },
      orderConfirmations: { required: ['confirm'] },
      restrictedItems: { requiresAgeVerification: true },
      eta: { rangeText: '20–30 min' },
    },
    draftOrders: null,
    orderEntities: null,
    validationErrors: [],
  };
  const result = normalizeEatsCheckout(payload);
  assert.equal(result.total.amountE5, '2000000');
  assert.deepEqual(result.selectedTip, {
    amountMinor: 400,
    currency: 'USD',
    basisPoints: 2500,
    label: '25%',
    formatted: '$4.00',
  });
  assert.deepEqual(result.orderConfirmations, { required: ['confirm'] });
  assert.equal(result.restrictedItems.requiresAgeVerification, true);
  assert.throws(
    () =>
      normalizeEatsCheckout({
        checkoutPayloads: {
          fareBreakdown: payload.checkoutPayloads.fareBreakdown,
        },
      }),
    /currency/,
  );
});

test('custom selected tip is included and cannot hide a thousand-fold unit error', () => {
  const checkout = (amount, total) => ({
    checkoutPayloads: {
      total: { total: money(long(total)) },
      upfrontTipping: {
        payload: {
          options: [
            {
              amount: { amount: 150, currencyCode: 'USD' },
              isSelectedTip: false,
            },
          ],
          customTipOption: {
            amount: { amount, currencyCode: 'USD' },
            displayText: amount === 200 ? '$2.00' : '$2,000.00',
            isSelectedTip: true,
          },
        },
      },
    },
  });
  assert.deepEqual(normalizeEatsCheckout(checkout(200, 1200000)).selectedTip, {
    amountMinor: 200,
    currency: 'USD',
    label: '$2.00',
    formatted: '$2.00',
  });
  const oversized = normalizeEatsCheckout(checkout(200000, 201000000));
  assert.equal(oversized.selectedTip.amountMinor, 200000);
  assert.notEqual(oversized.selectedTip.amountMinor, 200);
  const ambiguous = checkout(200, 1200000);
  ambiguous.checkoutPayloads.upfrontTipping.payload.options[0].isSelectedTip = true;
  assert.throws(() => normalizeEatsCheckout(ambiguous), /multiple selected/);
  const invalid = checkout(200, 1200000);
  invalid.checkoutPayloads.upfrontTipping.payload.customTipOption.amount.currencyCode =
    'EUR';
  assert.throws(
    () => normalizeEatsCheckout(invalid),
    /invalid selected tip money/,
  );
});

test('checkout actions and missing order identity require reconciliation rather than blind retry', () => {
  assert.throws(
    () => normalizeEatsOrderResult({ draftOrder: { uuid: draftId } }),
    { code: 'EATS_ORDER_UNCERTAIN' },
  );
  assert.throws(
    () =>
      normalizeEatsOrderResult({ additionalPaymentInfo: { jobUuid: id(15) } }),
    { code: 'EATS_ORDER_UNCERTAIN' },
  );
  const result = normalizeEatsOrderResult({
    draftOrder: { uuid: draftId, workflowUUID: id(16), state: 'ORDERED' },
    additionalPaymentInfo: { checkoutActionParams: {} },
  });
  assert.equal(result.requiresPaymentAction, true);
  assert.equal(result.workflowId, id(16));
  assert.throws(
    () =>
      normalizeEatsOrderResult({
        draftOrder: { uuid: draftId, workflowUUID: id(16), state: 'UNORDERED' },
      }),
    { code: 'EATS_ORDER_UNCERTAIN' },
  );
});
