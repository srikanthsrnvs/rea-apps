# Erewhon CLI

Headless HTTP tools for Erewhon SMS login, account information, membership, rewards, purchase history, product search, pickup and delivery carts, and reviewed order submission. Commands return JSON; `erewhon tools` describes the callable interface for models.

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

Confirmation rechecks the cart, totals, time, address and payment against the approved plan. Changed terms require a new review. Disabled checkout, unavailable items or an unrecognized total stop the order before submission. `order confirm --confirm` is the command that places and pays for an order; cart and checkout commands change shopping state without placing one.

Order submission is recorded before the request. An uncertain result blocks further submissions and cart changes. Inspect its operation instead of retrying payment. Additional payment authentication stops the flow and is not automatically repeated. No cancellation command or card-entry flow is implemented.

## Private state

State defaults to `~/.config/erewhon-cli`, or `$XDG_CONFIG_HOME/erewhon-cli`. Override it with `EREWHON_CLI_STATE_DIR`. Directories use mode `0700`, files use `0600`, writes are atomic, and a process mutex covers authenticated operations. Use a local filesystem with reliable atomic rename semantics.

Tokens and raw responses remain private; commands and tools do not export credentials. Logout removes authentication state and the last response, while preserving the device ID, cart plans and order journals needed to resolve an existing outcome. APKs, analysis artifacts and captured account data are excluded from Git and packages.

## Validation and limits

On 2026-10-14, a live HTTP pilot on native ARM64 Linux completed SMS login, code verification, authenticated profile and native membership reads, rewards and purchase history. The production CLI separately validated the exchanged candidate and successfully read profile, membership, rewards, online and in-store history, fulfillment, stores, addresses, cart and categories. Product details, paginated search and address serviceability also passed live checks. These steps used no Android runtime, browser, display server or tunnel.

A temporary cart with three water bottles produced live pickup and delivery checkout quotes and order reviews with the account’s saved payment method. A scheduled pickup using the server’s date and time values also prepared successfully, then ASAP was restored. Cart removal returned an authoritative zero-product response, and a separate read confirmed an empty cart with the original pickup selection restored. No place-order request was sent and no paid order was submitted.

All 121 automated checks passed on macOS with Node 24.19, native Linux ARM64 with Node 24.21, and a Linux Docker container with Node 22.23.3 and networking disabled. Coverage includes authentication, account reads, pagination, transport, private storage, process locking, address serviceability and creation, cart updates/removal, eligibility, server totals, scheduling, payment selection, review changes, concurrent confirmation, uncertain outcomes and recovery after token renewal or a process crash. Captured authentication responses also replayed successfully through the production module without network requests.

Paid order submission and address creation have source and simulated-response validation; those writes were not sent in the live verification. Additional bank authentication, new card entry, preorder/subscription checkout and cancellation remain outside the implemented flow. See [protocol details](docs/protocol.md) for provenance and verification boundaries.
