// Native EatsEdgeClient callers wrap these DTOs in { request: ... }.
// See docs/eats-protocol.md for source evidence and runtime coverage.
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = (value) => structuredClone(value);
const compact = (value) =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message, code = 'EATS_INVALID_ARGUMENT') {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function uuid(value, label) {
  if (typeof value !== 'string' || !uuidPattern.test(value))
    fail(`${label} must be a UUID`);
  return value;
}
function string(value, label, max = 2000) {
  if (typeof value !== 'string' || value.length > max)
    fail(`${label} must be a string of at most ${max} characters`);
  return value;
}
function quantity(value, label = 'Quantity', allowZero = false) {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > 2147483647
  )
    fail(
      `${label} must be a ${allowZero ? 'nonnegative' : 'positive'} 32-bit integer`,
    );
  return value;
}
function list(value, label, { empty = false, max = 100 } = {}) {
  if (!Array.isArray(value) || (!empty && !value.length) || value.length > max)
    fail(`${label} must be an array of ${empty ? '0' : '1'} to ${max} entries`);
  return value;
}
function bool(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}
function diningMode(value) {
  if (!['DELIVERY', 'PICKUP'].includes(value))
    fail('Dining mode must be DELIVERY or PICKUP');
  return value;
}
function interaction(value) {
  if (
    value !== undefined &&
    ![
      'CURBSIDE',
      'DOOR_TO_DOOR',
      'LEAVE_AT_DOOR',
      'LEAVE_INSIDE_BUILDING_DOOR',
      'LEAVE_IN_LOBBY',
      'MEET_IN_LOBBY',
      'LEAVE_AT_DROPOFF_AREA_DRONE',
      'MEET_OUTSIDE_AV',
    ].includes(value)
  )
    fail('Unsupported interaction type');
  return value;
}
function location(value) {
  if (
    !object(value) ||
    !Number.isFinite(value.latitude) ||
    Math.abs(value.latitude) > 90 ||
    !Number.isFinite(value.longitude) ||
    Math.abs(value.longitude) > 180
  )
    fail('Delivery address requires valid latitude and longitude');
  return compact({
    latitude: value.latitude,
    longitude: value.longitude,
    address: object(value.address) ? copy(value.address) : undefined,
    reference:
      value.reference === undefined
        ? undefined
        : string(value.reference, 'Address reference'),
    referenceType:
      value.referenceType === undefined
        ? undefined
        : string(value.referenceType, 'Address reference type'),
    verificationStatus:
      value.verificationStatus === undefined
        ? undefined
        : string(value.verificationStatus, 'Address verification status'),
  });
}

/** Native CustomizationV2 / OptionV2 recursion; do not flatten child selections. */
export function eatsCustomizations(values, depth = 0, budget = { nodes: 0 }) {
  if (depth > 12) fail('Customization nesting exceeds 12 levels');
  return list(values, 'Customizations', { empty: true }).map((entry) => {
    if (!object(entry) || ++budget.nodes > 1000)
      fail('Invalid or oversized customization tree');
    const options = list(
      entry.childOptions?.options ?? [],
      'Customization options',
      { empty: true },
    ).map((option) => {
      if (!object(option) || ++budget.nodes > 1000)
        fail('Invalid or oversized customization option');
      return compact({
        uuid: uuid(option.uuid, 'Option ID'),
        quantity: quantity(option.quantity, 'Option quantity', true),
        title:
          option.title === undefined
            ? undefined
            : string(option.title, 'Option title'),
        optionInstanceUUID:
          option.optionInstanceUUID === undefined
            ? undefined
            : uuid(option.optionInstanceUUID, 'Option instance ID'),
        defaultQuantity:
          option.defaultQuantity === undefined
            ? undefined
            : quantity(option.defaultQuantity, 'Default option quantity', true),
        clientChargedQuantity:
          option.clientChargedQuantity === undefined
            ? undefined
            : quantity(
                option.clientChargedQuantity,
                'Charged option quantity',
                true,
              ),
        customizationV2List:
          option.customizationV2List === undefined
            ? undefined
            : eatsCustomizations(option.customizationV2List, depth + 1, budget),
      });
    });
    return compact({
      uuid: uuid(entry.uuid, 'Customization ID'),
      title:
        entry.title === undefined
          ? undefined
          : string(entry.title, 'Customization title'),
      customizationInstanceUUID:
        entry.customizationInstanceUUID === undefined
          ? undefined
          : uuid(entry.customizationInstanceUUID, 'Customization instance ID'),
      minPermitted:
        entry.minPermitted === undefined
          ? undefined
          : quantity(entry.minPermitted, 'Minimum choices', true),
      maxPermitted:
        entry.maxPermitted === undefined
          ? undefined
          : quantity(entry.maxPermitted, 'Maximum choices', true),
      childOptions: { options },
    });
  });
}

