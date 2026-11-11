import { readFileSync } from 'node:fs';

export const orderingQueries = JSON.parse(readFileSync(new URL('./ordering-queries.json', import.meta.url), 'utf8'));

export function requiredId(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) {
    throw Object.assign(new Error(`${label} must be a nonempty ID.`), { code: 'INVALID_ARGUMENT' });
  }
  return value;
}

function boundedInteger(value, label, max = 100) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw Object.assign(new Error(`${label} must be an integer from 1 to ${max}.`), { code: 'INVALID_ARGUMENT' });
  }
  return value;
}

function optionalString(value, label) {
  if (value !== undefined && (typeof value !== 'string' || value.length > 4096)) {
    throw Object.assign(new Error(`${label} must be text.`), { code: 'INVALID_ARGUMENT' });
  }
  return value;
}

function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

export function summarizeCart(cart) {
  if (!cart) return null;
  return defined({
    id: cart.id,
    type: cart.cartType,
    retailerId: cart.retailerId,
    retailer: cart.retailer ? { id: cart.retailer.id, name: cart.retailer.name, slug: cart.retailer.slug } : undefined,
    itemCount: cart.itemCount,
    createdAt: cart.createdAt,
    updatedAt: cart.updatedAt,
    items: cart.cartItemCollection?.cartItems?.map((item) => defined({
      id: item.id,
      quantity: item.quantity,
      quantityType: item.quantityType,
      name: item.basketProduct?.name,
      itemId: item.basketProduct?.v4ItemId,
      productId: item.basketProduct?.productId,
      basketProductId: item.basketProduct?.id,
      unavailable: item.viewSection?.unavailableItemLabelString || undefined,
    })),
  });
}

export async function listCarts(client, { limit = 20, empty, shopId } = {}) {
  boundedInteger(limit, 'limit');
  if (empty !== undefined && typeof empty !== 'boolean') {
    throw Object.assign(new Error('empty must be true or false.'), { code: 'INVALID_ARGUMENT' });
  }
  if (shopId !== undefined) requiredId(shopId, 'shopId');
  const data = await client.graphql('UserCarts', orderingQueries.UserCarts, defined({ limit, empty, shopId }));
  return { carts: (data.userCarts?.carts ?? []).map(summarizeCart), limit };
}

export async function getCart(client, { cartId, shopId, postalCode, includeTotals } = {}) {
  requiredId(cartId, 'cartId');
  if (shopId !== undefined) requiredId(shopId, 'shopId');
  optionalString(postalCode, 'postalCode');
  const withTotals = includeTotals ?? Boolean(shopId && postalCode);
  if (typeof withTotals !== 'boolean' || (withTotals && (!shopId || !postalCode))) {
    throw Object.assign(new Error('Estimated totals require shopId and postalCode; omit includeTotals to read only cart contents.'), { code: 'INVALID_ARGUMENT' });
  }
  const data = await client.graphql('ReadCartData', orderingQueries.ReadCartData, { id: cartId });
  if (!data.userCart) return { cart: null };
  const result = { cart: summarizeCart(data.userCart) };
  if (withTotals) {
    const priced = await client.graphql('CartTotals', orderingQueries.CartTotals,
      defined({ cartId, shopId, postalCode }));
    const totals = priced.cartTotals;
    result.totals = totals ? {
      subtotal: totals.retailerTotal,
      savings: totals.savingsTotal,
      subtotalDisplay: totals.viewSection?.retailerTotalString ?? totals.viewSection?.estRetailerTotalString,
      items: totals.cartLineItems?.map((item) => ({
        cartItemId: item.cartItemId,
        priceDisplay: item.cartItemPricing?.viewSection?.itemsPriceString,
        originalPriceDisplay: item.cartItemPricing?.viewSection?.fullItemsPriceString,
      })),
      unpricedItems: totals.unpricedCartLineItems ?? [],
      finalOrderTotal: false,
    } : null;
  }
  return result;
}

export async function createCart(client, { shopId, cartType = 'grocery' } = {}) {
  requiredId(shopId, 'shopId');
  if (cartType !== 'grocery') {
    throw Object.assign(new Error('Only grocery carts are supported.'), { code: 'INVALID_ARGUMENT' });
  }
  const data = await client.graphql('AllocateBackgroundCart', orderingQueries.AllocateBackgroundCart, { shopId, cartType });
  const result = data.allocateBackgroundCart;
  if (result?.__typename !== 'CartsCart' || !result.id) {
    throw Object.assign(new Error(`Instacart did not allocate a cart${result?.errorType ? `: ${result.errorType}` : '.'}`),
      { code: 'CART_CREATE_FAILED' });
  }
  return { cartId: result.id, cartType };
}

// Quantities are absolute. Zero removes the item; this never increments blindly.
// Mutation requests must never be automatically retried by the transport.
export async function setCartItem(client, { cartId, itemId, quantity, quantityType, specialInstructions } = {}) {
  requiredId(cartId, 'cartId');
  requiredId(itemId, 'itemId');
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0 || quantity > 1000) {
    throw Object.assign(new Error('quantity must be a finite number from 0 to 1000.'), { code: 'INVALID_ARGUMENT' });
  }
  if (quantityType !== undefined && !['each', 'weight'].includes(quantityType)) {
    throw Object.assign(new Error('quantityType must be each or weight.'), { code: 'INVALID_ARGUMENT' });
  }
  if ((quantityType === 'each' || quantityType === undefined) && !Number.isInteger(quantity)) {
    throw Object.assign(new Error('Use quantityType weight for fractional quantities.'), { code: 'INVALID_ARGUMENT' });
  }
  optionalString(specialInstructions, 'specialInstructions');
  const variables = {
    cartId,
    cartItemUpdates: [defined({ itemId, quantity, quantityType, specialInstructions })],
    requestTimestamp: Date.now(),
  };
  const data = await client.graphql('UpdateCartItems', orderingQueries.UpdateCartItems, variables);
  const result = data.updateCartItems;
  if (result?.__typename === 'CartsCartItemUpdateActionRequiredResponse') {
    return { updated: false, actionRequired: true, action: result.requiredAction?.__typename,
      message: result.requiredAction?.viewSection?.titleString };
  }
  if (result?.__typename !== 'CartsCartItemUpdateSuccessResponse' || !result.cart) {
    throw Object.assign(new Error(result?.viewSection?.cartUpdateErrorDescriptionString || 'Instacart did not confirm the cart update.'),
      { code: 'CART_UPDATE_FAILED', upstreamType: result?.errorType });
  }
  return {
    updated: true,
    cart: summarizeCart(result.cart),
    updatedItems: result.updatedItemIds?.map((item) => ({ itemId: item.itemId, operation: item.cartItemUpdateOperation })),
  };
}
