import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOrdersPage, parseOrderDetailsPage } from '../src/orders-protocol.mjs';

// Small invented records preserve the observed mobile server DOM structure.
// They contain no copied customer/order identifiers, titles or addresses.
const orderA = '111-1234567-1234567';
const orderB = '222-2345678-2345678';
const origin = 'https://www.amazon.com';
const wrap = (content, extra = '') => `<html><head><title>Your Orders</title></head><body><section class="your-orders-mobile-content-container"><h1>Your Orders</h1>${content}</section>${extra}</body></html>`;
const tile = ({ id = orderA, status = 'Cancelled', secondary = 'Your order was cancelled. You have not been charged for this order.', quantity = '2', href, extra = '', alt = 'Example product' } = {}) => `<div class="a-box a-spacing-none past-purchase-tile"><div class="a-box-inner a-padding-none">
  <a class="item-card__link" href="${href || `/your-orders/order-details?orderID=${id}&amp;ref=example`}"></a>
  <a href="#" class="a-touch-link"><div class="past-purchase-tile__asin">
    <div class="past-purchase-tile__asin-thumbnail"><div class="product-image"><img alt="${alt}" src="https://m.media-amazon.com/images/I/example.jpg">${quantity === null ? '' : `<span class="product-image__qty">${quantity}</span>`}</div></div>
    <div class="past-purchase-tile__asin-information"><div class="past-purchase-tile__asin-information-primary-text-container"><span class="item-card__primary-text">${status}</span></div>
    <div class="past-purchase-tile__asin-information-secondary-text-container"><span class="a-color-tertiary">${secondary}</span></div></div>
  </div></a>${extra}</div></div>`;

test('mobile history preserves source details URL, status and item fields without inventing total', () => {
  const page = parseOrdersPage(wrap(tile()));
  assert.equal(page.signedIn, true);
  assert.equal(page.orders.length, 1);
  assert.deepEqual(page.orders[0], {
    orderId: orderA, status: 'cancelled', statusText: 'Your order was cancelled. You have not been charged for this order.', total: null,
    actions: { details: `${origin}/your-orders/order-details?orderID=${orderA}&ref=example`, cancel: null },
    cancellation: { available: false, reason: 'already_cancelled' },
    items: [{ asin: null, title: 'Example product', quantity: 2, imageURL: 'https://m.media-amazon.com/images/I/example.jpg', status: 'cancelled', statusText: 'Your order was cancelled. You have not been charged for this order.', detailsURL: `${origin}/your-orders/order-details?orderID=${orderA}&ref=example` }],
  });
  assert.equal(page.pagination.hasMore, null);
});

test('delivered POP item link retains opaque identifiers and exposes only source product identity', () => {
  const href = `/your-orders/pop?orderId=${orderB}&amp;lineItemId=line-example&amp;shipmentId=ship-example&amp;packageId=package-example&amp;asin=B000000001`;
  const page = parseOrdersPage(wrap(tile({ id: orderB, href, status: 'Example product', secondary: 'Delivered October 1', quantity: null })));
  const order = page.orders[0];
  assert.equal(order.orderId, orderB);
  assert.equal(order.status, 'delivered');
  assert.equal(order.items[0].asin, 'B000000001');
  assert.equal(order.items[0].quantity, null);
  assert.equal(new URL(order.actions.details).searchParams.get('lineItemId'), 'line-example');
  assert.deepEqual(order.cancellation, { available: null, reason: 'eligibility_not_loaded' });
});

test('same-order tiles group items and keep mixed item statuses without false eligibility', () => {
  const page = parseOrdersPage(wrap(tile() + tile({ status: 'Second item', secondary: 'Delivered October 2' })));
  assert.equal(page.orders.length, 1);
  assert.equal(page.orders[0].items.length, 2);
  assert.equal(page.orders[0].status, 'mixed');
  assert.equal(page.orders[0].cancellation.available, null);
});

test('cancel action is returned only from a correlated source link', () => {
  const cancel = `/gp/aw/ya?ie=UTF8&amp;ac=oc&amp;oid=${orderA}&amp;flow=server-token`;
  const page = parseOrdersPage(wrap(tile({ status: 'Example', secondary: 'Arriving tomorrow', extra: `<a href="${cancel}">Cancel items</a><a href="/gp/aw/ya?ac=oc&amp;oid=${orderB}">Cancel wrong order</a>` })));
  assert.equal(page.orders[0].actions.cancel, `${origin}/gp/aw/ya?ie=UTF8&ac=oc&oid=${orderA}&flow=server-token`);
  // Having a navigation action is not final cancellation eligibility.
  assert.equal(page.orders[0].cancellation.available, null);
});

