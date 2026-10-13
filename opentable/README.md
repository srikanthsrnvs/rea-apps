# OpenTable CLI

A standalone Node.js CLI for restaurant search, table availability and reservations. Runtime commands use OpenTable's native HTTP services; no Android device, browser, display server or developer API key is required on the host.

## Install

```sh
# From the rea-apps repository on Linux (ARM64 or x86_64)
./scripts/setup-linux.sh --opentable-only
export PATH="$HOME/.local/bin:$PATH"

# macOS, with Node 22.19 or newer
npm install --global ./opentable
```

The Linux installer reuses a compatible Node runtime or downloads a checksummed Node distribution. OpenTable has no npm runtime dependencies.

## Sign in

```sh
opentable login --email you@example.com
# Native SMS option: opentable login --phone '+12125550123'
opentable auth complete --code 123456
opentable auth status
opentable me
```

OpenTable sends a verification code to the selected contact. Pass that code to `auth complete`; the CLI exchanges it and validates your account before saving the session. Phone login defaults to US, country code 1. International numbers require explicit `--country-code` and `--country-id`; this implementation uses the US API origin.

A repeated pending login does not resend a code. `auth cancel` discards pending login; `auth refresh` refreshes a saved token or validates an already exchanged session. `auth logout` removes local credentials. Additional registration, email confirmation, phone recycling or security challenges require the official OpenTable app or website; the CLI does not silently register an account.

Login is an implementation of the native verification-code flow, not browser-link pairing. See [protocol and verification](docs/protocol.md) for the current live validation limits.

## Find restaurants and tables

```sh
opentable search --query 'True Food Kitchen' --near 34.0522,-118.2437 \
  --date-time 2026-10-14T19:00 --party-size 2 --limit 5 --page 1
opentable restaurant --restaurant-id RESTAURANT_ID
opentable availability --restaurant-id RESTAURANT_ID \
  --date-time 2026-10-14T19:00 --party-size 2
opentable payments
opentable reservations --page 1
```

Times are restaurant-local and retain their supplied calendar date/time. Search returns `hasMore` and `nextPage`. Table choices include seating type, dining area, card requirements, native price fields and a `slotId` local to this installation. Refresh availability after signing in or refreshing your session. Raw prices whose monetary scale is unverified retain `monetaryDivisor: null`.

## Review and confirm

```sh
opentable book --restaurant-id RESTAURANT_ID --slot-id SLOT_UUID
# Show the returned review to the user, obtain approval, then:
opentable book --plan-id PLAN_UUID --confirm

opentable cancel --reservation-id RESERVATION_UUID
# Show the returned cancellation review, obtain approval, then:
opentable cancel --plan-id PLAN_UUID --confirm
opentable operation --operation-id OPERATION_UUID
```

Preparing a plan does not hold or book a table. Confirmation rechecks the account, exact table and reviewed terms before acquiring inventory and submitting once. Cardless standard tables and compatible guarantees using a saved OpenTable card are supported; use `--payment-method-id` to choose a wallet card. If the hold introduces guarantee terms, the CLI releases it and returns `status: review_required` with `nextPlan`. Show that review, obtain approval, then confirm its plan ID. A fresh hold must match those exact terms before booking. Plans expire after five minutes. An uncertain write is saved durably and blocks another submission; inspect the operation and reconcile with OpenTable before attempting another booking or cancellation. The CLI never automatically retries a write.

Card-guaranteed cancellation can have an unknown fee. The review exposes that risk; only after explicit user approval, add `--accept-unknown-fee` to the confirmed cancellation. Deposits, prepaid experiences, new cards, third-party payment forms, SCA and restricted inventory remain unsupported. Supported branches and limits are recorded in the protocol guide. An unsupported payment, experience, restaurant restriction or challenge produces a structured error; it is not silently replaced with another option.

## Model tools and private state

`opentable tools` returns descriptions and JSON input schemas. Commands print JSON; use `--pretty` for readability. Errors are JSON on stderr with a nonzero exit code. A model must show a plan's current terms and get approval before confirming a real booking or cancellation.

Sessions and private slot/reservation references live in `~/.config/opentable-cli`, or `$XDG_CONFIG_HOME/opentable-cli`. Set `OPENTABLE_CLI_STATE_DIR` for isolated installations. State files use mode 0600; directories use mode 0700. Tokens, verification codes, wallet tokens and reservation security tokens are excluded from normal output. Keep the state directory private and persistent across CLI invocations.

```sh
npm --prefix opentable test
```
