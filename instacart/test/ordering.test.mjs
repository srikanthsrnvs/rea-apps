import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { listCarts, getCart, createCart, setCartItem, orderingQueries } from '../src/cart.mjs';
import { listOrders, getOrder } from '../src/orders.mjs';

function fakeClient(responses) {
  const calls = [];
  return { calls, async graphql(operation, document, variables) {
    calls.push({ operation, document, variables });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  } };
}

test('persisted cart mutation retains the exact registered native document', () => {
  assert.equal(createHash('sha256').update(orderingQueries.UpdateCartItems).digest('hex'),
    '523a329c0b171c6ca5341085f98a8022da9648dac677fa2937b580134a07a456');
});

test('cart writes use absolute quantity and preserve required-action barrier', async () => {
  const client = fakeClient([{ updateCartItems: {
    __typename: 'CartsCartItemUpdateActionRequiredResponse',
    requiredAction: { __typename: 'CartsSecondaryRetailerAcknowledgementModal', viewSection: { titleString: 'Review secondary retailer' } },
  } }]);
  const result = await setCartItem(client, { cartId: 'cart-opaque', itemId: 'items_123', quantity: 0 });
  assert.equal(result.updated, false);
  assert.equal(result.actionRequired, true);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].variables.cartItemUpdates, [{ itemId: 'items_123', quantity: 0 }]);
  assert.equal(client.calls[0].variables.completedRequiredActionType, undefined);
});

test('uncertain cart write is attempted once and propagates failure', async () => {
  const client = fakeClient([new Error('Connection closed after request body')]);
  await assert.rejects(() => setCartItem(client, { cartId: 'cart', itemId: 'item', quantity: 1 }), /Connection closed/);
  assert.equal(client.calls.length, 1);
});

test('invalid cart quantities and unsupported cart kinds never touch transport', async () => {
  const client = fakeClient([]);
  for (const quantity of [NaN, Infinity, -1, 0.5]) {
    await assert.rejects(() => setCartItem(client, { cartId: 'cart', itemId: 'item', quantity }), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(() => createCart(client, { shopId: 'shop', cartType: 'delegatedCheckout' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(client.calls.length, 0);
});

test('cart read distinguishes item subtotal from checkout total and omits tracking', async () => {
  const client = fakeClient([
    { userCart: { id: 'cart', itemCount: 1, cartItemCollection: { cartItems: [{
      id: 'line', quantity: 2, quantityType: 'each', viewSection: { trackingProperties: { secret: 'private' } },
      basketProduct: { id: 'basket', productId: 'product', v4ItemId: 'item', name: 'Coffee' },
    }] } } },
    { cartTotals: { retailerTotal: { amount: '10.00', currencyCode: 'USD' }, cartLineItems: [] } },
  ]);
  const result = await getCart(client, { cartId: 'cart', shopId: 'shop', postalCode: '90291' });
  assert.equal(result.totals.finalOrderTotal, false);
  assert.equal(result.cart.items[0].itemId, 'item');
  assert.doesNotMatch(JSON.stringify(result), /private|trackingProperties/);
});

test('order pagination forwards opaque cursor and does not expose receipt links', async () => {
  const client = fakeClient([{ orderDeliveriesConnection: {
    nodes: [{ id: 'delivery', legacyOrderId: 'order', receiptUrl: 'https://private-receipt', actions: { permittedActions: ['CANCEL'] } }],
    pageInfo: { hasNextPage: true, endCursor: 'opaque+/==' },
  } }]);
  const result = await listOrders(client, { first: 3, after: 'opaque+/==' });
  assert.deepEqual(client.calls[0].variables, { first: 3, after: 'opaque+/==' });
  assert.equal(result.pageInfo.hasNextPage, true);
  assert.equal(result.orders[0].orderId, 'order');
  assert.doesNotMatch(JSON.stringify(result), /private-receipt/);
});

test('missing cart/order return null without issuing unrelated calls', async () => {
  const client = fakeClient([{ userCart: null }, { orderDelivery: null }, { userCarts: { carts: [] } }]);
  assert.deepEqual(await getCart(client, { cartId: 'unknown' }), { cart: null });
  assert.deepEqual(await getOrder(client, { orderId: 'unknown' }), { order: null });
  assert.deepEqual(await listCarts(client), { carts: [], limit: 20 });
  assert.equal(client.calls.length, 3);
});

test('cart contents do not request rejected totals without pricing context', async () => {
  const client = fakeClient([{ userCart: { id: 'cart', itemCount: 0, cartItemCollection: { cartItems: [] } } }]);
  const result = await getCart(client, { cartId: 'cart' });
  assert.equal(result.cart.id, 'cart');
  assert.deepEqual(client.calls.map(call => call.operation), ['ReadCartData']);
  await assert.rejects(() => getCart(client, { cartId: 'cart', includeTotals: true }), { code: 'INVALID_ARGUMENT' });
  assert.equal(client.calls.length, 1);
});