export function eatsCartItem({
  lineId,
  itemId,
  storeId,
  sectionId,
  subsectionId,
  quantity: count = 1,
  customizations = [],
  specialInstructions,
  title,
  eaterId,
} = {}) {
  return compact({
    shoppingCartItemUUID: uuid(lineId, 'Cart line ID'),
    skuUUID: uuid(itemId, 'Menu item ID'),
    consumerUUID:
      eaterId === undefined ? undefined : uuid(eaterId, 'Item consumer ID'),
    storeUUID: uuid(storeId, 'Store ID'),
    quantity: quantity(count),
    sectionUUID:
      sectionId === undefined ? undefined : uuid(sectionId, 'Section ID'),
    subsectionUUID:
      subsectionId === undefined
        ? undefined
        : uuid(subsectionId, 'Subsection ID'),
    customizationV2s: eatsCustomizations(customizations),
    specialInstructions:
      specialInstructions === undefined
        ? undefined
        : string(specialInstructions, 'Special instructions'),
    title: title === undefined ? undefined : string(title, 'Item title'),
  });
}

function nativeItems(values, storeId, eaterId) {
  const seen = new Set();
  return list(values, 'Cart items').map((value) => {
    if (!object(value)) fail('Cart item must be an object');
    const item = eatsCartItem({
      lineId: value.shoppingCartItemUUID,
      itemId: value.skuUUID,
      storeId: value.storeUUID,
      sectionId: value.sectionUUID,
      subsectionId: value.subsectionUUID,
      quantity: value.quantity,
      customizations: value.customizationV2s ?? [],
      specialInstructions: value.specialInstructions,
      title: value.title,
      eaterId: value.consumerUUID ?? eaterId,
    });
    if (eaterId && item.consumerUUID !== eaterId)
      fail('Cart item consumer must match the authenticated eater');
    if (item.storeUUID !== storeId)
      fail('Cart items must belong to the selected store');
    if (seen.has(item.shoppingCartItemUUID))
      fail('Cart line IDs must be unique');
    seen.add(item.shoppingCartItemUUID);
    return item;
  });
}

export function eatsCreateDraftRequest({
  eaterId,
  storeId,
  items,
  deliveryAddress,
  diningMode: mode = 'DELIVERY',
  paymentProfileId,
  deliveryType,
} = {}) {
  const eater = uuid(eaterId, 'Eater ID');
  const store = uuid(storeId, 'Store ID');
  const dining = diningMode(mode);
  if (dining === 'DELIVERY' && deliveryAddress === undefined)
    fail('Delivery requires an address');
  if (deliveryType !== undefined && deliveryType !== 'ASAP')
    fail('Only ASAP delivery is supported');
  return {
    request: compact({
      eaterUUID: eater,
      checkMultipleDraftOrdersCap: true,
      useCredits: false,
      shoppingCart: {
        // Native new-cart flow sends items only. The server creates cartUUID,
        // participants, requester, storeInfo and state; sending an invented
        // persisted cart identity can select an invalid existing-cart path.
        items: nativeItems(items, store, eater),
      },
      deliveryAddress:
        deliveryAddress === undefined ? undefined : location(deliveryAddress),
      diningMode: dining,
      paymentProfileUUID:
        paymentProfileId === undefined
          ? undefined
          : uuid(paymentProfileId, 'Payment profile ID'),
      deliveryType,
    }),
  };
}

