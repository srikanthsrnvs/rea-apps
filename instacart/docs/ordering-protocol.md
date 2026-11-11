# Native carts and orders

The customer Android package `com.instacart.client` uses Apollo GraphQL for its
cart, order-history and checkout flows. These observations come from the pulled
APK, SHA-256 `f6e451263f43a1169aab0319244b17d77c7ace598f5666cb3a61da60d0d50dd1`.
Static source recovery establishes request contracts; it does not establish that
a live account has accepted a mutation or that an order has been purchased.

`src/ordering-queries.json` retains complete native document strings. Their exact
bytes matter: the transport sends registered persisted-query hashes, and a
shortened selection set produces a different hash. For example,
`nj0.ph.id()` returns
`523a329c0b171c6ca5341085f98a8022da9648dac677fa2937b580134a07a456`,
matching SHA-256 of the recovered `UpdateCartItems` document.

| Operation | Native class | Contract |
| --- | --- | --- |
| `UserCarts` | `rl0.u1` | `limit`, optional `empty`, shopping-mode filter and `shopId`; returns cart summaries. |
| `ReadCartData` | `nj0.ue` | `id`; returns cart, timestamp, basket product references and absolute quantities. |
| `CartTotals` | `nj0.s3` | `cartId`, optional `shopId` and `postalCode`; returns item pricing, subtotal, savings and unpriced lines. This is not the final checkout price. |
| `AllocateBackgroundCart` | `zp1.l` | `shopId`, `cartType`; returns a cart ID or typed allocation error. |
| `UpdateCartItems` | `nj0.ph` | `cartItemUpdates`, optional cart ID/type, request timestamp and completed required action. |
| `OrderDeliveriesConnection` | `hz1.s0` | `first`, optional opaque `after` cursor and `addressId`; returns order deliveries and `pageInfo`. |
| `OrderDeliveries` | `a02.l8` | legacy `orderId`; returns order-delivery status, permitted actions and purchased items. |

The cart mutation input serializer `we1.d.toJson`, case 1, verifies required
`itemId` and floating-point `quantity`; optional fields include `quantityType`,
`selectedOptions`, `specialInstructions`, `structuredNoteId` and `trackingParams`.
Quantity is the desired final quantity. A zero quantity removes the item. The CLI
supports ordinary items and notes; configured-item options are not exposed.
`CartsCartItemUpdateQuantityType` contains `each` and `weight`. Native cart kinds
include `grocery`, `catering`, `party`, `list`, `community`, `clubMembershipSale`,
`inStoreOrderAhead` and `delegatedCheckout`; the CLI supports `grocery` only.

`UpdateCartItems` returns one of:

- `CartsCartItemUpdateSuccessResponse`, including the updated cart;
- `CartsCartItemUpdateActionRequiredResponse`, such as acknowledging another
  retailer; the CLI reports this and does not silently approve it;
- `CartsCartUpdateError`, including a machine-readable error type and display text.

Reading a cart requires only its ID. Estimated totals also require the shop ID
and postal code: the backend rejects missing pricing context even though its
GraphQL variables are declared optional. The CLI reads contents without pricing
when that context is absent.

Cart writes are sent once. A transport failure after sending a request is not
proof that the cart was unchanged. Read the cart before deciding whether to
repeat a write. The module strips analytics metadata and private receipt URLs
from normal results.

## Checkout contracts recovered

`checkout prepare` validates a nonempty cart, its retailer/service, and an
existing saved address. It initializes a checkout draft, fetches its actual
invoice, and returns the selected service window, delivery instructions, tip,
payment display, fee lines, total and separate authorization hold. Missing
requirements and missing review fields remain explicit. Native checkout/session
tokens, payment references and raw resources stay in a private local preview
record. Preparing a preview does not place an order or submit a payment. Preview
expiration is a local 15-minute limit, not a promise about server validity.

The full documents for `InitializeCheckout`, `UpdateCheckout`,
`CheckoutDraftOrderInvoiceV2`, `CheckoutCalendarAvailability`,
`CheckoutPricedServiceOptionsForDateRange` and `FinalizeCheckout` are retained for
continued integration. Only initialization and invoice retrieval are exposed; their existence does not
imply live purchase support.

