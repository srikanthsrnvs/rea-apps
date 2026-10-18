# Native Uber Eats protocol

The implementation is under `src/eats/`: `cli.mjs` parses the compact CLI; `service.mjs` coordinates account locks, fresh reads, plans and mutation journals; `discovery.mjs` and `orders.mjs` normalize responses; the two protocol modules construct the native cart and authorized cancellation requests. It shares Uber's OAuth refresh, integrity exemption and private state store. There are no runtime dependencies beyond Node built-ins, no browser processes and no Android connection.

## Sources

REA inspected the installed Android Rider **4.652.10004** (`com.ubercab`, base APK SHA-256 `0cff00bf973ff4fba891966a624b5717b186a1dae04ad9355abc74044bf2b2b3`) and Eats **6.344.10001** (`com.ubercab.eats`, base SHA-256 `f25b14fb027b905a6cdda40501940a715694a1fbc7cabc486178bbce11091263`). Shipped Retrofit annotations, selected generated serializers and actual native callers were inspected separately. APKs, captures, account responses and tokens remain outside this repository.

Relevant classes include `SearchApi`/`SearchRequest`, `EatsApi`/`EatsClient`, `EatsEdgeApi`/`EatsEdgeClient`, the generated cart/checkout DTOs, `OrderCancellationInteractor` and `ES4Client`. Source evidence IDs identify private retained observations; they are not network credentials:

- Standalone APK inventory: `ev_7947ee4a7f3429bf148a84b50af9b94c548d5fe521b931e81eb8fc18857cd419`.
- New cart sends **items only**, allowing the server to create persisted cart identity: `ev_792415cf576d859304f7cd9a8246cd6e94cafba26245a8d676ff0e59d63f61e7`.
- Native creation defaults and item consumer assignment: `ev_3982f664b16796cf8def0ac4e5313773e88c392a1e0a82d4526960f3aaa8e559`, `ev_7b1df156385027910bb763da76bf872d86ea56a86283dcb280f1571c8cd5afd6`.
- Item request wrapper: `ev_c2b2fb1530be852212522c27d8122399197bc5f0800bd10e432fdb1537dee24a`.
- Selected-location headers: `ev_b160d4d59c6f33126dbda1b47f9fe9194da39d464bf6b73d2b32a2c244271525`.
- Native tip conversion copies legacy minor units into a misleadingly named `amountE5` field: `ev_1e06df27698f23de27ea58d74a63a634cf46ab6043301ec36729c11c0a7a4a92`.
- Cancellation preview, eligibility, displayed terms and whole-action fulfillment: `ev_81822a1721a5fefa3971d13d46bafc83e477a485dc12144c73cd3f8e0118678d`, `ev_5e6410df1111ad2635e1e2327d7ce930e91c23158183bfa417b690ce015edddc`, `ev_b872ab0e1664660056770ddbbf0bc64983323fe1054da5398498215ddd036067`, `ev_f3431bfb6300f43568b336b7101348bb1ed2f6c88b40d23722f5b4bbf8175b56`.

## HTTP contracts

All calls use the existing authenticated client. Selected delivery/order coordinates go in `x-uber-target-location-latitude` and `x-uber-target-location-longitude`; these describe the requested order location, not fabricated GPS readings.

| Operation                       | Native endpoint                                                                                                                                                                       | JSON body                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Search food/restaurants         | `POST /rt/eats/v2/search`                                                                                                                                                             | Direct `SearchRequest`: targetLocation, userQuery, diningMode, searchType, searchSource, pageInfo |
| Restaurant/menu                 | `GET /rt/eats/v2/eater-store/{store}`                                                                                                                                                 | Query diningMode, targetLocationLatitude/Longitude, catalogSectionOffset                          |
| Full item/modifiers             | `POST /rt/eats/v1/eater-items`                                                                                                                                                        | `{request:{storeUuid,sectionUuid,itemUuids,eaterUUID,...}}`                                       |
| List/read drafts                | `POST /rt/eats/v2/eaters/get-draft-orders-by-eater-uuid`, `get-draft-order-by-uuid`                                                                                                   | `{request:{...}}`                                                                                 |
| Draft edits                     | `POST /rt/eats/v2/eaters/create-draft-order`, `add-items-to-draft-order`, `update-item-in-draft-order`, `remove-items-from-draft-order`, `update-draft-order`, `discard-draft-orders` | Typed native DTO in `{request:{...}}`                                                             |
| Priced review                   | `POST /rt/eats/v2/eaters/checkout-mobile-presentation`                                                                                                                                | Explicit native payloadTypes and draftOrderUUID                                                   |
| Submit food order               | `POST /rt/eats/v2/eaters/checkout-orders-by-draft-orders`                                                                                                                             | Typed checkout DTO in `{request:{...}}`                                                           |
| Active orders                   | `POST /rt/eats/v2/eaters/active-orders`                                                                                                                                               | `{request:{}}`                                                                                    |
| History                         | `GET /rt/eats/v1/eaters/{eater}/orders`                                                                                                                                               | Query limit and opaque cursor; returns paginationData.nextCursor                                  |
| Cancellation options            | `POST /rt/eats/v1/orders/{uuid}/resolution/options`                                                                                                                                   | `{request:{issues:[{issueType:"CANCEL",order:{uuid:ORDER_ID}}]}}`                                 |
| Execute authorized cancellation | `POST /rt/eats/v1/orders/{uuid}/resolution/actions`                                                                                                                                   | `{request:{actions:[WHOLE_AUTHORIZED_ACTION]}}`                                                   |

