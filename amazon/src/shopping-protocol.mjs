import { parseHTML } from 'linkedom';
import { AmazonError } from './errors.mjs';

const ORIGIN = 'https://www.amazon.com';
const ASIN = /^[A-Z0-9]{10}$/;
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
function visibleText(element) {
  if (!element) return '';
  if (element.nodeType === 3) return element.textContent;
  if (['SCRIPT', 'STYLE', 'TEMPLATE'].includes(element.tagName)) return '';
  return [...element.childNodes].map(visibleText).join(' ');
}
const text = (root, selector) => clean(visibleText(root.querySelector(selector)));

export function nativeUserAgent({ version = '32.18.0.100', androidVersion = '16', model = 'Pixel 10 Pro Fold' } = {}) {
  for (const value of [version, androidVersion, model]) {
    if (typeof value !== 'string' || !value || /[\r\n\x00]/.test(value)) throw new AmazonError('INVALID_ARGUMENT', 'Invalid client profile.');
  }
  return `Amazon.com/${version} (Android/${androidVersion}/${model})`;
}

export function retailURL(value, base = ORIGIN, { searchOnly = false } = {}) {
  let url;
  try { url = new URL(value, base); } catch { throw new AmazonError('INVALID_URL', 'Invalid Amazon URL.'); }
  if (url.protocol !== 'https:' || !['www.amazon.com', 'amazon.com'].includes(url.hostname) || url.username || url.password || url.port || (searchOnly && url.pathname !== '/s')) {
    throw new AmazonError('INVALID_URL', 'Expected a secure Amazon Shopping URL.');
  }
  url.hash = '';
  return url.href;
}

export function buildSearchURL(query, { cursor = null, page = 1 } = {}) {
  if (cursor) return retailURL(cursor, ORIGIN, { searchOnly: true });
  if (typeof query !== 'string' || !query.trim()) throw new AmazonError('INVALID_ARGUMENT', 'Enter a product search.');
  if (!Number.isSafeInteger(page) || page < 1) throw new AmazonError('INVALID_ARGUMENT', 'Page must be a positive integer.');
  const url = new URL('/s', ORIGIN);
  url.searchParams.set('k', query.trim());
  if (page !== 1) url.searchParams.set('page', String(page));
  return url.href;
}

function decodeEntities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|quot|apos|amp|lt|gt|nbsp);/gi, (all, entity) => {
    if (entity[0] === '#') {
      const number = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '\ufffd';
    }
    return ({ quot: '"', apos: "'", amp: '&', lt: '<', gt: '>', nbsp: ' ' })[entity.toLowerCase()] ?? all;
  });
}

function documentFor(html) {
  if (typeof html !== 'string') throw new AmazonError('UNRECOGNIZED_RESPONSE', 'Amazon did not return a shopping document.');
  const { document } = parseHTML(html);
  const title = clean(document.querySelector('title')?.textContent).toLowerCase();
  const shortText = clean(visibleText(document.body)).slice(0, 15000);
  if (document.querySelector('form[action*="validateCaptcha"], #captchacharacters, #amzn-captcha-verify') || /robot check|amazon captcha/.test(title) || (/sorry! something went wrong/.test(title) && /automated access|captcha|robot/i.test(shortText))) {
    throw new AmazonError('AMAZON_CHALLENGE', 'Amazon requires verification before this request can continue.');
  }
  if (document.querySelector('form[name="signIn"], form#ap_signin_form, input#ap_password') || /amazon sign[ -]in/.test(title)) {
    throw new AmazonError('AUTH_REQUIRED', 'Sign in to Amazon before continuing.');
  }
  return document;
}

function payloadFor(card, asin) {
  for (const element of card.querySelectorAll('[data-payload]')) {
    try {
      // The attribute parser removes the outer HTML escaping; the app's JSON has one additional layer.
      const value = JSON.parse(decodeEntities(element.getAttribute('data-payload')));
      if (value && value.asin === asin && typeof value.title === 'string') return value;
    } catch { /* An unrelated component can use the same attribute. */ }
  }
  return null;
}

function priceValue(display, currency = null) {
  display = clean(display);
  if (!display) return null;
  const simple = display.match(/^(?:US\$|\$|USD\s*)?\s*([\d,]+(?:\.\d{1,2})?)$/);
  return { display, amount: simple ? Number(simple[1].replaceAll(',', '')) : null, currency: currency || (/^(?:US\$|\$)/.test(display) ? 'USD' : null) };
}

function displayedPrice(node) {
  if (!node) return '';
  const accessible = text(node, '.a-offscreen');
  if (accessible) return accessible;
  const whole = text(node, '.a-price-whole').replace(/\s/g, '').replace(/[.,]$/, '');
  const fraction = text(node, '.a-price-fraction');
  if (!whole) return '';
  return `${text(node, '.a-price-symbol')}${whole}${fraction ? `.${fraction}` : ''}`;
}

function countValue(value) {
  const match = clean(value).replaceAll(',', '').match(/^([\d.]+)\s*([KMB])?$/i);
  if (!match) return null;
  const result = Number(match[1]) * ({ k: 1000, m: 1000000, b: 1000000000 }[match[2]?.toLowerCase()] || 1);
  return Number.isFinite(result) ? Math.round(result) : null;
}