test('foreign, conflicting identity and mutation-shaped pagination links cannot become actions', () => {
  const page = parseOrdersPage(wrap(tile({ extra: `<a href="https://evil.example/gp/aw/ya?ac=oc&amp;oid=${orderA}">Cancel items</a><a href="/gp/aw/ya?ac=oc&amp;oid=${orderA}&amp;oid=${orderB}">Cancel items</a>` }), '<a rel=next href="/your-orders/orders?action=cancel">Next</a>'));
  assert.equal(page.orders[0].actions.cancel, null);
  assert.equal(page.pagination.next, null);
  assert.throws(() => parseOrdersPage(wrap(tile({ href: `https://evil.example/your-orders/order-details?orderID=${orderA}` }))), { code: 'UNRECOGNIZED_RESPONSE' });
  assert.throws(() => parseOrdersPage(wrap(tile({ href: `/your-orders/order-details?orderID=${orderA}&amp;orderId=${orderB}` }))), { code: 'UNRECOGNIZED_RESPONSE' });
});

test('pagination follows exact server links and explicit end marker wins over next links', () => {
  const next = '/your-orders/orders?timeFilter=months-3&amp;startIndex=10&amp;opaque=keep%2Bthis';
  const links = `<a rel=next href="${next}">Next</a><ul class=a-pagination><li class="a-first a-disabled"><a href="/your-orders/orders?startIndex=0">Previous</a></li></ul>`;
  const page = parseOrdersPage(wrap(tile(), links));
  assert.equal(page.pagination.next, `${origin}/your-orders/orders?timeFilter=months-3&startIndex=10&opaque=keep%2Bthis`);
  assert.equal(page.pagination.previous, null);
  assert.equal(page.pagination.hasMore, true);
  const ended = parseOrdersPage(wrap(tile(), `${links}<div id="your-orders-mobile-content-container__end-of-items-divider"><span>You&#39;ve reached the end of Your Orders</span></div>`));
  assert.equal(ended.pagination.next, null);
  assert.equal(ended.pagination.hasMore, false);
});

test('only explicit empty state is an empty account result', () => {
  const page = parseOrdersPage(wrap('<p>You have not placed any orders in the past 3 months.</p>'));
  assert.equal(page.empty, true);
  assert.deepEqual(page.orders, []);
  assert.equal(page.pagination.hasMore, false);
  assert.throws(() => parseOrdersPage(wrap('<p>Something went wrong loading your orders.</p>')), { code: 'UNRECOGNIZED_RESPONSE' });
  assert.throws(() => parseOrdersPage('<html><title>Your Orders</title><body>Please wait</body></html>'), { code: 'UNRECOGNIZED_RESPONSE' });
});

test('sign-in and automated-access responses cannot masquerade as no orders', () => {
  assert.throws(() => parseOrdersPage('<html><title>Amazon Sign-In</title><form id=ap_signin_form></form></html>'), { code: 'AUTH_REQUIRED' });
  assert.throws(() => parseOrdersPage('<html><title>Sorry! Something went wrong!</title><body>For automated access to Amazon data, contact support.</body></html>'), { code: 'AMAZON_CHALLENGE' });
});

test('embedded state is allowlisted and script content cannot add order records or statuses', () => {
  const state = `<script type=a-state data-a-state='{"key":"chunkState"}'>{"orderFilter":"RETAIL","timeFilter":"months-3","debugContext":{"session":"private"},"credentials":"private"}</script>`;
  const page = parseOrdersPage(wrap(tile({ status: 'Delivered gadget', secondary: 'Order received', extra: '<script>Cancelled</script>' }) + state));
  assert.deepEqual(page.filters, { orderFilter: 'RETAIL', timeFilter: 'months-3' });
  assert.equal(page.orders[0].status, 'ordered');
  assert.equal(JSON.stringify(page).includes('private'), false);
});

const detailURL = `${origin}/your-orders/order-details?orderID=${orderA}`;
const detail = ({ id = orderA, status = 'Cancelled', description = 'Your order was cancelled. You have not been charged for this order.', extra = '', itemPrice = '$10.00' } = {}) => `<html><head><title>Order Details</title></head><body>
  <div class="od-modernized"><div class="od-container"><h1>Order Details</h1><div>Order # ${id}</div>
    <div class="oui-shipment-card"><div class="oui-shipment-info"><h3 class="od-status-message"><span>${status}</span></h3><div class="od-status-message"><span>${description}</span></div></div>
      <div class="oui-item-card"><div class="od-modernized-item-view-qty"><span>2</span></div>
        <a href="/dp/B000000001?ref_=source"><img src="https://m.media-amazon.com/images/I/example.jpg" alt="Example product"></a>
        <div class="oui-item-row-right-grid"><a href="/dp/B000000001?ref_=source"><span class="a-truncate"><span class="a-truncate-full">Example full product title</span></span></a></div>
        <span class="a-price"><span class="a-offscreen">${itemPrice}</span><span aria-hidden=true>${itemPrice}</span></span>
      </div>
    </div>${extra}
  </div></div></body></html>`;