export function eatsAddItemsRequest({
  draftId,
  eaterId,
  cartId,
  storeId,
  items,
} = {}) {
  const store = uuid(storeId, 'Store ID');
  return {
    request: {
      draftOrderUUID: uuid(draftId, 'Draft ID'),
      addItemsToCartRequest: {
        cartUUID: uuid(cartId, 'Cart ID'),
        eaterUUID: uuid(eaterId, 'Eater ID'),
        items: nativeItems(items, store, uuid(eaterId, 'Eater ID')),
      },
    },
  };
}

export function eatsUpdateItemRequest({
  draftId,
  eaterId,
  cartId,
  storeId,
  lineId,
  quantity: count,
  customizations,
  specialInstructions,
} = {}) {
  if (
    count === undefined &&
    customizations === undefined &&
    specialInstructions === undefined
  )
    fail(
      'Supply quantity, customizations or special instructions to update a line',
    );
  return {
    request: {
      draftOrderUUID: uuid(draftId, 'Draft ID'),
      updateItemInCartRequest: compact({
        cartUUID: uuid(cartId, 'Cart ID'),
        eaterUUID: uuid(eaterId, 'Eater ID'),
        storeUUID: uuid(storeId, 'Store ID'),
        shoppingCartItemUUID: uuid(lineId, 'Cart line ID'),
        quantity: count === undefined ? undefined : quantity(count),
        // Native update DTO calls this customizations, while ShoppingCartItem uses customizationV2s.
        customizations:
          customizations === undefined
            ? undefined
            : eatsCustomizations(customizations),
        specialInstructions:
          specialInstructions === undefined
            ? undefined
            : string(specialInstructions, 'Special instructions'),
      }),
    },
  };
}

export function eatsRemoveItemsRequest({
  draftId,
  eaterId,
  cartId,
  storeId,
  lineIds,
} = {}) {
  const ids = list(lineIds, 'Cart line IDs').map((value) =>
    uuid(value, 'Cart line ID'),
  );
  if (new Set(ids).size !== ids.length) fail('Cart line IDs must be unique');
  return {
    request: {
      draftOrderUUID: uuid(draftId, 'Draft ID'),
      removeItemsFromCartRequest: {
        cartUUID: uuid(cartId, 'Cart ID'),
        eaterUUID: uuid(eaterId, 'Eater ID'),
        storeUUID: uuid(storeId, 'Store ID'),
        shoppingCartItemUUIDs: ids,
      },
    },
  };
}

