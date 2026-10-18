import { parseHTML } from 'linkedom';
import { AmazonError } from './errors.mjs';
import { retailURL } from './shopping-protocol.mjs';

// Source: authenticated mobile /your-orders/orders HTML, 2026-10-18.
// This view lists item tiles, not complete order receipts. Unshown totals,
// quantities and cancellation eligibility stay unknown. No requests are made.
const ORIGIN = 'https://www.amazon.com';
const ORDER_ID = /^\d{3}-\d{7}-\d{7}$/;
const ASIN = /^[A-Z0-9]{10}$/;
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
function visibleText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent;
  if (['SCRIPT', 'STYLE', 'TEMPLATE'].includes(node.tagName)) return '';
  return [...node.childNodes].map(visibleText).join('');
}
const text = (root, selector) => clean(visibleText(root.querySelector(selector)));

function documentFor(html) {
  if (typeof html !== 'string') throw new AmazonError('UNRECOGNIZED_RESPONSE', 'Amazon did not return an orders document.');
  const { document } = parseHTML(html);
  const title = clean(document.querySelector('title')?.textContent);
  const body = clean(visibleText(document.body)) || clean(visibleText(document));
  if (document.querySelector('form[action*="validateCaptcha"], #captchacharacters, #amzn-captcha-verify') || /robot check|amazon captcha/i.test(title) || /automated access|enter the characters you see below/i.test(body.slice(0, 15000))) {
    throw new AmazonError('AMAZON_CHALLENGE', 'Amazon requires verification before orders can be read.');
  }
  if (document.querySelector('form[name="signIn"], form#ap_signin_form, input#ap_password') || /amazon sign[ -]in/i.test(title)) {
    throw new AmazonError('AUTH_REQUIRED', 'Sign in to Amazon before reading orders.');
  }
  return document;
}

function linkURL(element, base) {
  if (!element || element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true' || element.closest('.a-disabled, .a-hidden, [hidden]')) return null;
  const href = element.getAttribute('href');
  if (!href || href.startsWith('#')) return null;
  try { return new URL(retailURL(href, base)); } catch { return null; }
}

function orderID(url) {
  if (!url) return null;
  const values = ['orderID', 'orderId', 'oid'].flatMap(key => url.searchParams.getAll(key));
  return values.length && values.every(value => value === values[0]) && ORDER_ID.test(values[0]) ? values[0] : null;
}

function isDetails(url) {
  return /^\/your-orders\/(?:order-details|pop)\/?$/.test(url.pathname)
    || url.pathname === '/gp/your-account/order-details'
    || /^\/gp\/aw\/ya\/?$/.test(url.pathname) && url.searchParams.get('ac') === 'od';
}

function isCancel(url, element) {
  const legacy = /^\/gp\/aw\/ya\/?$/.test(url.pathname) && url.searchParams.get('ac') === 'oc';
  const labelled = /^cancel\s+(?:items|order|this order|selected items)$/i.test(clean(visibleText(element)));
  return legacy || labelled && /^\/your-orders\//.test(url.pathname);
}

function imageURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'media-amazon.com' || url.hostname.endsWith('.media-amazon.com')) && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}