function ratingValue(card, payload) {
  const ratingText = [...card.querySelectorAll('[aria-label], .a-icon-alt')].map(element => element.getAttribute('aria-label') || element.textContent).find(value => /[\d.]+ out of 5 stars/i.test(value));
  if (ratingText) return Number(ratingText.match(/([\d.]+) out of 5 stars/i)[1]);
  const number = ({ ONE: 1, ONEANDHALF: 1.5, TWO: 2, TWOANDHALF: 2.5, THREE: 3, THREEANDHALF: 3.5, FOUR: 4, FOURANDHALF: 4.5, FIVE: 5 })[payload?.star_rating];
  return number ?? null;
}

function pageLink(document, selector, url) {
  const element = document.querySelector(selector);
  const href = element?.getAttribute('href');
  if (!href || element.getAttribute('aria-disabled') === 'true' || element.classList.contains('a-disabled')) return null;
  try { return retailURL(href, url, { searchOnly: true }); } catch { return null; }
}

export function parseSearchHTML(html, { url = `${ORIGIN}/s` } = {}) {
  url = retailURL(url, ORIGIN, { searchOnly: true });
  const document = documentFor(html);
  const cards = [...document.querySelectorAll('[data-component-type="s-search-result"][data-asin]')];
  const items = [];
  for (const card of cards) {
    const asin = card.getAttribute('data-asin');
    if (!ASIN.test(asin || '')) continue;
    const payload = payloadFor(card, asin);
    const title = clean(payload?.title || visibleText(card.querySelector('h2')));
    if (!title) continue;
    const priceText = payload?.price || displayedPrice(card.querySelector('.a-price:not(.a-text-price)'));
    const reviews = payload?.num_reviews ?? text(card, 'a[href*="customerReviews"] .a-size-small, [data-cy="reviews-block"] .a-size-small');
    items.push({
      asin, title, url: `${ORIGIN}/dp/${asin}`, price: priceValue(priceText, payload?.currency),
      rating: ratingValue(card, payload), reviewCount: countValue(reviews),
      prime: payload?.prime === true || Boolean(card.querySelector('.a-icon-prime, [aria-label="Amazon Prime"], [aria-label="Prime"]')),
      sponsored: card.classList.contains('AdHolder') || Boolean(card.querySelector('.s-ad-feedback-label, [aria-label*="Sponsored information"]')),
      imageURL: payload?.image_urls?.find(value => typeof value === 'string' && value.startsWith('https://')) || card.querySelector('img.s-image:not([alt="More like this"])')?.getAttribute('src') || null,
    });
  }
  const zeroResults = /no results for|no results found|did not match any products/i.test(clean(visibleText(document.body)));
  if (!items.length && !zeroResults) throw new AmazonError('UNRECOGNIZED_RESPONSE', 'Amazon returned no recognized search results.');
  return {
    query: new URL(url).searchParams.get('k'), items,
    pagination: {
      next: pageLink(document, 'a.s-pagination-next:not(.s-pagination-disabled), li.a-last:not(.a-disabled) a', url),
      previous: pageLink(document, 'a.s-pagination-previous:not(.s-pagination-disabled), ul.a-pagination li.a-first:not(.a-disabled) a', url),
    },
    resultSummary: text(document, '[data-component-type="s-result-info-bar"] .a-size-base, .s-result-info-bar .a-size-base') || (zeroResults ? 'No results' : null),
  };
}

export function parseProductHTML(html, { url } = {}) {
  url = retailURL(url || ORIGIN);
  const document = documentFor(html);
  const asin = document.querySelector('input#ASIN, input[name="ASIN"], input[name="asin"]')?.getAttribute('value') || new URL(url).pathname.match(/\/dp\/([A-Z0-9]{10})(?:[/?]|$)/)?.[1];
  const title = text(document, '#productTitle, #title_feature_div h1, #title');
  if (!ASIN.test(asin || '') || !title) throw new AmazonError('UNRECOGNIZED_RESPONSE', 'Amazon returned no recognized product.');
  const price = displayedPrice(document.querySelector('#corePriceDisplay_mobile_feature_div .a-price:not(.a-text-price), #corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price), #corePrice_feature_div .a-price:not(.a-text-price)')) || text(document, '#priceblock_ourprice, #priceblock_dealprice');
  const reviewLabel = document.querySelector('#acrCustomerReviewLink [aria-label*="Reviews"], #acrCustomerReviewLink [aria-label*="ratings"]')?.getAttribute('aria-label');
  const reviews = text(document, '#acrCustomerReviewText') || reviewLabel || '';
  return {
    asin, title, url: `${ORIGIN}/dp/${asin}`, price: priceValue(price),
    byline: text(document, '#bylineInfo') || null,
    availability: text(document, '#availability') || null,
    rating: ratingValue(document), reviewCount: countValue(reviews.replace(/\s+(?:global )?(?:ratings?|reviews?)$/i, '')),
    imageURL: document.querySelector('#landingImage, #imgBlkFront, #main-image')?.getAttribute('src') || null,
    features: [...document.querySelectorAll('#feature-bullets li .a-list-item')].map(element => clean(visibleText(element))).filter(Boolean),
  };
}