export function eatsUpdateDraftRequest({
  draftId,
  deliveryAddress,
  diningMode: mode,
  paymentProfileId,
  storeInstructions,
  interactionType,
  tipAmount,
  tipAmountMinor,
  tipCurrencyCode,
  useCredits,
  singleUseItems,
} = {}) {
  let tip;
  if (tipAmount !== undefined)
    fail(
      'Use explicit tipAmountMinor and tipCurrencyCode; the native tip amountE5 field actually carries minor units',
    );
  if (tipAmountMinor !== undefined || tipCurrencyCode !== undefined) {
    if (
      typeof tipCurrencyCode !== 'string' ||
      !/^[A-Z]{3}$/.test(tipCurrencyCode)
    )
      fail('Minor-unit tip amount requires a currency code');
    const amount = eatsInteger64(tipAmountMinor);
    if (BigInt(amount) < 0n || BigInt(amount) > 9223372036854775807n)
      fail(
        'Tip amount must be a nonnegative signed 64-bit integer in minor units',
      );
    // Native g34.a.b copies TipOption.amount.amount (legacy minor units)
    // directly into CurrencyAmount.amountE5. The field name is misleading in
    // this request; checkout total.value.amountE5 still uses genuine E5 units.
    tip = {
      amountE5: eatsWireInteger64(amount),
      currencyCode: tipCurrencyCode,
    };
  }
  return {
    request: compact({
      draftOrderUUID: uuid(draftId, 'Draft ID'),
      deliveryAddress:
        deliveryAddress === undefined ? undefined : location(deliveryAddress),
      diningMode: mode === undefined ? undefined : diningMode(mode),
      paymentProfileUUID:
        paymentProfileId === undefined
          ? undefined
          : uuid(paymentProfileId, 'Payment profile ID'),
      storeInstructions:
        storeInstructions === undefined
          ? undefined
          : string(storeInstructions, 'Store instructions'),
      interactionType: interaction(interactionType),
      upfrontTipOption: tip === undefined ? undefined : { amount: tip },
      useCredits:
        useCredits === undefined ? undefined : bool(useCredits, 'Use credits'),
      isSingleUseItemsIncluded:
        singleUseItems === undefined
          ? undefined
          : bool(singleUseItems, 'Single use items'),
    }),
  };
}

// Valid native enums selected for this CLI's checkout review. This selection is a
// CLI design choice; native callers also select payloads based on active features.
export const EATS_CHECKOUT_PAYLOAD_TYPES = Object.freeze([
  'CART_ITEMS',
  'TOTAL',
  'FARE_BREAKDOWN',
  'LOCATION_INFO',
  'DINING_MODE',
  'ETA',
  'UPFRONT_TIPPING',
  'PAYMENT_PROFILES_ELIGIBILITY_PAYLOAD',
  'ORDER_CONFIRMATIONS',
  'RESTRICTED_ITEMS',
  'DISCLAIMERS',
  'PAYMENT_BAR_PAYLOAD',
  'ORDER_SUMMARY',
]);
export function eatsCheckoutPresentationRequest({
  draftId,
  locale = 'en-US',
} = {}) {
  return {
    request: {
      draftOrderUUID: uuid(draftId, 'Draft ID'),
      payloadTypes: [...EATS_CHECKOUT_PAYLOAD_TYPES],
      requestedLocale: string(locale, 'Locale', 80),
    },
  };
}

/** A purchase request. Call only after a fresh account/cart/price-bound approval. */
export function eatsPlaceOrderRequest({
  draftId,
  storeInstructions,
  singleUseItems,
  interactionType,
} = {}) {
  return {
    request: compact({
      draftOrderUUIDs: [uuid(draftId, 'Draft ID')],
      // Both are explicit native fallback values. Never fabricate an Android
      // attestation or silently enable any payment bypass flags.
      shareCPFWithRestaurant: false,
      clientAttestationData: '',
      storeInstructions:
        storeInstructions === undefined
          ? undefined
          : string(storeInstructions, 'Store instructions'),
      isSingleUseItemsIncluded:
        singleUseItems === undefined
          ? undefined
          : bool(singleUseItems, 'Single use items'),
      interactionType: interaction(interactionType),
    }),
  };
}

function body(value) {
  const result = object(value?.body) ? value.body : value;
  if (!object(result))
    fail('Uber Eats returned an invalid response', 'EATS_RESPONSE_INVALID');
  return result;
}

/** A HTTP success can contain native order validation errors. */
export function assertEatsValidation(payload) {
  const value = body(payload);
  for (const owner of [value, value.draftOrderPresentationResponse]) {
    if (
      !object(owner) ||
      owner.validationErrors === undefined ||
      owner.validationErrors === null
    )
      continue;
    if (!Array.isArray(owner.validationErrors))
      fail(
        'Uber Eats returned malformed validation errors',
        'EATS_RESPONSE_INVALID',
      );
    if (owner.validationErrors.length) {
      const error = new Error('Uber Eats requires cart or checkout changes');
      error.code = 'EATS_VALIDATION_REQUIRED';
      error.validationErrors = copy(owner.validationErrors);
      throw error;
    }
  }
  return value;
}

