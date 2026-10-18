# Amazon CLI

Amazon Shopping tools for agents, using Node HTTP and a small HTML parser. The Linux host runs no browser, Android runtime, emulator, Docker container or display. REA and the phone are investigation tools, not runtime dependencies. No developer API key is required.

## Install

On Linux ARM64 or x64, from the repository root:

```sh
./scripts/setup-linux.sh --amazon-only
amazon tools
```

Setup reuses compatible Node or downloads a checked official distribution, installs pinned parser dependencies, and creates `~/.local/bin/amazon`. Add that directory to `PATH`. On macOS with Node 22.19 or newer, run `npm --prefix amazon ci`, then `node amazon/src/cli.mjs tools`.

## Sign in

```sh
amazon login
# Give the user the returned approvalUrl and public code.
# The user signs in at https://www.amazon.com/code on their own device.
amazon auth complete --login-id LOGIN_ID
amazon auth status
```

The CLI exchanges the approved code, independently refreshes the resulting bearer token and renews shopping cookies before saving the session. Its independent device identity and private pairing code stay on the host. There is no password collection, browser cookie export, extension, tunnel or remote screen.

Complete the exchange after Amazon confirms approval. A premature registration error is not a pending-approval response and is not retried blindly. `auth cancel --login-id LOGIN_ID` removes a pending attempt while preserving the saved account. Use `login --replace` when already authenticated.

`auth refresh` renews the bearer token; `auth cookies` renews shopping cookies separately. Known responses can be recovered locally. Interrupted requests with unknown outcomes are not resent automatically; a fresh validated login can recover an uncertain authentication operation. `auth logout` removes saved credentials.

## Shopping and orders

```sh
amazon search --query 'USB C charger'
amazon search --cursor 'NEXT_URL_FROM_RESULT'
amazon product --asin PRODUCT_ASIN
amazon cart
amazon orders list
amazon orders details --order-ref ORDER_REF
```

Results are JSON. Search and orders follow actual pagination links. Order references belong to the current account and CLI device. Missing totals and cancellation eligibility remain unknown. Some order details are item landing pages with a source `actions.details` link to the full receipt.

Cart changes are prepared separately and expire after five minutes:

```sh
amazon cart prepare-add --asin PRODUCT_ASIN
amazon cart apply --plan-id PLAN_ID

amazon cart prepare-remove --cart-ref CART_REF --item-ref ITEM_REF
amazon cart apply --plan-id PLAN_ID
```

Add supports the observed single-product form for one unit. Bundles, subscriptions and unsupported forms stop without submission. Remove targets the exact source cart item action. Cart changes do not purchase anything.

## Checkout

```sh
amazon checkout prepare
# Show the items, exact total, address, payment and shipping to the user.
# Obtain explicit approval before the following PURCHASE command.
amazon checkout place --plan-id PLAN_ID --confirm-total APPROVED_TOTAL --currency USD
amazon operation status --plan-id PLAN_ID
```

The adapter supports the observed US checkout with an existing shipping address and saved payment method. It follows the exact “No thanks” link for optional Prime enrollment; it never joins Prime. Missing payment/address, unsupported layouts or additional verification stop the flow. Card entry and address editing are not implemented.

Before purchasing, the CLI reads a fresh cart and review. Changes to products, quantities, price, total, address, payment or delivery require another review. Submission uses Amazon's current source form and hidden fields, with a durable journal written before sending. A timeout, crash or unclear response is never permission to resend. Inspect `operation status` and order history to reconcile an uncertain result; further mutations remain blocked until resolved. Completed results are returned without replay on repeated calls.

## Cancellation

```sh
amazon orders cancel prepare --order-ref ORDER_REF
# Review the order and source choices; obtain approval before cancellation.
amazon orders cancel --plan-id PLAN_ID --confirm
# Optional --values is a JSON object keyed by source choice names.
```

Cancellation requires a source action identifying the exact order and a recognized POST form. Already cancelled orders return `unavailable`. Missing, JavaScript-only or unrecognized forms stop without submission. Returns/refunds are never substituted for cancellation. The result distinguishes a cancellation request from confirmed cancellation.

## Live verification and limits

Verified on the headless ARM64 Orin: fresh official code approval, device registration, bearer validation, shopping cookie renewal, search with a second page, product details, order history/details, cart reading and full checkout review. The installed review command used about 135 MiB peak RSS and finished in 5.9 seconds in one measured run. There is no persistent application process.

**No live purchase, cart mutation or cancellation was submitted.** Existing cart items were preserved. Inspected orders were closed; the cancellation form adapter has simulated coverage and needs an eligible live order for protocol verification. `amazon capabilities` reports these distinctions. Additional account/region-specific verification may require further work.

Search/products/orders use the app's recovered HTTP header profile. Cart/checkout required a desktop compatibility profile in the observed tests. These are HTTP headers; neither profile launches a browser or executes JavaScript.

Private sessions, source forms and journals live under `~/.config/amazon-cli`, or `$XDG_CONFIG_HOME/amazon-cli`, with directory mode 0700 and file mode 0600. `AMAZON_CLI_STATE_DIR` overrides the location. These files contain credentials/account data and must stay outside Git. Public results omit tokens, pairing secrets and CSRF fields.

Development: `npm --prefix amazon ci` and `npm --prefix amazon test`. See [authentication provenance](docs/auth-protocol.md) and [shopping observations](docs/shopping-protocol.md).
