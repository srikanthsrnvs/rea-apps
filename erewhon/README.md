# Erewhon CLI

Headless HTTP tools for Erewhon SMS login, account information, membership, rewards, purchase history, product search, pickup and delivery carts, and reviewed order submission. Commands return JSON; `erewhon tools` exposes the recommended interface for models. `tools --profile ordering` gives a small model six ordering tools (including saved recipes and delivery addresses); `tools --advanced` includes the native ID/file interface.

The runtime needs Node.js 22.19 or newer. Login accepts the verification code in the CLI. No Android device, Java, browser, display server, tunnel, or developer API key input is required. Search uses the public search key shipped by Erewhon’s website.

## Install

On Linux, from the repository root:

```sh
./scripts/setup-linux.sh --erewhon-only
export PATH="$HOME/.local/bin:$PATH"
erewhon tools
```

The installer supports Linux x86_64 and ARM64, reuses a compatible Node runtime, or downloads and verifies one. Use `EREWHON_NODE=/absolute/path/to/node ./scripts/setup-linux.sh --erewhon-only` to select a runtime explicitly. The downloaded runtime requires glibc 2.28 or newer.

On macOS, with a compatible Node runtime:

```sh
cd erewhon
npm install --global .
erewhon tools
```

There are no npm runtime dependencies. Installation does not copy an Android session or credentials from another app.

## Tool profiles and compatibility

`erewhon tools` is the recommended agent view. `erewhon tools --profile ordering`
is a focused ten-tool view. `erewhon tools --advanced` is the complete inventory:
all 30 original tools and their parameters plus every new helper (41 tools in
all). Focused profiles do not remove CLI commands. Paginated/faceted search,
full product details, address management, direct cart edits, scheduled checkout,
card/tip/coupon/reward controls and order reconciliation remain available.
See [compatibility and verification](docs/compatibility.md) for coverage and
known model limitations.

## Open-ended discovery

`product_find` includes native descriptions, ingredients and serving facts for
up to three candidates in broad searches. Reuse these for a short, grounded
shortlist; use `product_options` for missing facts or customization choices.
A fixed serving such as 20 oz is not a selectable size. Unknown ingredient,
allergen and nutrition information must not be invented. Optional additions
are not required to order the standard recipe.

The [open-ended Pi/Qwen evaluation](eval/open-ended/README.md) records a real
smoothie conversation before and after this change. Discovery improved, but
Qwen still dropped a taste preference and overstated a blocked preparation.
The report explicitly grades that scenario as failing; verified structured
cart/order state remains authoritative.

## Cart-only favorites and follow-up edits

Use one call per user turn; no search, native IDs, temporary files or checkout:

```sh
erewhon cart add-saved --name "my usual coffee"
# Copy itemRef from the returned cart; this sets three TOTAL, not three more.
erewhon cart set-quantity --item-ref ITEM_REF --quantity 3
```

The matching agent tools are `cart_add_saved({name})` and
`cart_set_quantity({itemRef, quantity:3})`. Both return the verified server cart,
including choices, quantities and references for subsequent edits. Saved names
accept spaces and a leading "my"; missing names stop without guessing another
recipe. Adding resolves the current product and modifier identities. An optional
quantity on `cart_add_saved` overrides a single-item recipe for this cart only.
Ambiguous spoken names stop and return the exact saved names to choose from.
Saved preferences remain unchanged. Occupied carts outside the unchanged saved
draft stop without replacing anything. Different customizations have different
references. An interrupted edit can be inspected with `cart_view`; setting the
same absolute quantity again makes no mutation if it is already correct.

These calls do not quote checkout, reserve inventory or buy. When the user later
requests checkout, use `order_prepare_cart` (`erewhon order prepare`) to review
the current cart. Edits invalidate prior approval: show a fresh review before
`order_confirm`. Existing low-level cart commands remain available for scripts.

## Recommended agent workflow: named recipes

Save what the user wants, not the backend's IDs. The CLI resolves the current
catalog reference, native product, serving size and modifiers for each new
recipe draft. A recurring order needs two agent calls:

```sh
# One-time setup; edit the example for the user's exact choices.
erewhon recipe save --name usual-coffee --request erewhon/examples/cappuccino.json

# Each order: resolve fresh identities, build/verify the cart and return a review.
erewhon order prepare --recipe usual-coffee

# Only after the user approves that review:
erewhon order confirm --plan-id PLAN_ID --confirm

# After an interrupted tap/call, inspect this instead of submitting again:
erewhon order status --plan-id PLAN_ID
```