`InitializeCheckout` accepts a cart/shop, `CheckoutInputsUserLocation`, service
mode, optional payment client information, checkout items and tracking context.
`CheckoutInputsUserLocation` contains optional `addressId`, `postalCode` and
coordinates. The `Service` enum contains `DELIVERY`, `PICKUP`, `VIRTUAL`,
`SCAN_AND_PAY` and `INSTORE`.

Initialization returns either typed address/serviceability errors or
`CheckoutInitializeCheckoutSuccessResponse`, with a checkout session, resource
requirements, current resource selections, resource collection and required
checkout steps. The subsequent update input supports service option, delivery
instructions, compliance, phone/email, tips, payments, loyalty and other resource
updates. Supplying a cart alone does not prove these required selections are
complete or that the chosen payment, address, window and tip are acceptable.

`CheckoutDraftOrderInvoiceV2` returns the selected payment display, authorization
amount/currency, final invoice lines and disclaimers. These must be included in
a review before a purchase is offered. `FinalizeCheckout` can return a successful
order-delivery ID, an already-confirmed order, validation errors, or a required
next action such as payment authentication. A purchase implementation must save
the exact reviewed terms and request attempt durably, revalidate them before
confirmation, handle additional authentication explicitly, and reconcile an
uncertain result by order/checkout identity without blindly retrying finalize.
No purchase, cancellation or payment setup is exposed by these modules.

## REA evidence

Full private evidence and APKs are kept outside the repository. Selected REA
Evidence IDs for reproducible static observations:

| Observation | Evidence ID |
| --- | --- |
| Cart mutation document | `ev_016c775534baaeab23d0394f0e622d72cc4aed20465124309a1d1708105bd373` |
| Native cart mutation persisted-query ID | `ev_c59e9ce64612e2d1c7485e16d0d5043160feb23769e2948f74a94a0c1fadf1ea` |
| Cart variable serialization | `ev_8ea9e353fbf667a9755f5365297f95135dee45b83779649c4cb49d31ab2eaf2a` |
| Cart input serializer | `ev_7bc3c4b2f1053bd968dd9331565cb48bff09d43815967ccac185c69e3e3d221c` |
| Native cart update operation | `ev_49bf90c46ce8fdaffacae6db705f2d8d48a6e2d342f5d4d7bac0b3dbc6278c38` |
| Cart list document | `ev_657ece9bf7265635556aacac7377ae4c7ac8f393cfb48c82633350b8236616fa` |
| Cart data document | `ev_7b880c853b70b2aa98e0ed6a253fee52b93658cc59b7519c7aa6f54b133b786f` |
| Cart allocation document | `ev_7dd70a9f4464e126d8cbed7d572795f2b06476fa40490d7ad43aa472549157c2` |
| Order-history document | `ev_7dfd0e71d2ce7906bab97ff0619482b048c532c70300e8e26fa4de4869fd43c7` |
| Order details document | `ev_4de4f24933b5ca089db951d22fb434d8c7a9f5781856befe4afd4cd060ed99ee` |
| Checkout initialization document | `ev_286e8c3bd976c074c84b22f8602f0b1c3b2a0c7eefa7c74ddad80e21139d42b7` |
| Checkout update document | `ev_e621cd614de9925d4ed410d2a998988669b87804169d07b0acf052d7f087cf6f` |
| Checkout finalization document | `ev_a554363758465db82b1c791a50f0b37d3c3367489015cabedcf846ce0533f653` |

## Live validation (2026-10-29)

A native phone-OTP session accepted cart list/read, order-history pagination and
order-detail requests directly over HTTP. The reversible cart test used an
existing empty Ralphs grocery cart: one ordinary coffee item was set from zero
to one, read back at one with its $7.99 item subtotal, then restored to zero and
read back empty. No unrelated cart items were changed.

Native checkout initialization and invoice retrieval then succeeded with that
temporary item. The actual `prepareCheckout` module returned the selected
20–45-minute service window, $2.00 tip, $22.07 invoice total, a distinct $22.73
authorization hold, and selected payment display, with no outstanding required
resources or missing review fields. The test item was removed afterward and the
cart was verified empty. No `FinalizeCheckout` request was made. Pickup preview
uses the same recovered contract but has not been live tested.

`AllocateBackgroundCart` returned HTTP 500 for this account. Cart creation is
therefore excluded from the public command/tool surface; use an existing cart
returned by `carts`. The recovered allocation document remains investigation
evidence.