/** Exact protobuf Long / decimal integer conversion without float rounding. */
export function eatsInteger64(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value))
    return String(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value))
    return BigInt(value).toString();
  if (
    object(value) &&
    Number.isInteger(value.high) &&
    Number.isInteger(value.low) &&
    value.high >= -2147483648 &&
    value.high <= 4294967295 &&
    value.low >= -2147483648 &&
    value.low <= 4294967295 &&
    typeof value.unsigned === 'boolean'
  ) {
    const bits = (BigInt(value.high >>> 0) << 32n) | BigInt(value.low >>> 0);
    return (value.unsigned ? bits : BigInt.asIntN(64, bits)).toString();
  }
  fail(
    'Uber Eats returned an invalid 64-bit money amount',
    'EATS_RESPONSE_INVALID',
  );
}

/** Native endpoint JSON carries int64 as a signed Long object, not a string. */
export function eatsWireInteger64(value) {
  const integer = BigInt(eatsInteger64(value));
  if (integer < -9223372036854775808n || integer > 9223372036854775807n)
    fail('Wire integer must fit in a signed 64-bit value');
  return {
    high: Number(BigInt.asIntN(32, integer >> 32n)),
    low: Number(BigInt.asIntN(32, integer)),
    unsigned: false,
  };
}
export function normalizeEatsMoney(value) {
  if (
    !object(value) ||
    !object(value.value) ||
    typeof value.value.currencyCode !== 'string' ||
    !/^[A-Z]{3}$/.test(value.value.currencyCode)
  )
    fail('Uber Eats returned invalid currency data', 'EATS_RESPONSE_INVALID');
  return compact({
    amountE5: eatsInteger64(value.value.amountE5),
    currency: value.value.currencyCode,
    formatted:
      typeof value.formattedValue === 'string'
        ? value.formattedValue
        : undefined,
  });
}

export function normalizeEatsDraft(payload) {
  const value = assertEatsValidation(payload);
  const draft = object(value.draftOrder) ? value.draftOrder : value;
  if (!object(draft.shoppingCart) || !Array.isArray(draft.shoppingCart.items))
    fail('Uber Eats returned no supported draft cart', 'EATS_RESPONSE_INVALID');
  const cart = draft.shoppingCart;
  return compact({
    draftId: uuid(draft.uuid, 'Returned draft ID'),
    cartId: uuid(cart.cartUUID, 'Returned cart ID'),
    eaterId: uuid(draft.eaterUUID, 'Returned eater ID'),
    storeId: uuid(
      draft.restaurantUUID ?? cart.storeInfo?.storeUUID,
      'Returned store ID',
    ),
    state: draft.state,
    diningMode: draft.diningMode,
    deliveryAddress: copy(draft.deliveryAddress),
    paymentProfileId: draft.paymentProfileUUID,
    upfrontTipOption: copy(draft.upfrontTipOption),
    useCredits: draft.useCredits,
    storeInstructions: draft.storeInstructions,
    storeInstruction: draft.storeInstruction,
    deliveryInstruction: copy(draft.deliveryInstruction),
    interactionType: draft.interactionType,
    isSingleUseItemsIncluded: draft.isSingleUseItemsIncluded,
    deliveryType: draft.deliveryType,
    fulfillmentType: draft.fulfillmentType,
    targetDeliveryTimeRange: copy(draft.targetDeliveryTimeRange),
    dropoffInstructionUUID: draft.dropoffInstructionUUID,
    storeUUIDToCart: copy(draft.storeUUIDToCart),
    extraPaymentProfiles: copy(draft.extraPaymentProfiles),
    promotionOptions: copy(draft.promotionOptions),
    items: copy(cart.items),
    fare: copy(draft.fare),
    lastEditedAt: copy(draft.lastEditedAt),
    lastModifiedTimestamp: copy(cart.lastModifiedTimestamp),
  });
}