The example saves a Large 16 oz cappuccino, named milk/syrup/sweetener choices,
quantity one, Venice pickup and no reward redemption. Recipes use ASAP; the
current window, total and selected payment appear in each review. Optional
`paymentLast4` stops preparation if the selected card differs. Delivery recipes
use `fulfillment: {"type":"delivery","addressId":"SAVED_ADDRESS_ID"}` instead.
Delivery minimums and other existing checkout checks still apply.

For a one-off order, use `order prepare --json REQUEST_JSON` with the same recipe
shape. No saved recipe or temporary file is needed. `recipe save` also accepts
inline `--json RECIPE_JSON`, while `--request FILE` remains available for scripts.
Agent tools use a flat call shape with `order_prepare({items, pickupStore})` or
`order_prepare({items, deliveryAddressId})`. Each item copies `name`, `brand` and
`sku` from discovery, plus quantity, size, named choices and literal kitchen
instructions (empty if none). The CLI accepts this same shape with `--json`.
Use `order_prepare_saved({name: "usual-coffee"})` for an existing recipe; this
is one tool call. Recipe management commands remain available in
`tools --advanced`.

Discover the whole basket in one call:

```sh
erewhon product find --json '{"queries":["Cappuccino","Breakfast Burrito","Mountain Spring Water"]}'
# Delivery: return saved addresses in the same response.
erewhon product find --json '{"queries":["Cappuccino"],"includeAddresses":true}'
# Address-only lookup, with no product searches.
erewhon product find --json '{"queries":[],"includeAddresses":true}'
```

The model tool is `product_find({queries, includeAddresses?})`. Results include
options for an unambiguous exact name or sole search result; this does not select
an ambiguous product for the user. Repeated query names are deduplicated. Each
result identifies its query, so partial failures can be retried without repeating
successful lookups. Up to twelve distinct product searches fit in one call.
`product options --product-ref CATALOG_REFERENCE` remains available when options
were not included. Single-product `product find --query NAME` stays compatible.
The standalone `addresses` command also remains available, including in the
advanced tool manifest; the small ordering profile uses combined discovery.
If exact product identities and choices are already known, prepare directly;
the CLI still resolves fresh server IDs internally. A saved recipe needs only
`order_prepare_saved`.

`recipe show --name usual-coffee` reads saved intent without preparing an order.
Names match exactly, ignoring case and whitespace. Ambiguous products, missing
options or occupied carts stop explicitly; the CLI does not guess or clear the
cart. Repeating preparation of an unchanged recipe draft reuses its existing
item rather than adding another. If an addition was interrupted, inspect the
cart first; after removing that draft's item, `recipe reset --name usual-coffee`
clears its journal only if the cart is empty.

Mixed orders use `items` with one named specification per customization:

```json
{
  "pickupStore": "Venice",
  "items": [
    {
      "name": "Cappuccino",
      "brand": "Erewhon",
      "sku": "030162",
      "quantity": 2,
      "size": "Large 16 oz",
      "choices": [
        {
          "group": "Milk",
          "option": "Organic Whole Milk (Clover Sonoma)"
        }
      ],
      "instruction": ""
    },
    {
      "name": "Cappuccino",
      "brand": "Erewhon",
      "sku": "030162",
      "quantity": 1,
      "size": "Small 8 oz",
      "choices": [
        {
          "group": "Milk",
          "option": "Organic Whole Milk (Clover Sonoma)"
        }
      ],
      "instruction": ""
    }
  ]
}
```

Copy current labels from discovery; this example does not establish availability.
An omitted modifier `count` means **one**. `maxAllowedCount` is only a limit,
not the amount to select. An explicit `count` applies to **each item**: three drinks with two extra shots
means `quantity: 3` and the shot choice's `count: 2`. All basket lines are
validated before the first addition. A missing choice in the last line leaves
no partial basket. A network failure during additions can leave a partial cart;
the durable journal then blocks replay. The CLI never clears it automatically.
Separate customizations remain separate lines; identical specifications combine
quantities. The final review verifies each line, including instructions, against
the server cart. Legacy single-product requests remain supported.

Search's `ECRSID`/`objectID` is a **catalog reference**. The returned
`product._id` is a different **native product ID**, used only internally for
adding an item. Neither native IDs nor modifier/size IDs belong in a recurring
recipe. Catalog references can also be retired; recipes re-search the selected
store using exact name, brand and optional SKU. The lookup and fresh ID mapping
happen inside one agent-facing preparation call.

`status: "prepared"` always has `orderPlaced: false`. Confirmation returns
`orderPlaced: true` only with a server-confirmed `orderId`. An unresolved
submission has `orderPlaced: null`; use `order status` to reconcile it.
Client cards/tasks must mark an order completed **only** when both
`orderPlaced === true` and `orderId` are present. Finishing a UI handler,
preparing a plan or observing an empty cart is not proof of an order.

## Login

```sh
erewhon login --phone +15555550123
erewhon auth complete --login-id LOGIN_ID --code CODE
erewhon auth status
```

