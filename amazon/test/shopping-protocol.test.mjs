import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeUserAgent, buildSearchURL, parseSearchHTML, parseProductHTML, retailURL } from '../src/shopping-protocol.mjs';

const page = content => `<!doctype html><html><head><title>Amazon Shopping</title></head><body>${content}</body></html>`;
const escapeAttribute = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const payloadAttribute = value => escapeAttribute(escapeAttribute(JSON.stringify(value)));
const example = {
  asin: 'B0GS5M96KD', title: 'Travel Charger & USB C Adapter', price: '$79.99', currency: 'USD',
  num_reviews: '121', star_rating: 'FOURANDHALF', image_urls: ['https://m.media-amazon.com/images/I/example.jpg'],
  prime: false, csrf_token: 'not-a-real-token', detail_page_url: '/sspa/click?url=%2Fdp%2FB0GS5M96KD',
};

test('native user agent follows the source template with configurable public device metadata', () => {
  assert.equal(nativeUserAgent(), 'Amazon.com/32.18.0.100 (Android/16/Pixel 10 Pro Fold)');
  assert.equal(nativeUserAgent({ version: '1', androidVersion: '17', model: 'Test' }), 'Amazon.com/1 (Android/17/Test)');
  assert.throws(() => nativeUserAgent({ model: 'Test\r\nCookie: secret' }), { code: 'INVALID_ARGUMENT' });
});

test('search query encoding and returned cursor preserve the server query', () => {
  assert.equal(buildSearchURL('coffee & tea'), 'https://www.amazon.com/s?k=coffee+%26+tea');
  assert.equal(buildSearchURL('charger', { page: 2 }), 'https://www.amazon.com/s?k=charger&page=2');
  const cursor = 'https://www.amazon.com/s?k=charger&page=2&opaque=a%2Bb%3D&ref=next';
  assert.equal(buildSearchURL(null, { cursor }), cursor);
  assert.throws(() => buildSearchURL(''), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => buildSearchURL('charger', { page: 0 }), { code: 'INVALID_ARGUMENT' });
});

test('pagination never accepts another origin, credentials, insecure URLs, or a mutation route', () => {
  for (const cursor of ['https://www.amazon.com.evil.example/s', 'https://www.amazon.com@evil.example/s', 'http://www.amazon.com/s', 'https://www.amazon.com:444/s', 'https://www.amazon.com/cart']) {
    assert.throws(() => buildSearchURL(null, { cursor }), { code: 'INVALID_URL' });
  }
  assert.equal(retailURL('/dp/B0GS5M96KD'), 'https://www.amazon.com/dp/B0GS5M96KD');
});

test('search reads the app card JSON without exposing embedded session or tracking fields', () => {
  const html = page(`<div data-component-type="s-search-result" data-asin="${example.asin}" class="s-result-item AdHolder">
    <div data-payload="${payloadAttribute(example)}"></div><h2>A shortened title</h2>
    <span aria-label="4.6 out of 5 stars"></span>
  </div><li class="a-last"><a href="/s?k=travel&amp;page=2&amp;opaque=a%2Bb">Next</a></li>`);
  const value = parseSearchHTML(html, { url: 'https://www.amazon.com/s?k=travel' });
  assert.equal(value.items.length, 1);
  assert.deepEqual(value.items[0], {
    asin: example.asin, title: example.title, url: 'https://www.amazon.com/dp/B0GS5M96KD',
    price: { display: '$79.99', amount: 79.99, currency: 'USD' }, rating: 4.6, reviewCount: 121,
    prime: false, sponsored: true, imageURL: example.image_urls[0],
  });
  assert.equal(value.pagination.next, 'https://www.amazon.com/s?k=travel&page=2&opaque=a%2Bb');
  assert.ok(!JSON.stringify(value).includes('not-a-real-token'));
  assert.ok(!JSON.stringify(value).includes('sspa'));
});

