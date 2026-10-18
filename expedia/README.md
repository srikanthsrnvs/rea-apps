# Expedia CLI

Standalone flight tools reconstructed with REA from Expedia Android 2026.41.0 and the flight checkout assets it loads. Commands return JSON; `expedia tools` returns model-facing input schemas.

Commands use Node HTTP on Linux. Fresh login uses an email code plus official verification in the user’s own browser. No desktop browser, Android runtime, physical phone, browser extension or developer API key is required on the Linux host.

## Install

From the repository root on Linux ARM64 or x86-64:

```sh
./scripts/setup-linux.sh --expedia-only
export PATH="$HOME/.local/bin:$PATH"
expedia tools
expedia capabilities
```

The installer reuses a compatible Node runtime or downloads a checksummed Node build. No developer API key is required for the verified flight searches.

## Login

```sh
expedia login --email you@example.com
# Open verification.url in your own browser and complete any challenge.
expedia auth status
expedia auth code --login-id LOGIN_ID --code 001234
expedia auth refresh
```

`login` returns JSON containing a `loginId`, a temporary `verification.url`, and the code-delivery acknowledgement. Share that link with the user on their Mac, iPhone, or another computer. The page contains only Arkose’s official verification widget, with no credential form, custom branding, remote screen, or extension. A suppressed challenge can leave a blank page whose title changes to **Verification complete**. The result reaches the CLI automatically; the user supplies Expedia’s six-digit email code separately.

The verified native flow requests a code through Expedia’s returned resend action to obtain its correlation reference. Calling `login` repeatedly reuses the pending flow rather than sending more codes. `auth code` verifies once, then independently refreshes and checks the account before saving credentials. Existing credentials remain intact if replacement login fails. For an expired, failed, or uncertain attempt, explicitly cancel before starting again:

```sh
expedia auth cancel --login-id LOGIN_ID
expedia login --email you@example.com --replace
```

Fresh login currently supports Linux ARM64 and x86-64. It uses Node for native protocol calls and host telemetry, plus a short-lived Cloudflare tunnel for verification callback delivery. The installer reuses or installs a checksummed `cloudflared`; override with `EXPEDIA_CLOUDFLARED=/absolute/path/to/cloudflared` when needed. The tunnel and verification worker stop after completion, cancellation or expiry. Subsequent commands need Node only. Signing in on Expedia’s website by itself does not authorize the CLI.

Fresh login and independent session refresh were verified on the Orin. This establishes the tested account/flow; Expedia can still require a different challenge or reject a future attempt. Unsupported steps return an error rather than launching a browser or emulator. See the [protocol audit](docs/protocol-audit.md) and [Trust implementation](docs/trust-protocol.md).

## Search and select flights

```sh
expedia airports search --query 'Los Angeles'
expedia flights search --origin LAX --destination SFO --depart YYYY-MM-DD
expedia flights search --origin LAX --destination SFO --depart YYYY-MM-DD --return YYYY-MM-DD
expedia flights details --offer-id OFFER_ID
expedia flights details --offer-id OFFER_ID --fare-index 1
expedia flights fare --detail-id DETAIL_ID --fare-index 1
```

Search supports cabin, adults, child ages, infants and sorting. Results contain local offer IDs, flight times, airlines, prices and available fare options. Round-trip outbound selection returns the next leg's offers; select a return offer to retrieve the combined itinerary. Fare changes use the server-issued selection tokens. Local references expire; search again when Expedia rejects an old selection.

## Checkout and booking

```sh
expedia checkout prepare --detail-id DETAIL_ID
expedia checkout inspect --checkout-id CHECKOUT_ID
expedia checkout form --checkout-id CHECKOUT_ID --type CONTACT_INFORMATION --input-file travelers.json
expedia checkout form --checkout-id CHECKOUT_ID --type BILLING_ADDRESS --input-file billing.json
expedia checkout pay --checkout-id CHECKOUT_ID --payment-option-id PAYMENT_OPTION_ID --card-file card.json
expedia book --checkout-id CHECKOUT_ID
```

Preparation retrieves the exact flight checkout, current fare, rules, required traveler/contact fields and payment options. It does not buy a ticket. Fill the returned form's `userFieldInputs` array and submit it through `checkout form`; keep each exact `inputId`. Expedia validates the inputs and rotates the checkout session token as needed.

`card.json` contains `number`, `cvv`, `firstName`, `lastName`, `expirationMonth`, `expirationYear`, and `billingAddress` with the server's `countryCode` plus the applicable address fields. The CLI tokenizes the card with Expedia's returned, scoped HTTPS tokenization service. It never stores card numbers or CVV in its state or purchase journal. The input file remains under the caller's control. Stored-card and alternative-wallet execution are not currently exposed by the CLI.

If payment requires issuer verification, the command returns `requires_action` and does not book. That verification is not implemented as a browser process on the Linux host. Unknown trust requirements also stop booking; the CLI uses an empty trust payload only when Expedia's own checkout explicitly enables that branch.

`book --checkout-id` returns either missing inputs or a purchase review. Show the full review to the user and obtain approval of the itinerary, passengers, payment, fare and restrictions. Only then:

```sh
expedia book --plan-id PLAN_ID --confirm
expedia operation --operation-id OPERATION_ID
expedia operation --operation-id OPERATION_ID --refresh
```

Confirmation checks the live fare and terms again. Changes require a new review. A durable journal records the submission before it reaches Expedia; uncertain submissions are never repeated automatically. Pending orders are checked through the separate order-status query. An accepted order does not by itself prove ticket issuance.

## Verification status

- Live HTTP airport search, one-way search, fare upgrades and round-trip selection succeeded.
- Live flight checkout preparation and session validation succeeded without a browser.
- Linux ARM64 installation, search and protocol tests succeeded on the Orin.
- Fresh Node-only native login and independent HTTP session refresh succeeded on the Orin, using an email code and genuine verification completed in the user’s Safari. No browser or Android process ran on the Orin.
- Card tokenization, payment setup and paid booking are implemented from the actual flight checkout protocol, but have not been exercised with a real card or purchase. No flight has been bought during development.

Run `npm test` in this directory (Node protocol, authentication, lifecycle and relay checks). See [checkout protocol details](docs/checkout-protocol.md) and the exact GraphQL document provenance under `src/graphql/`. APKs, raw captures, accounts and private sessions are excluded from the repository.