Use an existing US Erewhon account. Login returns `loginId`, `status: "waiting_for_code"`, and an SMS challenge with masked contact and code length four. Forward that login ID with the user’s code. The CLI stops with `registration_required` if Erewhon reports a new user; it does not create an account or enroll the user in SMS marketing.

Use `--code-file /path/to/code.txt` instead of `--code CODE` to read a code from a file. An interactive terminal can omit both code options to prompt for the code.

```sh
erewhon auth poll --login-id LOGIN_ID
erewhon auth cancel --login-id LOGIN_ID
erewhon auth validate --login-id LOGIN_ID
erewhon auth logout
```

Repeated login for the same pending phone reuses the current challenge. A different pending attempt requires cancellation or explicit `login --replace`. Interrupted sends and code submissions become `outcome_unknown` and are never automatically replayed. `auth validate` resumes validation of an already exchanged candidate without submitting the code again. Existing credentials remain until profile and native membership reads validate the new session.

The token is opaque; no refresh or token-expiry contract is implemented. If Erewhon rejects it with `AUTH_REQUIRED`, sign in with a new code. `auth status` reports locally stored login state. If profile confirmation is required, complete the missing details through Erewhon before preparing an order.

## Account and history

```sh
erewhon profile
erewhon membership
erewhon rewards --type accrual --page 1
erewhon rewards --type redemption --page 1
erewhon history --type online
erewhon history --type instore --page 1
erewhon receipt --trn-cpk TRANSACTION_CPK --trn-pk TRANSACTION_PK
```

Rewards and in-store history use pages starting at one. Rewards `mayHaveMore` reflects the website’s row-count rule; it is not a server total. In-store history returns date and order-method filter keys. Pass those through `--date-key KEY` and repeated `--order-method-key KEY`. Online history returns upcoming and past order lists; the observed endpoint has no page support beyond page one.

Profile output includes masked saved-card labels. `--raw` provides additional server fields while still removing credentials and payment secrets.

## Products and fulfillment

```sh
erewhon stores
erewhon fulfillment select --type pickup --store-id STORE_ID
erewhon fulfillment
erewhon categories
erewhon search --query "smoothie" --page 0 --limit 20
erewhon product --id PRODUCT_ID

erewhon addresses
erewhon address check --request delivery-address.json
erewhon address add --request delivery-address.json
erewhon fulfillment select --type delivery --address-id ADDRESS_ID
```

Choose store, address and product IDs returned by the service. Delivery may return `store_selection_required`; choose a returned store and repeat selection with `--store-id STORE_ID`. Address selection uses an account address ID. To save a new address, provide a JSON request with `address1`, `city`, two-letter `state`, `zipcode`, numeric `latitude` and `longitude`, and `addressType`. Supply verified coordinates for that address; the CLI does not geocode or guess them. Optional fields are `address2`, `deliveryInstructions`, integer `dropMethod` (default 1), and boolean `isDefault` (default false). `address check` checks serviceability without saving; `address add` checks and saves the address without selecting delivery. An uncertain addition must be resolved by listing addresses; it is not automatically repeated.

Search pages start at zero. The selected store supplies the search index; `--index STORE_INDEX` can select a known index explicitly. Facets include `--department`, `--brand`, `--category`, and `--sub-category`; `--day 1` through `--day 7` selects an ISO weekday. `stores` also accepts `--lat LAT --lon LON` together.

Fulfillment and catalog requests initialize or refresh the server cart context. Selecting fulfillment changes that cart’s pickup store or delivery address.

## Cart and checkout

```sh
erewhon cart add --product-id PRODUCT_ID --quantity 1
erewhon cart
erewhon cart update --request cart-update.json
erewhon cart remove --cart-product-id CART_PRODUCT_ID
erewhon checkout
```

`cart remove` sets the chosen cart row’s quantity to zero, including customized rows. Updates and removal refetch the cart because a mutation response can contain stale quantities. An update file contains current cart row IDs:

```json
{"items":[{"cartProductId":"CART_PRODUCT_ID","quantity":2}]}
```

For products with modifiers, inspect `product` and use `--modifier-size-id ID` and `--modifiers-file FILE`. The file is an array of selections such as `{"groupId":"GROUP_ID","modifierId":"MODIFIER_ID","count":1}`. Required choices and server quantity limits are checked. `cart add` also accepts `--instruction TEXT`. Preorder and subscription carts have separate protocols and are not supported by this order flow.