test('search requires payload ASIN correlation and falls back to visible card fields', () => {
  const html = page(`<div data-component-type="s-search-result" data-asin="B0GS5M96KD">
    <div data-payload="${payloadAttribute({ ...example, asin: 'B012345678', title: 'Unrelated' })}"></div>
    <h2>A genuine card title</h2><span class="a-price"><span class="a-offscreen"> </span><span class="a-price-symbol">$</span><span class="a-price-whole">12<span>.</span></span><span class="a-price-fraction">34</span></span>
    <i class="a-icon-prime"></i><a href="/dp/B0GS5M96KD#customerReviews"><span class="a-size-small">1.2K</span></a>
  </div>`);
  const [item] = parseSearchHTML(html).items;
  assert.equal(item.title, 'A genuine card title');
  assert.equal(item.price.amount, 12.34);
  assert.equal(item.reviewCount, 1200);
  assert.equal(item.prime, true);
});

test('ranges remain display prices and never become a falsely precise quote', () => {
  const html = page(`<div data-component-type="s-search-result" data-asin="${example.asin}"><div data-payload="${payloadAttribute({ ...example, price: '$10.00 - $20.00' })}"></div></div>`);
  assert.deepEqual(parseSearchHTML(html).items[0].price, { display: '$10.00 - $20.00', amount: null, currency: 'USD' });
});

test('empty results and unrecognized or challenge pages have different outcomes', () => {
  assert.deepEqual(parseSearchHTML(page('<h2>No results for "nothing"</h2>')).items, []);
  assert.throws(() => parseSearchHTML(page('<div>Something unexpected</div>')), { code: 'UNRECOGNIZED_RESPONSE' });
  assert.throws(() => parseSearchHTML(page('<form action="/errors/validateCaptcha"><input id="captchacharacters"></form>')), { code: 'AMAZON_CHALLENGE' });
  assert.throws(() => parseSearchHTML(page('<form name="signIn"><input id="ap_password"></form>')), { code: 'AUTH_REQUIRED' });
});

test('disabled or untrusted pagination links cannot become follow-up requests', () => {
  const body = `<div data-component-type="s-search-result" data-asin="${example.asin}"><h2>Charger</h2></div>`;
  assert.equal(parseSearchHTML(page(`${body}<li class="a-last a-disabled"><a href="/s?page=2">Next</a></li>`)).pagination.next, null);
  assert.equal(parseSearchHTML(page(`${body}<li class="a-last"><a href="https://evil.example/s?page=2">Next</a></li>`)).pagination.next, null);
});

test('mobile product HTML retains title differentiators and excludes script contents', () => {
  const html = page(`<div id="title_feature_div"><h1><span id="title">Travel Charger</span><div>100W USB C</div></h1></div>
    <div id="corePriceDisplay_mobile_feature_div"><span class="a-price"><span class="a-offscreen"> </span><span class="a-price-symbol">$</span><span class="a-price-whole">79<span class="a-price-decimal">.</span></span><span class="a-price-fraction">99</span></span></div>
    <div id="availability">In Stock<script type="a-state">{"private":"must not be returned"}</script></div>
    <a id="acrCustomerReviewLink"><span class="a-icon-alt">4.6 out of 5 stars</span><span aria-label="121 Reviews">(121)</span></a>
    <img id="main-image" src="https://m.media-amazon.com/images/I/example.jpg">
    <div id="feature-bullets"><ul><li><span class="a-list-item">Charge four devices.</span></li></ul></div>`);
  const value = parseProductHTML(html, { url: 'https://www.amazon.com/dp/B0GS5M96KD' });
  assert.equal(value.title, 'Travel Charger 100W USB C');
  assert.deepEqual(value.price, { display: '$79.99', amount: 79.99, currency: 'USD' });
  assert.equal(value.availability, 'In Stock');
  assert.equal(value.rating, 4.6);
  assert.equal(value.reviewCount, 121);
  assert.deepEqual(value.features, ['Charge four devices.']);
  assert.ok(!JSON.stringify(value).includes('private'));
});

test('product parsing rejects documents without a product identity and title', () => {
  assert.throws(() => parseProductHTML(page('<div>A product-like page</div>'), { url: 'https://www.amazon.com/dp/B0GS5M96KD' }), { code: 'UNRECOGNIZED_RESPONSE' });
});
