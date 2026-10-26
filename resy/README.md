# Resy standalone CLI

Search restaurants, find tables, review prices and policies, book reservations, and cancel them using a headless Node.js HTTP client. The Android app was used for protocol investigation; it is not needed to run the CLI. No developer API key or browser is required on the host.

## Login on a headless host

```sh
resy login
```

Send the returned `approvalUrl` to the user. They open it in their own browser on another computer or phone and sign in through Resy's official phone sign-in widget. Resy's widget deliberately shares the resulting session with its embedding page. The host validates that session with Resy and saves it automatically, then the browser returns to resy.com. This is a widget handoff, not a Resy device-code grant. The connection page contains only the official sign-in widget.

```sh
resy auth poll
resy auth wait
resy me
```

`auth poll` returns `status: "authenticated"` after completion. Pending results include a retry interval. `auth wait --timeout SECONDS` bounds one wait without canceling the login. The approval link expires after ten minutes by default; use `login --timeout SECONDS` (30–3600) to change that. Calling `login` reuses an active request; `login --replace` starts a new one. `auth cancel` closes the pending connection while preserving an existing session.

By default, login starts a temporary HTTPS Cloudflare Quick Tunnel to a loopback-only server. The tunnel runs only during login, needs no Cloudflare account, and closes on completion, cancellation, failure, or expiry. A short DNS propagation delay can occur after creating a new link. Cloudflare relays the resulting session handoff; password and verification-code entry occurs inside the Resy-origin iframe. Keep approval links private. A browser that blocks the widget or its storage may need its normal browser privacy controls adjusted for that sign-in.

For an existing HTTPS reverse proxy, use:

```sh
resy login --public-url 'https://YOUR_LOGIN_HOST' --port 8787
```

The proxy must forward `/pair/` to `127.0.0.1:8787` on the CLI host, preserve the original Host header, and disable response caching. The CLI accepts an HTTPS origin with no path. This mode does not start a Cloudflare tunnel. You can choose a tunnel binary with `RESY_CLOUDFLARED` or `--cloudflared-path`.

## Linux installation

Requires Linux x86_64 or ARM64, glibc 2.28 or newer, Git, curl, tar, xz, and sha256sum. The installer reuses a compatible Node or supplies checksummed Node 24. It reuses cloudflared or supplies a checksummed, pinned binary in user-local storage. System Node is unchanged. No npm dependencies, display server, Android device, or Chrome installation are needed.

```sh
git clone https://github.com/srikanthsrnvs/rea-apps.git
cd rea-apps
./scripts/setup-linux.sh --resy-only
export PATH="$HOME/.local/bin:$PATH"
resy login
```

On macOS with Node 22.19 or newer and cloudflared installed, run `node resy/bin/resy` from the checkout, or install the local package with `npm install --global ./resy`.

## Search and table reads

Commands output JSON. `resy tools` returns model-facing command schemas without contacting Resy. Use `--pretty` for formatted output.

```sh
resy search --query 'italian' --near '34.0346,-118.4945' --date 2026-10-13 --party-size 2
resy search --query 'italian' --near '34.0346,-118.4945' --date 2026-10-13 --party-size 2 --page 2
resy venue --venue-id 'VENUE_ID'
resy availability --venue-id 'VENUE_ID' --date 2026-10-13 --party-size 2
resy calendar --venue-id 'VENUE_ID' --start-date 2026-10-13 --end-date 2026-10-15 --party-size 2
resy details --venue-id 'VENUE_ID' --slot-token 'TABLE_TOKEN' --date 2026-10-13 --party-size 2
resy payments
resy reservations --type upcoming
```

Replace placeholder IDs and tokens with values returned by the preceding commands. Dates are restaurant-local service dates; the CLI does not silently shift them across midnight. Search uses one-based `page` and returns `hasMore` and `nextPage`. Restaurant lists can change between pages. Available slots include `slotToken`, `tableType`, local start time, and eligibility information. Some inventory belongs to Tock and returns an external booking URL instead of a usable Resy table token.

An existing session is used for eligible inventory; public restaurant, availability, calendar, and quote reads can also work before login. `reservations` preserves the server's pagination metadata and accepts its `offset` and `limit` fields; it does not invent a continuation from an empty page. `payments` projects saved methods from the authenticated account response, exposing IDs and masked display information.

## Booking and cancellation

First prepare a booking with the exact table token, restaurant, date and party size:

```sh
resy book --venue-id 'VENUE_ID' --slot-token 'TABLE_TOKEN' --date 2026-10-13 --party-size 2 --payment-method-id 'SAVED_CARD_ID'
```

This checks that the table is still available for that restaurant and account, then reads current details with `commit=0`. It returns `planId`, `expiresAt`, and a `review` containing the restaurant, table, time, party size, currency, amounts, payment method and cancellation policy. Monetary amounts are decimal currency units, not integer cents. A card can be required even when the current total is zero because of a cancellation fee or restaurant payment policy. Unknown costs or required payment information prevent preparing a bookable plan.

Show the entire review to the user and obtain approval before:

```sh
resy book --plan-id 'PLAN_UUID' --confirm
```

Confirmation rechecks account ownership, costs, policies, cutoffs, saved-card availability and conflicting reservations. It then obtains fresh committed details and submits the returned booking token once. A changed review requires a new plan. Plans expire after five minutes as a client safeguard; the committed token's server-supplied expiry is separately checked. The command does not replace an existing reservation or opt the user into venue marketing.

Cancellation follows the same pattern:

```sh
resy cancel --reservation-token 'RESERVATION_TOKEN'
# Show the returned cancellation review and obtain approval.
resy cancel --plan-id 'PLAN_UUID' --confirm
```

The CLI rechecks the cancellation policy before submitting and verifies the result through a fresh reservation read. It does not assume a fee is zero because the booking price was zero.

Each submission has a durable operation record:

```sh
resy operation --operation-id 'OPERATION_UUID'
```

Repeated confirmation cannot replay a consumed plan. A lost response, process interruption, or unconfirmed cancellation produces `OPERATION_UNCERTAIN` and blocks new operations of that kind for the account. Inspect the operation and the account's current reservations; uncertain records require manual reconciliation. The CLI deliberately provides no automatic reset that could create duplicate reservations or charges. Direct service rejections are recorded separately and can be addressed with a new reviewed plan.

## State and verification

State lives under `~/.config/resy-cli`, `$XDG_CONFIG_HOME/resy-cli`, or `RESY_CLI_STATE_DIR`. Directories use mode 0700 and files 0600. Filesystem process locks serialize state changes. Session tokens, payment/card internals, and backend booking tokens are excluded from normal command output. Reservation and slot tokens are returned where needed to operate on the user's reservations and available tables; treat them as private.

`auth status` inspects local timestamps. `me` validates with Resy. The widget handoff supplies an access token, not a transferable refresh-cookie session; an expired or challenged session requires a fresh link. `auth logout` removes local session credentials and closes pending login; it does not remotely revoke other browser/app sessions or erase reservation operation history.

```sh
node --test resy/test/*.test.mjs
```

The 35 tests pass on macOS and Linux ARM64. They cover the login message contract and origin checks, one-time acceptance, replacement/cancellation, secret cleanup, credential scope, errors, JSON precision, model schemas, table binding, current-price review, payment requirements, concurrency, operation uncertainty, conflicts, and cancellation verification. Live verification and exact REA sources are recorded in [protocol details](docs/protocol.md). Private APKs, source captures, credentials and account data stay outside this checkout.