export function normalizeEatsCheckout(payload) {
  const value = assertEatsValidation(payload);
  if (!object(value.checkoutPayloads))
    fail(
      'Uber Eats returned no checkout presentation',
      'EATS_RESPONSE_INVALID',
    );
  const p = value.checkoutPayloads;
  const total = normalizeEatsMoney(p.total?.total);
  if (BigInt(total.amountE5) < 0n)
    fail(
      'Uber Eats returned a negative checkout total',
      'EATS_RESPONSE_INVALID',
    );
  const options = p.upfrontTipping?.payload?.options ?? [];
  if (!Array.isArray(options))
    fail('Uber Eats returned malformed tip options', 'EATS_RESPONSE_INVALID');
  const custom = p.upfrontTipping?.payload?.customTipOption;
  const selectedTips = [...options, ...(object(custom) ? [custom] : [])].filter(
    (option) => option?.isSelectedTip === true,
  );
  if (selectedTips.length > 1)
    fail('Uber Eats returned multiple selected tips', 'EATS_RESPONSE_INVALID');
  const selected = selectedTips[0];
  if (
    selected &&
    (!Number.isSafeInteger(selected.amount?.amount) ||
      selected.amount.amount < 0 ||
      selected.amount.currencyCode !== total.currency)
  )
    fail(
      'Uber Eats returned invalid selected tip money',
      'EATS_RESPONSE_INVALID',
    );
  const tip = selected
    ? compact({
        amountMinor: selected.amount?.amount,
        currency: selected.amount?.currencyCode,
        basisPoints: selected.percent,
        label: selected.displayText,
        formatted:
          selected.subtitleText ??
          (selected === custom ? selected.displayText : undefined),
      })
    : undefined;
  return compact({
    total,
    selectedTip: tip,
    fareBreakdown: copy(p.fareBreakdown),
    eta: copy(p.eta),
    location: copy(p.locationInfo),
    diningMode: copy(p.diningMode),
    paymentEligibility: copy(p.paymentProfilesEligibility),
    paymentBar: copy(p.paymentBarPayload),
    paymentAuthInfo: copy(p.total.paymentAuthInfoList),
    orderConfirmations: copy(p.orderConfirmations),
    restrictedItems: copy(p.restrictedItems),
    disclaimers: copy(p.disclaimers),
    orderSummary: copy(p.orderSummary),
    cartItems: copy(p.cartItems),
    drafts: copy(value.draftOrders),
    orderEntities: copy(value.orderEntities),
    presentationPages: copy(value.presentationPages),
  });
}

/** Extra payment actions do not establish a completed order. Never retry blindly. */
export function normalizeEatsOrderResult(payload) {
  const value = assertEatsValidation(payload);
  const draft = value.draftOrder;
  if (!object(draft))
    fail(
      'No order identity returned; check order status before retrying',
      'EATS_ORDER_UNCERTAIN',
    );
  if (draft.state !== 'ORDERED')
    fail(
      'Uber did not confirm an ordered state; check order status before retrying',
      'EATS_ORDER_UNCERTAIN',
    );
  const result = compact({
    draftId: uuid(draft.uuid, 'Returned draft ID'),
    orderId:
      draft.orderUUID === undefined
        ? undefined
        : uuid(draft.orderUUID, 'Returned order ID'),
    workflowId:
      draft.workflowUUID === undefined
        ? undefined
        : uuid(draft.workflowUUID, 'Returned workflow ID'),
    state: draft.state,
    requiresPaymentAction: object(value.additionalPaymentInfo),
  });
  if (!result.orderId && !result.workflowId)
    fail(
      'No order identity returned; check order status before retrying',
      'EATS_ORDER_UNCERTAIN',
    );
  return result;
}
