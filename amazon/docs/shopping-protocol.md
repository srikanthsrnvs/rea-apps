# Shopping protocol observations

Target: `com.amazon.mShop.android.shopping` 32.18.0.100, versionCode 1243240206. Base APK SHA256 `4dedce3983286cd19e990de172d3db1155f7d5eeba4c8b2746bf12c1bb1c0089`. Investigation used REA/JADX and bounded direct HTTP captures. APKs, shared SDK secrets and account captures are private and excluded from Git.

## Source and live reads

Active general search uses embedded retail HTML. `SearchServiceImpl.getSearchFragment`, `SearchHandler.handle` and `WebSearchUrlBuilder` construct `/s?k=...` against the secure retail host. REA evidence: `ev_ad955a1ce5fbd73d8877dac2918740dee4345009302801d2007c8feb5de13268`, `ev_fca6bf89b29a8810e66f382e5a4409bff4058e9a1d0c00a5655f98878793a8ab`, `ev_0277c28f7b19bd0e95c2a2526a6adc39cde68627e982fff5f1430b997bbc7baf`.

`ApplicationInformationImpl.getUserAgent` constructs `Amazon.com/{version} (Android/{release}/{model})`; `MShopWebViewManager` applies it directly. REA: `ev_03598851ecc361390f13560250bb9d35b5a243048a407867837a1a5ba2b58ab8`, `ev_732e90efad0b8806644df5141c68c2b17a957eb7df4af412ec004f5e98c5c372`. The compatibility profile uses public version/model strings, not copied device identifiers or hardware proof.

The search parser correlates each result ASIN with its encoded `s-long-press-actions-component` payload, extracts catalog fields and omits session/tracking data. Pagination uses source links. Products use the observed `/dp/{ASIN}` document. A native signed product AAPI exists, but its embedded shared SDK credential is unnecessary for this implementation and is not distributed.

MAP's cookie bridge supplies retail cookies: `AccountCookiesSyncManager`, `MAPCookiesFetcher`, `CookieHelper`; REA `ev_1df83b598213601de76c67710ef572b4e9fe56b63d19aa9e373cc20dce4abdaa`, `ev_3e33d2be8c6244cc8340ad3f8eecf4dffce250d55dd0ead9a6ed0b3349e644bc`, `ev_4519a067a14c612550823806dbdf97931c70efb4b0f0440f5b57e1e8d252f69c`.

## Cart and checkout captures

Order history supplied the cart link `/gp/aw/c?ref_=navm_hdr_cart`. It returned 503 with the app profile and HTTP 200 with the documented desktop compatibility headers. Adding ordinary display/app cookies alone did not fix the route. No browser or JavaScript execution was used in the successful request.

Cart items are `#sc-active-cart .sc-list-item` with source item IDs, ASIN, quantity and selection. Displayed prices/subtotal are read separately from hidden UI message templates. `gutterCartViewForm` is a GET to `/checkout/entry/cart`, with opaque fields preserved.

Checkout returned optional Prime enrollment. Its exact `#prime-decline-button` link targets `/checkout/p/{purchase}/prime/handler?action=decline`. Following that source link returned a complete review over HTTP: `#subtotals-marketplace-table`, `#deliver-to-address-text`, `#payment-option-text-default`, selected delivery radios and line items. A hidden ASIN marker in each description block correlates the checkout items to the cart. The final `spc-form` POSTs to `/checkout/p/{purchase}/spc/place-order` with CSRF and `placeYourOrder1`. **The final POST has not been live submitted.**

The inspected product's `addToCart` form POSTs to `/cart/add-to-cart/...`, with ASIN, quantity, offer listing and CSRF fields. The adapter accepts the single-product, one-unit action. Cart deletion uses the matching `submit.delete-active.{sourceItemId}` submitter in `activeCartViewForm`. Neither operation has been live submitted.

Order history used `past-purchase-tile`. Cancelled receipts used `.od-modernized .od-container`; delivered item landing pages used `section#pop` with a source full-receipt link. No inspected order supplied an eligible cancellation action. Cancellation support is therefore a source-form adapter with simulated tests, not a claimed successful live cancellation exchange.

## Signing boundary

Optional WebView attestation is gated by `ANDROID_WEBVIEW_ATTESTATION_GATING_1390701=T2`. Genuine bootstrap requires a server nonce and AndroidKeyStore attestation certificate chain before establishing a short-lived RSA/HMAC session. StrongBox fallback still uses AndroidKeyStore. No fabricated certificate or attestation was submitted. Those optional headers were not needed for successful cart/checkout reads; earlier 503 responses do not establish an attestation requirement.

## Submission rules

Plans omit hidden source credentials from public previews, belong to the current account/CLI device, expire after five minutes and are revalidated before mutation. Submitter overrides outside the recognized action are rejected, even if first-party. Each final POST has a preceding durable journal. Unknown outcomes block new mutations instead of replaying requests. Simulated tests exercise changed terms, account replacement, disabled buttons, destination overrides, timeout uncertainty and repeated confirmation calls.
