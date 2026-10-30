// Deterministic native-contract backend. Never calls the network or buys food.
import { randomUUID } from 'node:crypto';
import { createEatsService } from '../../src/eats/service.mjs';
import { eatsInteger64 } from '../../src/eats/cart-protocol.mjs';
export const id = (n) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const copy = (v) => structuredClone(v);
const option = (
  n,
  title,
  defaultQuantity = 0,
  childCustomizationList = [],
) => ({
  uuid: id(n),
  title,
  defaultQuantity,
  minPermitted: 0,
  maxPermitted: 3,
  isAvailable: true,
  childCustomizationList,
});
const group = (n, title, options, minPermitted = 0, maxPermitted = 1) => ({
  uuid: id(n),
  title,
  minPermitted,
  maxPermitted,
  optionsList: { options },
});
const size = () =>
  group(
    30,
    'Size',
    [option(31, 'Small 8 oz', 1), option(32, 'Large 16 oz')],
    1,
  );
const foam = () =>
  group(40, 'Foam', [option(41, 'Regular foam', 1), option(42, 'No foam')], 1);
export function backend({
  unknownCreate = false,
  unavailableOat = false,
} = {}) {
  const f = {
    calls: [],
    records: new Map(),
    drafts: [],
    writeCount: 0,
    unknownCreate,
    unavailableOat,
  };
  const session = { userUUID: id(1) };
  f.address = {
    latitude: 34,
    longitude: -118,
    address: {
      address1: '100 Test Avenue',
      title: 'Home',
      subtitle: 'Los Angeles, CA',
    },
  };
  const products = [
    {
      uuid: id(10),
      title: 'Berry Banana Smoothie',
      price: 850,
      extraInfo: { text: '$8.50' },
      itemDescription:
        'Blueberries, banana, apple juice. Sweetness is not rated.',
      customizationsList: [
        group(
          50,
          'Size',
          [option(51, 'Regular 16 oz', 1), option(52, 'Large 24 oz')],
          1,
        ),
        group(
          53,
          'Sweetness',
          [
            option(54, 'Regular sweetener', 1),
            option(55, 'Light Sweetener'),
            option(56, 'No added sweetener'),
          ],
          1,
        ),
      ],
    },
    {
      uuid: id(11),
      title: 'Latte',
      price: 600,
      extraInfo: { text: '$6.00' },
      itemDescription: 'Espresso with a choice of milk.',
      customizationsList: [
        size(),
        group(
          34,
          'Milk',
          [option(35, 'Whole Milk', 1), option(36, 'Oat Milk', 0, [foam()])],
          1,
        ),
        group(37, 'Extras', [option(38, 'Espresso Shot')], 0, 3),
      ],
    },
    {
      uuid: id(12),
      title: 'Garden Burger',
      price: 1100,
      extraInfo: { text: '$11.00' },
      itemDescription:
        'Vegetable patty, lettuce, tomato and onions on a bun. Sauce is served on the burger.',
      customizationsList: [
        group(
          60,
          'Onions',
          [option(61, 'Regular onions', 1), option(62, 'No onions')],
          1,
        ),
      ],
    },
    {
      uuid: id(13),
      title: 'Fries',
      price: 400,
      extraInfo: { text: '$4.00' },
      itemDescription: 'Potato fries.',
      customizationsList: [
        group(
          70,
          'Seasoning',
          [option(71, 'Salt', 1), option(72, 'No salt')],
          1,
        ),
      ],
    },
  ].map((p) => ({
    ...p,
    storeUuid: id(2),
    sectionUuid: id(3),
    subsectionUuid: id(4),
    priceTagline: p.extraInfo,
    hasCustomizations: true,
    isAvailable: true,
  }));
  if (unavailableOat)
    products[1].customizationsList[1].optionsList.options[1].isSoldOut = true;
  f.products = products;
  const store = {
    uuid: id(2),
    title: 'Harbor Kitchen',
    isOrderable: true,
    rawRatingStats: { storeRatingScore: 4.8, ratingCount: 100 },
    location: { latitude: 34, longitude: -118 },
    sections: [{ uuid: id(3), title: 'All items' }],
    catalogSectionsMap: {
      [id(3)]: [
        {
          type: 'STANDARD_ITEMS',
          payload: {
            standardItemsPayload: {
              sectionUUID: id(3),
              title: 'All items',
              catalogItems: products,
            },
          },
        },
      ],
    },
  };
  const findDraft = (uuid) => {
    const draft = f.drafts.find((d) => d.uuid === uuid);
    if (!draft)
      throw Object.assign(new Error('Draft not found'), { status: 404 });
    return draft;
  };
  const price = (draft) =>
    draft.shoppingCart.items.reduce(
      (sum, line) =>
        sum +
        products.find((p) => p.uuid === line.skuUUID).price * line.quantity,
      0,
    );
  async function send(endpoint, body, options = {}) {
    f.calls.push({ endpoint, body: copy(body), options: copy(options) });
    if (/checkout-orders-by-draft-orders|fulfill-action/.test(endpoint))
      throw new Error('PURCHASE AND CANCELLATION DISABLED IN EVALUATION');
    if (endpoint.endsWith('get-draft-orders-by-eater-uuid'))
      return { draftOrders: copy(f.drafts) };
    if (endpoint.endsWith('get-delivery-bootstrap-context'))
      return { deliveryLocation: copy(f.address) };
    if (endpoint.endsWith('get-draft-order-by-uuid'))
      return { draftOrder: copy(findDraft(body.request.draftOrderUUID)) };
    if (endpoint === '/rt/eats/v2/search') {
      const query = body.userQuery.toLowerCase();
      const matched = products.filter((p) =>
        `${p.title} ${p.itemDescription} Harbor Kitchen`
          .toLowerCase()
          .includes(query),
      );
      return {
        feed: {
          storesMap: { [id(2)]: store },
          feedItems: matched.length
            ? [
                {
                  type: 'MINI_STORE_WITH_ITEMS',
                  payload: {
                    miniStoreWithItemsPayload: {
                      store: {
                        storeUuid: id(2),
                        title: { text: 'Harbor Kitchen' },
                        meta: [{ text: '15–25 min' }],
                      },
                      standardItemsPayload: { catalogItems: copy(matched) },
                    },
                  },
                },
              ]
            : [],
        },
        reachedEndOfList: true,
      };
    }
    if (endpoint.includes('/eater-store/')) return { store: copy(store) };
    if (endpoint === '/rt/eats/v1/eater-items')
      return {
        itemsMap: Object.fromEntries(
          body.request.itemUuids
            .filter((uuid) => products.some((p) => p.uuid === uuid))
            .map((uuid) => [uuid, copy(products.find((p) => p.uuid === uuid))]),
        ),
        currencyInfo: { currencyCode: 'USD', currencyNumDigitsAfterDecimal: 2 },
      };
    if (endpoint.endsWith('create-draft-order')) {
      f.writeCount++;
      const r = body.request;
      const draft = {
        uuid: id(100 + f.writeCount),
        eaterUUID: session.userUUID,
        restaurantUUID: r.shoppingCart.items[0].storeUUID,
        state: 'UNORDERED',
        diningMode: r.diningMode,
        deliveryAddress: copy(r.deliveryAddress),
        useCredits: false,
        paymentProfileUUID: id(5),
        upfrontTipOption: { amount: { amountE5: '0', currencyCode: 'USD' } },
        shoppingCart: {
          cartUUID: id(200 + f.writeCount),
          storeInfo: { storeUUID: id(2) },
          items: copy(r.shoppingCart.items),
        },
      };
      f.drafts.push(draft);
      if (unknownCreate)
        throw new Error('Lost creation response after the server accepted it');
      return { draftOrder: { uuid: draft.uuid } };
    }
    if (endpoint.endsWith('add-items-to-draft-order')) {
      f.writeCount++;
      findDraft(body.request.draftOrderUUID).shoppingCart.items.push(
        ...copy(body.request.addItemsToCartRequest.items),
      );
      return {};
    }
    if (endpoint.endsWith('update-item-in-draft-order')) {
      f.writeCount++;
      const r = body.request.updateItemInCartRequest;
      const line = findDraft(
        body.request.draftOrderUUID,
      ).shoppingCart.items.find(
        (i) => i.shoppingCartItemUUID === r.shoppingCartItemUUID,
      );
      if (!line) throw new Error('Line not found');
      if (r.quantity !== undefined) line.quantity = r.quantity;
      if (r.customizations !== undefined)
        line.customizationV2s = copy(r.customizations);
      if (r.specialInstructions !== undefined)
        line.specialInstructions = r.specialInstructions;
      return {};
    }
    if (endpoint.endsWith('remove-items-from-draft-order')) {
      f.writeCount++;
      const d = findDraft(body.request.draftOrderUUID);
      d.shoppingCart.items = d.shoppingCart.items.filter(
        (i) =>
          !body.request.removeItemsFromCartRequest.shoppingCartItemUUIDs.includes(
            i.shoppingCartItemUUID,
          ),
      );
      return {};
    }
    if (endpoint.endsWith('discard-draft-orders')) {
      f.writeCount++;
      f.drafts = f.drafts.filter(
        (d) => !body.request.draftOrderUUIDs.includes(d.uuid),
      );
      return {};
    }
    if (endpoint.endsWith('update-draft-order')) {
      f.writeCount++;
      const r = body.request,
        d = findDraft(r.draftOrderUUID);
      if (r.paymentProfileUUID) d.paymentProfileUUID = r.paymentProfileUUID;
      if (r.upfrontTipOption) d.upfrontTipOption = copy(r.upfrontTipOption);
      return {};
    }
    if (endpoint.endsWith('checkout-mobile-presentation')) {
      const d = findDraft(body.request.draftOrderUUID),
        tip = Number(eatsInteger64(d.upfrontTipOption.amount.amountE5)),
        total = price(d) + (d.diningMode === 'DELIVERY' ? 300 : 0) + tip;
      return {
        draftOrders: [copy(d)],
        checkoutPayloads: {
          total: {
            total: {
              value: { amountE5: String(total * 1000), currencyCode: 'USD' },
              formattedValue: '$' + (total / 100).toFixed(2),
            },
          },
          upfrontTipping: {
            payload: {
              options: [],
              customTipOption: {
                isSelectedTip: true,
                amount: { amount: tip, currencyCode: 'USD' },
              },
            },
          },
        },
      };
    }
    if (endpoint === '/rt/payment/v3/payment-profiles')
      return {
        paymentProfiles: [
          {
            uuid: id(5),
            status: 'active',
            last4: '4242',
            card: { last4: '4242', cardType: 'visa' },
          },
        ],
      };
    if (endpoint.endsWith('/active-orders'))
      return { activeEaterOrdersMobileView: [] };
    throw new Error('Unsupported fixture endpoint ' + endpoint);
  }
  const read = async (name) => copy(f.records.get(name)),
    write = async (name, value) => f.records.set(name, copy(value));
  f.execute = createEatsService({
    operation: (fn) => fn({ session, send }),
    read,
    write,
    uuid: randomUUID,
  });
  return f;
}
