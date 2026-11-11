# Instacart CLI

Headless customer shopping through Instacart's native HTTP protocol. Node.js
22.19 or newer is the only runtime dependency. Android was used to investigate
the installed app; the CLI runs without a phone, browser, display or developer
API key.

## Install

On Linux ARM64 or x64, from the repository root:

```sh
./scripts/setup-linux.sh --instacart-only
export PATH="$HOME/.local/bin:$PATH"
instacart tools
```

The installer reuses a compatible Node installation, including this repository's
Spotify runtime, or downloads a checksum-verified Node runtime. On macOS, run
`./instacart/bin/instacart` from the repository root, or run
`npm install --global .` inside this folder. `INSTACART_NODE` selects a specific
Node executable.

## Sign in

```sh
instacart login --phone +15555550123
instacart auth complete --code CODE
instacart auth check
```

The first command sends an SMS directly from Instacart and returns a masked
destination, expiry and resend time. Give that result to the user and ask for
the code. The second command verifies it, validates the customer account and
saves the session. No approval website, callback copying or Android session
export is involved. A new phone-code login and subsequent authenticated commands
were verified directly on the headless Orin.

`--country-calling-code` defaults to `1`. Repeating the same login reuses an
unexpired pending request. `--resend` explicitly requests another code after the
server cooldown; `--replace-pending` replaces a different pending login. Run
`auth complete` again to retry validation of an already accepted code, without
resubmitting it. `auth status` reads local state; `auth check` makes a live
validation request. `logout` removes local credentials.

Email-code login is also implemented as `login --email ADDRESS`, using the
native app contract, but has not been live verified. Additional identity
challenges are reported explicitly. Session lifetime and automatic refresh are
not established; log in again when Instacart expires a session.

## Shop

```sh
instacart addresses
instacart stores --postal-code 90291 --latitude 33.9948 --longitude -118.466 --query Ralphs
instacart stores --postal-code 90291 --latitude 33.9948 --longitude -118.466 --service-type pickup
instacart shop --shop-id SHOP_ID

instacart search --shop-id SHOP_ID --postal-code ZIP --zone-id ZONE_ID --query coffee --limit 20
instacart search --shop-id SHOP_ID --postal-code ZIP --zone-id ZONE_ID --query coffee --limit 20 --cursor CURSOR
instacart item --shop-id SHOP_ID --id ITEM_ID
instacart prices --shop-id SHOP_ID --zone-id ZONE_ID --postal-code ZIP --ids ITEM_ID,ANOTHER_ID
```

Choose a saved address to obtain its postal code, coordinates and zone ID, then
select a serviceable store. Delivery and pickup use distinct shop IDs. Product
and price identifiers belong to the selected shop. Include `zoneId` and
`postalCode` together to hydrate prices in search and item results. Search
without a zone returns products without a location-specific price.

Search returns structured products, `total`, `offset`, `hasMore`, `nextCursor`
and any missing item IDs. Continue with the same shop, query, postal code, zone
and ads setting. The cursor preserves the ranked ID snapshot for 30 minutes;
later pages hydrate the next IDs rather than rerunning the initial search.
The live coffee search returned 300 IDs, and successive pages were verified
with no overlap. The default page size is 20; the maximum is 100.

## Carts, checkout review and orders

```sh
instacart carts --shop-id SHOP_ID
instacart cart get --cart-id CART_ID
instacart cart set --cart-id CART_ID --item-id ITEM_ID --quantity 4
instacart cart get --cart-id CART_ID --shop-id SHOP_ID --postal-code ZIP
instacart cart set --cart-id CART_ID --item-id ITEM_ID --quantity 0

instacart checkout prepare --cart-id CART_ID --shop-id SHOP_ID --address-id ADDRESS_ID --service delivery
instacart orders --first 20
instacart orders --first 20 --after END_CURSOR
instacart order --order-id ORDER_ID
```

Cart quantities are absolute: `4` means four total, and `0` removes the item.
For a weighted product, supply `--quantity-type weight`; ordinary items use
`each`. Required acknowledgements are returned for review. Mutations are never
automatically retried; after an uncertain result, read the cart before deciding
whether to repeat a change.

Use an existing cart returned by `carts`. New-cart allocation is not exposed:
the native allocation request returned a server error during investigation.
Cart item totals require a shop and postal code and exclude final checkout
fees. Configurable product options and substitution preferences are not yet
supported.

`checkout prepare` creates a server-side draft and reads its invoice. It returns
the selected address, service window, items, fees, tip, payment display,
authorization hold and any missing requirements. Raw checkout tokens stay in
private state. This is a preview only: order placement, payment setup and
cancellation are not exposed. Delivery initialization and invoice retrieval were
verified live; pickup checkout has not been live verified. No order was placed
during development.

## Agent tools and state

Every command returns JSON, apart from `help`. Success is
`{"ok":true,"data":...}`; errors are `{"ok":false,"error":...}` with a nonzero
exit status. `tools` returns command names, argument schemas, authentication
requirements and mutation flags. An agent can invoke a tool with JSON:

```sh
instacart call search --input '{"shopId":"SHOP_ID","postalCode":"ZIP","query":"coffee","limit":10}'
```

Session files are owner-readable only under
`${XDG_CONFIG_HOME:-~/.config}/instacart-cli`, or `INSTACART_CLI_STATE_DIR`.
Commands coordinate through a process lock. Keep this directory private; it
contains login credentials and any checkout drafts. APKs and investigation
captures are not included in the repository.

## Verification and protocol

```sh
npm test
```

Live verification on October 29, 2026 covered independent SMS login on Linux
ARM64, persistence across fresh processes, store discovery, priced product
search and pagination, product details, addresses, paginated order history and
order details. A cart item was changed from zero to one, read back with its
subtotal, then removed; the original cart was restored. Checkout verification
stopped after draft creation and invoice retrieval.

The implementation retains the exact registered GraphQL documents from Android
9.39.2. The backend accepts persisted-query hashes and rejects arbitrary query
text. App or backend changes can require updating these contracts. See
[authentication](docs/auth-protocol.md), [catalog](docs/catalog-protocol.md) and
[carts and checkout](docs/ordering-protocol.md) for REA evidence and remaining
limits.
