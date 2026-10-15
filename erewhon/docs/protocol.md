# Erewhon protocol

The CLI uses Erewhon’s first-party HTTP services and the current website’s search interface. Native APK analysis establishes the web bridge and bearer-token handoff; current frontend code supplies the phone verification and shopping contracts. Runtime validation is recorded separately below.

## Artifact and source identity

The selected Android package is `com.erewhon.android` version `2.0.48`, APK SHA256 `75511297cc1e578bf12943c0ea83ee76b055a0fdcfdd8ff05e82735b62b55fce`. Native class inventory evidence is `ev_c22b367b4500b4d113129728b94ff2e3cdf117e6edda9fb7077448bf90b4842a`.

The current website is a separate source version. Relevant primary bundles are:

| Source | SHA256 | Contract |
| --- | --- | --- |
| [Shared app bundle](https://erewhon.com/_next/static/chunks/pages/_app-909a22f9f8b77849.js) | `0f01d1b0c83646da2b4877264dbec8c708e3d35ca1b5ec9ff8946cf2a4de9b56` | API URLs, form encoding, device UUID, cart context |
| [Authentication bundle](https://erewhon.com/_next/static/chunks/7126-0573d768d5a2c4cc.js) | `2a71bfa44aa5160822522a0dc82beddeff8360b80ae62bdd541cf157234fdd7b` | Phone submission, four-digit code, token storage and native bridge |
| [Webpack runtime](https://erewhon.com/_next/static/chunks/webpack-88d7ea337008026f.js) | Recorded in private source ledger | Exact lazy-chunk filenames |
| [Build manifest](https://erewhon.com/_next/static/ancsPwA61smepldk3aJDO/_buildManifest.js) | Recorded in private source ledger | Route-to-bundle mapping |

Shared app REA parent evidence `ev_ef5bcea6e52595a102dc112ed63f136e7f9094a38f319d30e6ccefdf54ddd795` parsed the selected source; its semantic graph reached the 100,000-node ceiling. Authentication parent `ev_07c1ad969d1c5c9ee2298b51f274c812ca864b4fdfa47635e481ca0476d63dd2` covers the selected auth chunk. Membership parents `ev_c386fd18b79ab18081aa8c403e4141557c8feb32240bbcc1da42c19beadfad07` and `ev_9f92b399995c053232fd98d336e3e1f7125c3a582b115d0945d3a32a532b37ef`, and ordering parent `ev_71a5914bfd71f1a634428e310136ae1b956022f2b3b0bd0460c0eb2ae17f0b6c`, have bounded static coverage. These IDs identify static observations, not executed requests or complete server behavior.

Private source ledgers retain original URLs, digests, exact excerpts and evidence. Account responses, tokens, phone numbers, payment identifiers and addresses are not included in this repository.

## Native bridge and transport

DEX-encoded constants identify `https://erewhon.com/` as the default WebView URL and `nativeBridge` as its interface name. `MyWebView` enables JavaScript and DOM storage, then registers `JSBridge`: evidence `ev_8590e23807b58b33ab161cb952282e8beb3092caa7b46c0d63d249940d3459bc`.

`nativeBridge.sendUserToken(token)` stores a nonempty raw token in native memory and a DataStore persistence coroutine: `ev_545e56f707b952101388633e4eab82ee42bd23e73ba7180209f53fdbc02221ce`. The DataStore key is `user_token`, evidence `ev_319af35bbadf824f52db2b44590e1d5ab6b22649f32d9654c289499fc9253f54`. The token is passed explicitly; this contract does not depend on copying a browser cookie. `sendToken()` retrieves a Firebase push token and is a separate bridge operation.

Retrofit uses `https://ordersapi.enfmkt.com/`, Moshi, and an OkHttp client with 20-second timeouts. The inspected interceptor only adds offline cache policy. Native `ApiErewhon` declares no-body POST `/v2/home`, authenticated no-body POST `/v2/myerewhon`, and form POST `/v1/device_token`. Authorization defaults to `Bearer ` plus the stored raw user token. Evidence: API inventory `ev_08725abb9e6f615b4ae9d4b7e87831ad9da62c5a1a234c8fdc44607e8184520b`, Retrofit builder `ev_ba5261721bc1272bf8c6e53c231b3403ce339914297ce7f1bb99522d7866e33c`, default bearer helper `ev_5653a2674a7da7047c7bd872d7b51068d9c8134693e8f47caf33a629336a9e97`. Constant values and abstract-method annotations were decoded from the selected DEX when the method view omitted them.

Current shared module `43984` URL-encodes scalar POST and PUT fields with the website’s RFC3986 encoding, preserving spaces as `%20` inside JSON-valued delivery times. DELETE fields are query parameters. Undefined form data means no request body. The CLI restricts this transport to the observed API origin and refuses redirects. Application error `0` is success; error `3` or HTTP `401`/`403` requires reauthentication. Requests are not retried by default; only explicitly declared read operations can request bounded retries.

## Authentication

Current module `57126` submits unauthenticated POST `/v1/login` with a ten-digit US `phone`. Error `0` opens a four-digit SMS challenge. Error `2` with `net_new_user` belongs to a registration branch; the CLI returns `registration_required` and stops.

Existing-account verification submits POST `/v1/phoneverify`:

| Field | Value |
| --- | --- |
| `phone` | Ten-digit US national number |
| `otp` | Four-digit string, preserving leading zeros |
| `userDetails` | JSON string `"{}"`; the login response’s profile is not resubmitted |
| `device_id` | Persisted local UUIDv4 |
| `cart_id` | Optional current guest cart ID |

Existing-account verification carries no temporary bearer. The website’s registration branch has distinct temporary-token and profile handling; that branch is not implemented. Shared module `6656` creates a UUIDv4 once with `crypto.randomUUID` or a cryptographic fallback and persists it as `device_id`. It is not hardware attestation.

Successful verification returns an opaque `token`, `user`, optional `cart_id`, and membership tier. The website stores the token as `URT` and passes the same value to `nativeBridge.sendUserToken`. Its `URTEnable=yes` cookie is a UI flag. The CLI retains a private candidate and validates GET `/v1/userprofile` against its nonempty `user._id`, then validates the recognized membership structure from POST `/v2/myerewhon`. That native response has `ecrs_data`, `current_tier` and `membership_data`; it does not require a root `user` or paid membership. Profile confirmation is established only by `ecrs_details_confirmed: "yes"` from the profile read.

A local `loginId` binds code completion to its current attempt. Stages are persisted before sending; crashes and uncertain requests prevent replay. A definite application-level code rejection permits an explicit corrected answer without resending SMS. Candidate validation can resume independently. The prior session remains until validation succeeds, and a returned migrated cart ID is then merged into shopping state.

No refresh endpoint, refresh credential or token expiry is implemented. Invalid opaque credentials require a new SMS login. The 15-minute login-operation window is a local limit, not a claimed server OTP or token lifetime.

## Account and purchase reads

| Operation | Contract |
| --- | --- |
| Profile | GET `/v1/userprofile` |
| Membership | No-body POST `/v2/myerewhon` |
| Rewards | POST `/v2/activitylog`, fields `type=accrual` or `redemption`, `page` |
| In-store history | POST `/v1/myorders`, `type=instore`, `pageno`, optional server filter keys |
| Online orders | POST `/v1/myorders`, `type=online`, optional server filter keys; no observed extra-page contract |
| Receipt | POST `/v1/transaction_detail`, `trn_cpk`, `trn_pk` |

Rewards pagination follows the source UI’s current-page row count, not a server total. In-store receipts use the transaction keys returned by history. Account normalization strips credential and payment-secret fields even in raw mode.

## Shopping and order submission

The store supplies its Algolia search index. Search uses the public application and search key shipped by the shared frontend, with the observed `DayOfWeek` and product facets. It does not send the Erewhon user token to Algolia.

Cart context comes from `/v1/ordermethod`; primary cart identity and `cart_type_id` are retained. Store selection uses `/v1/default_stores` and `/v1/select_ordermethod`. Delivery selects an account address with PUT `/v1/set_address/{id}`; a returned store-choice requirement is surfaced to the caller. Address serviceability uses `/v1/check_address`; explicit creation uses `/v1/add_address` after a successful check. Requests include the address fields and verified coordinates. A durable same-request journal prevents replay after an uncertain addition, and saving does not select delivery.

Product details, cart adds and cart updates preserve the server’s IDs and modifier data. Cart removal sets the selected row’s quantity to zero through `/v1/cart_update`; the observed `/v1/removeitem` decrements a quantity by one. The CLI refetches the cart after updates because mutation responses can contain stale quantities. `/v1/validate_cart` and `/v1/checkout_details` supply order eligibility, scheduling, tips, rewards, coupon, payment choice and `cart_amount_dtls`. Checkout eligibility must be recognized and true in both the fresh cart and quote. Unavailable products or a missing, negative or unrecognized total stop preparation and confirmation. Amounts are preserved from the server, not recomputed by the CLI. Selected times come from the server schedule; `--date MM-DD-YYYY` matches `date_mdy` when a clock time appears on several days. The observed place-order request submits those server amounts and the selected pickup or delivery time.

Preparation creates a five-minute review. Confirmation binds it to the account and rechecks cart contents, amounts, location, time and payment. Purchase comparison retains product identity, name, size, ingredients and price while excluding catalog rankings, synchronization timestamps and generated attribute IDs. ASAP comparison binds the service date and relative duration; its rolling clock estimate may refresh within the five-minute review. Scheduled windows remain exact. New plans use format version 2; older prepared plans require a fresh review. A durable operation journal is written before `/v1/place_order`. `/v1/get_order_place` is used to inspect uncertain outcomes. A timeout, interrupted submission, or additional payment authentication blocks another order instead of replaying payment. Review plans bind the current token, while operation inspection binds the stable account and device identity so the same account can reconcile after reauthentication. A matching active journal can recover an interrupted per-operation journal write.

The order flow covers ordinary pickup and delivery carts with supported saved payment methods. Preorders, subscriptions, new card entry, payment challenge completion and cancellation are outside the implemented contracts. Address creation requires caller-supplied verified coordinates; no geocoder is implemented.

## Validation

On 2026-10-14, the native Linux ARM64 HTTP pilot completed SMS login and verification, profile and native membership reads, rewards and purchase history with successful API responses. The production CLI then validated the exchanged candidate and successfully ran profile, membership, rewards, online and in-store history, fulfillment, stores, saved addresses, cart, categories, product details, paginated search and address serviceability checks. No Android runtime, browser or display was used for those steps. Captured responses also replayed offline through production authentication and promoted the matching account token after both validation reads.

A three-bottle test cart produced live pickup and delivery checkout quotes and review plans using the existing saved payment method. Scheduled pickup also prepared using actual server `date_mdy` and time values. ASAP was restored, and final cart removal plus a separate read confirmed zero products and rows with the original pickup selection restored. No `/v1/place_order` request was sent. Paid submission, address creation and uncertain-order reconciliation use source contracts and simulated responses; no paid live order was placed.

All 121 tests passed on macOS Node 24.19, native Linux ARM64 Node 24.21, and Docker Node 22.23.3 with networking disabled. Checks cover private state and four-process locking, auth uncertainty/crash recovery, strict identity/native shapes, URL-encoded methods, pagination, address writes, cart removal, scheduling, payment choice, current eligibility, malformed totals, changed reviews, concurrent confirmation and journal recovery. The tested platforms and live reads do not establish every backend challenge or a complete paid checkout flow.