function statusFor(primary, secondary) {
  const statusText = secondary || primary;
  // Status comes from the status slot, not arbitrary product title words.
  const rawCandidate = /^(?:cancelled|canceled|cancellation requested|returned|refunded|shipped|out for delivery|ordered|order received)$/i.test(primary) ? `${primary} ${secondary}` : secondary;
  const candidate = rawCandidate.replace(/\b(?:cannot|can no longer|can['’]t) be cancell?ed\b/gi, '');
  if (/cancellation (?:requested|pending)|cancel request/i.test(candidate)) return { status: 'cancellation_requested', statusText };
  if (/\bcancell?ed\b/i.test(candidate)) return { status: 'cancelled', statusText };
  if (/\bdelivered\b/i.test(candidate)) return { status: 'delivered', statusText };
  if (/\breturned\b/i.test(candidate)) return { status: 'returned', statusText };
  if (/\brefunded\b|refund issued/i.test(candidate)) return { status: 'refunded', statusText };
  if (/\bout for delivery\b/i.test(candidate)) return { status: 'out_for_delivery', statusText };
  if (/\bshipped\b|\bdispatched\b/i.test(candidate)) return { status: 'shipped', statusText };
  if (/\barriv(?:ing|es)\b|\bexpected\b/i.test(candidate)) return { status: 'arriving', statusText };
  if (/\bordered\b|\border received\b/i.test(candidate)) return { status: 'ordered', statusText };
  return { status: 'unknown', statusText: statusText || null };
}

function paginationURL(document, selector, base) {
  for (const element of document.querySelectorAll(selector)) {
    const url = linkURL(element, base);
    if (!url || !/^\/your-orders\/(?:orders|search)(?:\/ref=[^/]*)?\/?$/.test(url.pathname)) continue;
    if (['ac', 'action', 'cancel', 'orderID', 'orderId', 'oid'].some(key => url.searchParams.has(key))) continue;
    return url.href;
  }
  return null;
}

function filtersFor(document) {
  for (const element of document.querySelectorAll('script[type="a-state"][data-a-state]')) {
    try {
      if (JSON.parse(element.getAttribute('data-a-state')).key !== 'chunkState') continue;
      const state = JSON.parse(element.textContent);
      // Never return arbitrary debugContext or embedded session state.
      return Object.fromEntries(['orderFilter', 'timeFilter'].filter(key => typeof state?.[key] === 'string' && state[key].length < 100).map(key => [key, state[key]]));
    } catch { /* Other page components may have unrelated state. */ }
  }
  return {};
}

export function parseOrdersPage(html, { url = `${ORIGIN}/your-orders/orders` } = {}) {
  url = retailURL(url);
  const document = documentFor(html);
  const container = document.querySelector('.your-orders-mobile-content-container');
  if (!container || !/your orders/i.test(text(container, 'h1'))) throw new AmazonError('UNRECOGNIZED_RESPONSE', 'Amazon returned no recognized mobile orders list.');
  const cards = [...container.querySelectorAll('.past-purchase-tile')];
  const orders = [], byID = new Map();
  for (const card of cards) {
    const links = [...card.querySelectorAll('a[href]')].map(element => ({ element, url: linkURL(element, url) })).filter(link => link.url);
    const details = links.find(link => isDetails(link.url) && orderID(link.url));
    if (!details) throw new AmazonError('UNRECOGNIZED_RESPONSE', 'An order tile has no recognized order identity.');
    const id = orderID(details.url);
    const cancel = links.find(link => isCancel(link.url, link.element) && orderID(link.url) === id);
    const primary = text(card, '.item-card__primary-text');
    const secondary = text(card, '.past-purchase-tile__asin-information-secondary-text-container');
    const status = statusFor(primary, secondary);
    const image = card.querySelector('.product-image img');
    const title = clean(image?.getAttribute('alt')) || (status.status === 'unknown' ? primary : null);
    const quantityText = text(card, '.product-image__qty');
    const asin = details.url.searchParams.get('asin');
    const item = {
      asin: ASIN.test(asin ?? '') ? asin : null, title: title || null,
      quantity: /^[1-9]\d*$/.test(quantityText) && Number.isSafeInteger(Number(quantityText)) ? Number(quantityText) : null,
      imageURL: imageURL(image?.getAttribute('src')), status: status.status, statusText: status.statusText,
      detailsURL: details.url.href,
    };
    let order = byID.get(id);
    if (!order) {
      order = {
        orderId: id, ...status, total: null, items: [], actions: { details: details.url.href, cancel: cancel?.url.href ?? null },
        cancellation: { available: status.status === 'cancelled' ? false : null, reason: status.status === 'cancelled' ? 'already_cancelled' : 'eligibility_not_loaded' },
      };
      byID.set(id, order); orders.push(order);
    } else if (order.status !== status.status) {
      order.status = 'mixed'; order.statusText = null;
      order.cancellation = { available: null, reason: 'eligibility_not_loaded' };
    }
    order.items.push(item);
    if (cancel && !order.actions.cancel) order.actions.cancel = cancel.url.href;
  }
  const endText = text(document, '#your-orders-mobile-content-container__end-of-items-divider');
  const endReached = /you(?:'|’)ve reached the end of your orders/i.test(endText);
  const empty = !cards.length && /(?:you (?:have not|haven't|haven’t) placed any orders|no orders (?:found|placed)|no orders in this (?:period|time))/i.test(clean(visibleText(container)));
  if (!orders.length && !empty && !endReached) throw new AmazonError('UNRECOGNIZED_RESPONSE', 'Amazon returned no recognized orders or empty-list confirmation.');
  const next = endReached ? null : paginationURL(document, 'a[rel="next"], .a-pagination .a-last a, a.js-yo-next-page', url);
  return {
    signedIn: true, source: 'mobile_past_purchase_tiles', orders, empty: orders.length === 0,
    filters: filtersFor(document),
    pagination: { next, previous: paginationURL(document, 'a[rel="prev"], .a-pagination .a-first a, a.js-yo-previous-page', url), hasMore: endReached || empty ? false : next ? true : null },
  };
}

function displayedMoney(value) {
  const display = clean(value);
  const match = display.match(/^(US\$|\$|USD|EUR|€|GBP|£)\s*([\d,]+(?:\.\d{2})?)$/);
  if (!match) return null;
  const amount = Number(match[2].replaceAll(',', ''));
  return Number.isFinite(amount) ? { display, amount, currency: ({ '$': 'USD', 'US$': 'USD', USD: 'USD', EUR: 'EUR', '€': 'EUR', GBP: 'GBP', '£': 'GBP' })[match[1]] } : null;
}

function orderTotal(root) {
  // Exact visible row labels only. An item's displayed price or recommendation
  // price is never an order total. Absence of this row is not a zero total.
  for (const label of root.querySelectorAll('span,strong,dt,th')) {
    if (label.children.length || !/^(?:grand total|order total)\s*:?$/i.test(clean(visibleText(label)))) continue;
    const row = label.parentElement;
    if (!row || row.children.length > 4) continue;
    for (const sibling of row.children) {
      if (sibling === label) continue;
      const money = displayedMoney(text(sibling, '.a-offscreen') || visibleText(sibling));
      if (money) return money;
    }
  }
  return null;
}

function productLink(root, base) {
  for (const element of root.querySelectorAll('a[href]')) {
    const url = linkURL(element, base);
    const asin = url?.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:\/|$)/)?.[1];
    if (asin) return { url: url.href, asin, element };
  }
  return null;
}

function quantityValue(value) {
  const match = clean(value).match(/^(?:qty\s*:?\s*)?([1-9]\d*)$/i);
  return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
}

/** Parse the two observed server detail layouts. Addresses and payment data are
 * intentionally omitted; these pages can contain complete private addresses. */
export function parseOrderDetailsPage(html, { url, orderId: requestedOrderID } = {}) {
  if (!url) throw new AmazonError('INVALID_ARGUMENT', 'An original order details URL is required.');
  url = retailURL(url);
  const sourceURL = new URL(url), id = orderID(sourceURL);
  if (!isDetails(sourceURL) || !id || requestedOrderID !== undefined && requestedOrderID !== id) {
    throw new AmazonError('ORDER_ID_MISMATCH', 'The source details URL must identify the requested order.');
  }
  const document = documentFor(html);
  const fullRoot = document.querySelector('.od-modernized .od-container');
  const popRoot = document.querySelector('section#pop');
  const root = fullRoot || popRoot;
  if (!root) throw new AmazonError('UNRECOGNIZED_RESPONSE', 'Amazon returned no recognized order details.');
  const visibleIDs = [...clean(visibleText(root)).matchAll(/order\s*(?:number|ID|#)\s*:?\s*(\d{3}-\d{7}-\d{7})/gi)].map(match => match[1]);
  if (visibleIDs.some(value => value !== id)) throw new AmazonError('ORDER_ID_MISMATCH', 'The displayed order does not match the source URL.');
  const links = [...root.querySelectorAll('a[href]')].map(element => ({ element, url: linkURL(element, url) })).filter(link => link.url);
  const details = links.find(link => isDetails(link.url) && orderID(link.url) === id);
  const cancel = links.find(link => isCancel(link.url, link.element) && orderID(link.url) === id);
  const items = [];
  let status = { status: 'unknown', statusText: null };
  if (fullRoot) {
    const cards = [...fullRoot.querySelectorAll('.oui-item-card')];
    for (const card of cards) {
      const product = productLink(card, url);
      const image = card.querySelector('img');
      const title = text(card, '.oui-item-row-right-grid .a-truncate-full') || clean(image?.getAttribute('alt')) || clean(visibleText(product?.element));
      if (!product || !title) throw new AmazonError('UNRECOGNIZED_RESPONSE', 'An order item is missing its product identity.');
      const shipment = card.closest('.oui-shipment-card');
      const messages = [...(shipment?.querySelectorAll('.oui-shipment-info .od-status-message') ?? [])].map(element => clean(visibleText(element))).filter(Boolean);
      const itemStatus = statusFor(messages[0] ?? '', messages.slice(1).join(' '));
      items.push({
        asin: product.asin, title, url: product.url, quantity: quantityValue(text(card, '.od-modernized-item-view-qty')),
        imageURL: imageURL(image?.getAttribute('src')), displayedPrice: displayedMoney(text(card, '.a-price .a-offscreen')),
        ...itemStatus,
      });
    }
    if (!items.length) throw new AmazonError('UNRECOGNIZED_RESPONSE', 'The order details contain no recognized items.');
    status = items.every(item => item.status === items[0].status)
      ? { status: items[0].status, statusText: items[0].statusText }
      : { status: 'mixed', statusText: null };
  } else {
    // POP's first item card is separate from recommendation/advertisement cards.
    const card = popRoot.querySelector('.js-pop-card');
    const product = card && productLink(card, url);
    const image = card?.querySelector('.item-view__inner-col img');
    const title = clean(image?.getAttribute('alt')) || clean(visibleText(product?.element));
    if (!product || !title || !details) throw new AmazonError('UNRECOGNIZED_RESPONSE', 'Amazon returned no correlated product-owner order details.');
    const expectedASIN = sourceURL.searchParams.get('asin');
    if (expectedASIN && expectedASIN !== product.asin) throw new AmazonError('ORDER_ITEM_MISMATCH', 'The product-owner page does not match its source item.');
    items.push({ asin: product.asin, title, url: product.url, quantity: null, imageURL: imageURL(image?.getAttribute('src')), displayedPrice: null, ...status });
  }
  const explicitlyUnavailable = /(?:this order|these items|your order) (?:cannot|can no longer|can['’]t) be cancel(?:l)?ed/i.test(clean(visibleText(root)));
  const unavailable = status.status === 'cancelled' || explicitlyUnavailable;
  return {
    orderId: id, source: fullRoot ? 'mobile_order_details' : 'mobile_product_owner_page', ...status,
    total: fullRoot ? orderTotal(fullRoot) : null, items,
    actions: { details: details?.url.href ?? url, cancel: cancel?.url.href ?? null },
    cancellation: { available: unavailable ? false : null, reason: status.status === 'cancelled' ? 'already_cancelled' : explicitlyUnavailable ? 'server_states_unavailable' : 'eligibility_not_loaded' },
  };
}