Checkout returns server totals, saved payment choices, and scheduling and tip options. It can update checkout preferences through `--schedule-type-id`, `--time`, `--date`, `--shopper-tip-id`, `--driver-tip-id`, `--redeem-points`, and `--coupon-code`. Use the IDs and time values returned by checkout. If the same time occurs on multiple days, pair `--time SERVER_TIME` with `--date MM-DD-YYYY` using the server’s `date_mdy` value. A different Homesome saved card requires a separate payment-selection flow; adding new cards is outside this CLI.

## Review and submit an order

```sh
erewhon order prepare --payment-method-id PAYMENT_METHOD_ID
erewhon order confirm --plan-id PLAN_ID --confirm
erewhon order detail --id ORDER_ID
erewhon order operation --operation-id OPERATION_ID
```

`order prepare` returns a five-minute plan with the products, quantity, fulfillment, location, time, server amounts, tips, rewards use, coupon and masked payment choice. Show this review and obtain explicit user approval before `order confirm`. Preparation accepts the checkout options above; `--payment-method-id` selects a saved payment method when the server uses Erewhon’s payment processor.

Confirmation rechecks the cart, totals, time, address and payment against the approved plan. Changed terms require a new review. Catalog synchronization timestamps and rankings are excluded from this comparison. For ASAP delivery/pickup, the relative duration and service date stay bound while the displayed clock estimate may advance during the five-minute review; scheduled time windows remain exact. Disabled checkout, unavailable items or an unrecognized total stop the order before submission. `order confirm --confirm` is the command that places and pays for an order; cart and checkout commands change shopping state without placing one.

Order submission is recorded before the request. An uncertain result blocks further submissions and cart changes. Inspect its operation instead of retrying payment. Additional payment authentication stops the flow and is not automatically repeated. No cancellation command or card-entry flow is implemented.

## Private state

State defaults to `~/.config/erewhon-cli`, or `$XDG_CONFIG_HOME/erewhon-cli`. Override it with `EREWHON_CLI_STATE_DIR`. Directories use mode `0700`, files use `0600`, writes are atomic, and a process mutex covers authenticated operations. Use a local filesystem with reliable atomic rename semantics.

Tokens and raw responses remain private; commands and tools do not export credentials. Logout removes authentication state and the last response, while preserving the device ID, cart plans and order journals needed to resolve an existing outcome. APKs, analysis artifacts and captured account data are excluded from Git and packages.

## Validation and limits

The ordering interface was also exercised by a local 35.5B Qwen model through
the Pi harness. Its initial failures led to the reduced tool profile, inline
requests, explicit discovery-versus-checkout results and unknown-outcome
instructions. See [the reproducible model evaluation](eval/README.md).

On 2026-10-29, the named recipe prepared the customized Venice cappuccino through
CLI HTTP on Linux ARM64 for $9.97. A second preparation retained one cart row
with quantity one, and durable status correctly reported `orderPlaced:false`.
The test item was removed and the original empty cart restored. No payment or
order-placement request was sent. Automated regressions cover changes to every
native ID and the search reference, ambiguous/missing choices, dropped server
customizations, interrupted additions and payment-response reconciliation.

On 2026-10-14, a live HTTP pilot on native ARM64 Linux completed SMS login, code verification, authenticated profile and native membership reads, rewards and purchase history. The production CLI separately validated the exchanged candidate and successfully read profile, membership, rewards, online and in-store history, fulfillment, stores, addresses, cart and categories. Product details, paginated search and address serviceability also passed live checks. These steps used no Android runtime, browser, display server or tunnel.

A temporary cart with three water bottles produced live pickup and delivery checkout quotes and order reviews with the account’s saved payment method. A scheduled pickup using the server’s date and time values also prepared successfully, then ASAP was restored. Cart removal returned an authoritative zero-product response, and a separate read confirmed an empty cart with the original pickup selection restored. No place-order request was sent and no paid order was submitted.

All 135 automated checks passed on macOS with Node 24.19, native Linux ARM64 with Node 24.21, and a Linux Docker container with Node 22.23.3 and networking disabled. Coverage includes authentication, account reads, pagination, transport, private storage, process locking, address serviceability and creation, cart updates/removal, eligibility, server totals, scheduling, payment selection, review changes, concurrent confirmation, uncertain outcomes and recovery after token renewal or a process crash. Captured authentication responses also replayed successfully through the production module without network requests.

On 2026-10-15, an authorized customized pickup order completed through the native Node CLI on ARM64 Linux, including payment submission, order confirmation and receipt verification. No browser or Android runtime was used. The transport now supplies the first-party Origin/Referer context, modifier groups include their selected-item totals, and reviews bind the selected serving size. An earlier delivery attempt failed through HTTP and used the official website; delivery payment with the updated transport remains unverified live. Address creation has source and simulated-response validation only. Additional bank authentication, new card entry, preorder/subscription checkout and cancellation remain outside the implemented flow. See [protocol details](docs/protocol.md) for provenance and verification boundaries.
