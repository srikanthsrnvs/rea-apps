import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCheckout, checkoutReview } from '../src/checkout.mjs';

const formatted = text => ({ sections: [{ text }] });
function fixture() {
  const cart = { id: 'cart', retailerId: 'retailer', itemCount: 1, items: [{ itemId: 'item', name: 'Coffee', quantity: 1 }] };
  const store = { shopId: 'shop', retailerId: 'retailer', name: 'Test grocer', serviceType: 'delivery' };
  const address = { id: 'address', streetAddress: '123 Example St', postalCode: '00000' };
  const initialization = {
    __typename: 'CheckoutInitializeCheckoutSuccessResponse',
    checkoutData: { checkoutSessionId: 'private-checkout-session', serviceType: 'delivery' },
    checkoutResourceRequirements: { pendingRequirements: [] },
    checkoutResourceSelections: { selections: [
      { __typename: 'CheckoutCheckoutSelectionsTipsSelection', tipInputToken: 'private-tip-token' },
      { __typename: 'CheckoutCheckoutSelectionsServiceOptionSelection', serviceOptionSelectionToken: 'private-window-token' },
    ] },
    checkoutResourceCollection: { resources: [
      { __typename: 'CheckoutCheckoutResourcesTipsResource', tipResponse: { tipOptions: [
        { isDefault: true, tipInputToken: 'other-tip-token', viewSection: { labelString: '$5.00' } },
        { tipInputToken: 'private-tip-token', viewSection: { labelString: '$2.00' } },
      ] } },
      { __typename: 'CheckoutCheckoutResourcesPricedServiceOptionsResource', pricedServiceOptions: {
        options: [{ serviceOptionToken: 'private-window-token', viewSection: { postCheckoutWindowString: 'Today, 2–3 PM' } }],
      } },
      { __typename: 'CheckoutCheckoutResourcesPaymentsResource', buyFlowInstruments: {
        payWithSectionV2: { rows: [{ savedPaymentMethods: [{ instrumentReference: 'private-card-reference', isSelected: true,
          instrumentType: 'card', viewSection: { titleFormattedAttributesString: formatted('Visa •••• 1234') } }] }] },
      } },
    ] },
  };
  const invoice = {
    __typename: 'OrdersOrderInvoice',
    checkoutTotalsPresenter: {
      invoiceInfo: { paymentsInfo: { authAmount: { amount: '12.50', amountMinorUnits: 1250, currency: 'USD' } } },
      invoicingPaymentMethodsApplied: { items: [{ instrumentReference: 'private-card-reference', amountAppliedV2: { amount: 12, currencyCode: 'USD' } }] },
      viewSection: { checkoutTotalsV2: { checkoutTotals: [
        { labelFormattedAttributesString: formatted('Items'), amountFormattedAttributesString: formatted('$10.00') },
        { labelFormattedAttributesString: formatted('Total'), amountFormattedAttributesString: formatted('$12.00') },
      ] } },
    },
  };
  return { cart, store, address, initialization, invoice };
}

function clientFor(f) {
  const calls = [];
  return { calls, state: { userId: 'customer' }, async graphql(name) {
    calls.push(name);
    if (name === 'ReadCartData') return { userCart: {
      ...f.cart, cartItemCollection: { cartItems: f.cart.items.map(item => ({ id: 'line', quantity: item.quantity, basketProduct: { v4ItemId: item.itemId, name: item.name } })) },
    } };
    if (name === 'Shop') return { shop: { id: f.store.shopId, serviceType: f.store.serviceType, retailer: { id: f.store.retailerId, name: f.store.name } } };
    if (name === 'UserAddresses') return { userAddresses: [f.address] };
    if (name === 'InitializeCheckout') return { initializeCheckout: f.initialization };
    if (name === 'CheckoutDraftOrderInvoiceV2') return { checkoutDraftOrderInvoiceV2: f.invoice };
    throw new Error(`Unexpected operation ${name}`);
  } };
}

test('checkout preview preserves selected tip, final invoice and separate authorization hold', () => {
  const f = fixture();
  const review = checkoutReview(f.initialization, f.invoice, { ...f, previewId: 'preview', createdAt: '2026-10-29T10:00:00Z' });
  assert.equal(review.tip.display, '$2.00');
  assert.equal(review.totalDisplay, '$12.00');
  assert.equal(review.authorizationHold.minorUnits, 1250);
  assert.equal(review.window.display, 'Today, 2–3 PM');
  assert.equal(review.payment.methods[0].title, 'Visa •••• 1234');
  assert.doesNotMatch(JSON.stringify(review), /private-|tipInputToken|checkoutSessionId|instrumentReference/);
});

test('prepare persists private draft while returning a nonspending review', async () => {
  const f = fixture(); const client = clientFor(f); const saved = [];
  const review = await prepareCheckout(client, { cartId: 'cart', shopId: 'shop', addressId: 'address' }, {
    save: async (name, value) => saved.push({ name, value }), now: () => '2026-10-29T10:00:00Z',
  });
  assert.deepEqual(client.calls, ['ReadCartData', 'Shop', 'UserAddresses', 'InitializeCheckout', 'CheckoutDraftOrderInvoiceV2']);
  assert.equal(review.previewOnly, true);
  assert.equal(review.orderPlaced, false);
  assert.equal(saved.length, 1);
  assert.match(saved[0].name, /^checkout_[0-9a-f-]+$/);
  assert.equal(saved[0].value.initialization.checkoutData.checkoutSessionId, 'private-checkout-session');
  assert.equal(saved[0].value.kind, 'preview');
});

test('empty cart and mismatched shop are rejected before creating a draft', async () => {
  let f = fixture();f.cart.items = [];let client = clientFor(f);
  await assert.rejects(() => prepareCheckout(client, { cartId: 'cart', shopId: 'shop', addressId: 'address' }), { code: 'EMPTY_CART' });
  assert.deepEqual(client.calls, ['ReadCartData']);
  f = fixture();f.store.retailerId = 'other-retailer';client = clientFor(f);
  await assert.rejects(() => prepareCheckout(client, { cartId: 'cart', shopId: 'shop', addressId: 'address' }), { code: 'CART_SHOP_MISMATCH' });
  assert.deepEqual(client.calls, ['ReadCartData', 'Shop']);
});

test('missing selections and upstream requirements are reported instead of guessed', () => {
  const f = fixture();f.initialization.checkoutResourceSelections.selections = [];
  f.initialization.checkoutResourceRequirements.pendingRequirements = [{ __typename: 'CheckoutPaymentRequirement', resourceRequirementIdentifier: 'payment' }];
  f.initialization.checkoutResourceCollection.resources = [];
  const review = checkoutReview(f.initialization, f.invoice, { ...f, previewId: 'preview', createdAt: '2026-10-29T10:00:00Z' });
  assert.deepEqual(review.incompleteReviewFields, ['serviceWindow', 'tip', 'payment']);
  assert.equal(review.missingRequirements[0].identifier, 'payment');
  assert.equal(review.orderPlaced, false);
});

test('custom tip amounts retain currency and never stringify an object', () => {
  const f = fixture();
  f.initialization.checkoutResourceSelections.selections[0].customTipAmount = { amount: 0, currencyCode: 'USD' };
  const review = checkoutReview(f.initialization, f.invoice, { ...f, previewId: 'preview', createdAt: '2026-10-29T10:00:00Z' });
  assert.deepEqual(review.tip, { display: '0 USD', amount: 0, currency: 'USD' });
});