The braces in the two ES4 routes are literal, matching the native declaration and caller. The order identity is inside the request issue, not substituted into the path. A read-only completed-order probe reached the native service and returned `palantir.no.active.internal.order`. The CLI never falls back to a blind legacy DELETE.

## Pagination, identities and units

Search results follow native `feedItems` order; `storesMap` also contains unranked cache entries and must not be treated as the ranked result list. Search retains the requested offset/page size and server end flag. Menus use catalog-section offsets; an unsupported page-size flag is not exposed. History preserves the opaque next cursor. Unknown feed components are reported rather than fabricated into restaurants.

Draft ID, persisted cart ID, cart-line ID, menu SKU ID, section/subsection IDs and order/workflow IDs are distinct. Creation lets Uber allocate the cart ID. Required nested modifiers are checked using fresh item details, including selected child groups, min/max constraints and availability.

Checkout totals use exact E5 integers, normalized as decimal strings to avoid floating-point loss. The native wire uses signed `{high,low,unsigned:false}` integers. **Tip requests are the exception:** native `g34.a.b` copies a legacy currency minor-unit amount directly into the field named `amountE5`. For USD, a $2 tip is a wire value of **200**, while $2 in a checkout total is **200000**. The CLI obtains currency precision from the item response, converts explicitly, and verifies both the retained tip and selected standard/custom tip before returning a plan. For zero, native UI can leave every option unselected; the CLI additionally verifies that final and pre-tip server totals agree. This behavior was verified against real unpaid drafts; field names alone were insufficient evidence.

## Mutations and approval

All mutation calls run under the existing account state lock and use a durable local operation journal. A call UUID is not assumed to provide server idempotency. Purchases and cancellations never automatically retry. A lost response remains uncertain until status/history or the saved operation establishes the outcome.

Checkout prepares an account-bound plan, then confirmation rechecks the selected draft, the draft included in checkout presentation, items, fulfillment, address, instructions, credits, payment, tip and exact current total. The plan must still be valid immediately before submission. This is a client freshness check; no unsupported server-side maximum-charge guarantee is claimed.

The non-bundle purchase caller permits absent device/payment metadata. Its native security provider explicitly returns an empty attestation string when disabled/unavailable; the CLI uses that legitimate fallback and `shareCPFWithRestaurant:false`. It does not fabricate device attestations or enable payment bypass flags. Accounts requiring additional attestation or payment actions may still reject submission; that remains a reported, journaled outcome.

Cancellation requires current active-order identity and both `AUTH_CANCEL` and `CANCEL_FEEDBACK` eligibility actions. The plan exposes exact server confirmation text, final charge rows and any overriding modal. It does not infer free cancellation from absent values or guess the units of opaque charge fields. Confirmation retrieves current terms again, blocks changed terms, and submits the complete fresh authorized action. Only a matching completed action is accepted; `cancelled` is reported only after matching history says `EATER_CANCELLED`. Otherwise the result remains `cancellation_submitted` and requires status/history reconciliation.

## Verification and limits

Verified on the headless ARM64 Orin with existing Uber credentials: token refresh; food search; ranked pagination; restaurant menus; full item modifiers; draft creation, add, update, remove and discard; priced checkout with explicit zero and $2 tips; active-order list; history with server cursor; and a completed-order cancellation-options business rejection. A subsequent user-authorized paid food purchase was confirmed through matching active-order identity, items and total. Its immediate checkout response required status reconciliation; uncertain submissions must never be repeated blindly. Active-order cancellation authorization/fulfillment retains native-source and simulated-service coverage.

Delivery tracking uses the same native active-order presentation, including courier coordinates, original vehicle artwork, encoded road route, native status stages, ETA and delay text. Its read-only iframe, NDJSON/SSE lifecycle hooks and exact-origin parent messaging are documented in [Eats tracking](eats-tracking.md). Native polled presentation was verified on the real delivery; native Eats push and exact visual parity remain unverified.

Group, business, scheduled, bundle/split-payment carts, restricted-item acknowledgements and additional payment verification are rejected until their full flows are supported. Unknown contract shapes fail explicitly. Private native endpoints can change; source and live-contract verification are both needed when updating them.