test('full details correlate the original source URL, parse exact item/status slots and omit private shipping data', () => {
  const page = parseOrderDetailsPage(detail({ extra: '<div>Shipping address: Example Private Person, 999 Fictional Street</div><div>Payment: private-account-information</div>' }), { url: detailURL, orderId: orderA });
  assert.equal(page.source, 'mobile_order_details');
  assert.equal(page.orderId, orderA);
  assert.equal(page.status, 'cancelled');
  assert.equal(page.total, null);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].title, 'Example full product title');
  assert.equal(page.items[0].asin, 'B000000001');
  assert.equal(page.items[0].quantity, 2);
  assert.deepEqual(page.items[0].displayedPrice, { display: '$10.00', amount: 10, currency: 'USD' });
  assert.deepEqual(page.cancellation, { available: false, reason: 'already_cancelled' });
  assert.equal(page.actions.cancel, null);
  assert.equal(JSON.stringify(page).includes('Private Person'), false);
  assert.equal(JSON.stringify(page).includes('private-account-information'), false);
});

test('details require coherent URL/request/visible order identities rather than arbitrary navigation IDs', () => {
  assert.throws(() => parseOrderDetailsPage(detail(), { url: detailURL, orderId: orderB }), { code: 'ORDER_ID_MISMATCH' });
  assert.throws(() => parseOrderDetailsPage(detail({ id: orderB }), { url: detailURL }), { code: 'ORDER_ID_MISMATCH' });
  assert.throws(() => parseOrderDetailsPage(detail(), { url: `${origin}/dp/B000000001?orderID=${orderA}` }), { code: 'ORDER_ID_MISMATCH' });
  assert.throws(() => parseOrderDetailsPage(detail(), { url: `${origin}/your-orders/order-details?orderID=${orderA}&oid=${orderB}` }), { code: 'ORDER_ID_MISMATCH' });
  assert.throws(() => parseOrderDetailsPage(detail()), { code: 'INVALID_ARGUMENT' });
});

test('only a visible labelled order-total row can become the order total', () => {
  const extra = '<div><span>Grand Total:</span><span class="a-price"><span class="a-offscreen">$23.45</span><span aria-hidden=true>$23.45</span></span></div>';
  const page = parseOrderDetailsPage(detail({ extra }), { url: detailURL });
  assert.deepEqual(page.total, { amount: 23.45, currency: 'USD', display: '$23.45' });
  assert.notEqual(page.total.amount, page.items[0].displayedPrice.amount);
});

test('details cancel links must identify this order and returns/replacements are never cancellation', () => {
  const extra = `<a href="/your-orders/returns?orderId=${orderA}">Return or replace items</a><a href="/gp/aw/ya?ac=oc&amp;oid=${orderB}">Cancel items</a><a href="/gp/aw/ya?ac=oc&amp;oid=${orderA}&amp;token=server">Cancel items</a>`;
  const page = parseOrderDetailsPage(detail({ status: 'Arriving tomorrow', description: 'Arriving tomorrow', extra }), { url: detailURL });
  assert.equal(page.actions.cancel, `${origin}/gp/aw/ya?ac=oc&oid=${orderA}&token=server`);
  assert.equal(page.cancellation.available, null);
  assert.equal(page.status, 'arriving');
  const unavailable = parseOrderDetailsPage(detail({ status: 'Shipped', description: 'This order can no longer be cancelled.' }), { url: detailURL });
  assert.deepEqual(unavailable.cancellation, { available: false, reason: 'server_states_unavailable' });
});

const pop = ({ asin = 'B000000001' } = {}) => `<html><head><title>Your Orders | Example item</title></head><body><section id=pop>
  <div class="pop-card js-pop-card"><div class="item-view__inner-col"><a href="/gp/aw/d/${asin}?ref=source"><img alt="Example product title" src="https://m.media-amazon.com/images/I/example.jpg"></a></div><a href="/gp/aw/d/${asin}?ref=source">Example short title</a></div>
  <div class="pop-card js-pop-card"><a href="/gp/aw/ya?ac=od&amp;oid=${orderB}&amp;ref=source">View order details</a><span>Order # ${orderB}</span></div>
  <div class="pop-card js-amabot-pop-card"><a href="/dp/B000000009">Unrelated recommendation</a><span>$999.99</span></div>
  </section></body></html>`;

test('product-owner page exposes exact receipt navigation without inventing total or delivery status', () => {
  const page = parseOrderDetailsPage(pop(), { url: `${origin}/your-orders/pop?orderId=${orderB}&asin=B000000001`, orderId: orderB });
  assert.equal(page.source, 'mobile_product_owner_page');
  assert.equal(page.status, 'unknown');
  assert.equal(page.total, null);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].asin, 'B000000001');
  assert.equal(page.items[0].title, 'Example product title');
  assert.equal(page.actions.details, `${origin}/gp/aw/ya?ac=od&oid=${orderB}&ref=source`);
  assert.equal(page.actions.cancel, null);
  assert.equal(page.cancellation.available, null);
  assert.throws(() => parseOrderDetailsPage(pop({ asin: 'B000000002' }), { url: `${origin}/your-orders/pop?orderId=${orderB}&asin=B000000001` }), { code: 'ORDER_ITEM_MISMATCH' });
});
