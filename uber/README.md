# Uber standalone CLI

A Node.js CLI reconstructed from Uber's Android app. It performs login exchange, OAuth refresh, ride shopping, booking and cancellation using HTTP. After one browser approval, it runs on a headless Linux machine without an Android device, display server, browser process or API key.

Requires Node.js 22.19 or later. No npm dependencies, Java, ADB or REA are needed to run it.

## Install

From this repository's `uber/` directory on macOS, or with an existing supported Node runtime:

```sh
npm install --global .
uber login
```

On Linux, the native installer reuses a compatible Node runtime or downloads a checksummed Node 24 release. It supports x86_64 and ARM64 with glibc 2.28 or newer and requires Git, curl, tar, xz and sha256sum if Node must be downloaded. It leaves system Node unchanged:

```sh
git clone https://github.com/srikanthsrnvs/spotify-desktop-cli.git rea-apps
cd rea-apps
./scripts/setup-linux.sh --uber-only
export PATH="$HOME/.local/bin:$PATH"
uber login
```

For both apps, run `./scripts/setup-linux.sh`; see the [combined installation guide](../README.md). A package archive also includes `scripts/setup-linux.sh` for installing Uber alone. Keep its unpacked directory in place because the command links to it.

Open the printed URL on your phone or computer and finish signing in. The final page may say it cannot be found: copy its **full URL**, containing `session` and `authCode`. On the machine running the CLI:

```sh
uber auth complete
# Paste the completed URL when prompted.
uber auth status
uber products --from 37.7749,-122.4194 --to 37.7849,-122.4094
```

Over a noninteractive connection, use `uber auth complete --callback-url 'FULL_URL'`. Keep this URL private. The CLI machine needs no display, but the first sign-in currently requires approval in a browser on another device. It does not automate passkeys or verification codes.

Find destinations by name before quoting a route:

```sh
uber search --query "San Francisco International Airport" --near 37.7749,-122.4194
uber resolve --id 'ID_FROM_SEARCH' --provider 'PROVIDER_FROM_SEARCH'
# Use the returned latitude,longitude in --from or --to.
uber quote --from 37.7749,-122.4194 --to 37.6180173,-122.3858998
uber tools
```

`uber tools` prints command definitions and input schemas for models. Search and resolution default to `DROPOFF`; use `--context PICKUP` when choosing a pickup point.

Commands output JSON; errors output JSON to stderr and exit with status 1.

| Command | Behavior |
| --- | --- |
| `tools` | Print tool definitions for models |
| `login` | Start a sign-in and print its approval URL |
| `auth complete` | Exchange the completed URL using the retained PKCE verifier |
| `auth status` | Inspect local token timestamps without exposing credentials |
| `auth refresh` | Refresh stored OAuth credentials |
| `auth logout` | Remove local credentials and private response files |
| `search --query TEXT --near LAT,LON` | Find places and their Uber location IDs |
| `resolve --id ID --provider PROVIDER` | Resolve a search result to coordinates |
| `status` | Query current trip state and active orders |
| `payments` | List payment method IDs, masked labels and expiry state |
| `products --from LAT,LON --to LAT,LON` | List ride options for a route |
| `quote --from LAT,LON --to LAT,LON` | Get server-issued fare estimates and product options |
| `shopping --request FILE` | Send a supplied modern shopping request |
| `book --from LAT,LON --to LAT,LON --product UberX` | Prepare an immediate Personal ride with a signed quote and selected payment |
| `book --plan-id UUID --confirm` | Dispatch the reviewed ride using its unchanged signed fare |
| `cancel --trip-id UUID` | Preview current cancellation terms and save a short-lived plan |
| `cancel --plan-id UUID --confirm` | Execute a reviewed cancellation plan after rechecking its terms |
| `operation --id UUID` | Inspect a saved booking or cancellation outcome |

Use `--via LAT,LON` repeatedly for intermediate stops, `--dry-run` to inspect a request, and `--raw` to retain the full shopping response in stdout. `shopping` outputs the full response by default. Coordinates are latitude followed by longitude.

Booking has two steps:

```sh
uber quote --from 37.7749,-122.4194 --to 37.7849,-122.4094
uber payments
uber book --from 37.7749,-122.4194 --to 37.7849,-122.4094 --product UberX
# Review the route, car, signed fare, expiry and masked payment name.
uber book --plan-id PLAN_UUID --confirm
uber status
```

Preparation defaults to the active Personal profile's RIDER payment method. Select another saved method using `--payment-profile-id UUID`. Choose a car by exact name with `--product`, or by numeric ID with `--vehicle-view-id`; ambiguous names fail. Use `--variant-id UUID` for an alternate fare variant shown by `quote`. The complete signed upfront fare is retained privately and sent unchanged. Expired quotes require a new plan and approval. Confirmation refuses to create another ride while an order is active.

`--confirm` dispatches a real ride and may charge the selected payment method. For a model, show the complete preview and obtain approval before running it. `requiresCheckout: true` means Uber returned an additional payment step; it does not establish completed payment or a matched driver. Inspect the saved operation and status before taking further action.

Cancellation has two steps. Read the trip and fulfillment order IDs from `uber status`, then:

```sh
uber cancel --trip-id TRIP_UUID --fulfillment-order-id ORDER_UUID
# Review the fee decision and server messages printed above.
uber cancel --plan-id PLAN_UUID --confirm
```

Optional cancellation flags are `--reason`, `--refund-strategy ORIGINAL_PAYMENT_METHOD|UBER_CASH`, and `--comment`. Reasons should come from the server cancellation survey, rather than invented identifiers. Plans expire after one minute. Confirmation fetches the fee terms again and refuses changed terms. If Uber does not identify whether a fee applies, the CLI refuses to cancel.

Paid actions are never automatically retried. If an error reports `outcome_unknown`, Uber may have accepted the request. Run `uber status` and `uber operation --id OPERATION_UUID`; do not prepare another booking or repeat the cancellation until the outcome is resolved. A persisted operation journal also prevents repetition after a process crash.

## Headless authentication

The implementation uses the app's PKCE login flow and refresh-token endpoint. Ride endpoints additionally require a short-lived client integrity credential. The CLI requests a **server-issued exemption** through the app's `/rt/devices/exemption` flow and passes it in `x-uber-cit`. It automatically renews expired credentials and retries an integrity challenge once. It does not fabricate device attestation or certificates.

The server granted this credential and accepted ride shopping for the tested account. Eligibility is controlled by Uber; this is not a guarantee for every account or future app version. No API key is required.

State defaults to `$XDG_CONFIG_HOME/uber-cli`, or `~/.config/uber-cli`. Override it with `UBER_CLI_STATE_DIR`. Directories are mode 0700 and files 0600; writes are atomic. A process lock serializes token changes and requests across local CLI processes. The Docker entrypoint uses a kernel `flock` across the entire command, so container crashes and PID namespaces do not leave stale process locks. Use separate state directories on separate hosts; do not share a live state directory over a network filesystem.

OAuth tokens, refresh tokens, integrity credentials and raw server responses remain in this private state directory. `auth logout` removes the local copies; it does not revoke the account's server sessions.

## Linux container

```sh
docker build -t uber-cli .
docker volume create uber-cli-state
docker run --rm -v uber-cli-state:/state uber-cli login
docker run --rm -it -v uber-cli-state:/state uber-cli auth complete
docker run --rm -v uber-cli-state:/state uber-cli quote \
  --from 37.7749,-122.4194 --to 37.7849,-122.4094
```

Use a named volume for state, particularly on Docker Desktop: the Mac host file-sharing mount failed cross-container lock checks. The image rejects that observed filesystem. Linux local filesystem bind mounts can be used.

This image includes Node, the CLI and the base image’s `flock` utility. APKs, private sessions, analysis tools and evidence are excluded from its build context.

## Validation and current scope

`npm test` verifies PKCE, callback validation, coordinate bounds, trusted regional redirects, refresh and integrity renewal, bounded read retries, mutation journals, payment selection, signed fare binding and expiry, cancellation fee changes, response normalization and concurrent/crashed-process state handling. All 51 checks pass on macOS and Linux ARM64 using Node 22.

Live Linux ARM64 HTTP shopping returned 22 ride options for a sample city route. A complete search → resolution → quote → status test for an airport route returned 19 products and 23 price variants using persisted credentials. Live booking preparation resolves the current Personal profile and payment method and binds a selected car to its signed fare. Pickup ETA is unavailable in these responses and remains null.

An authorized live test completed the entire search → resolve → select UberX → prepare → book → cancellation preview → cancel → status flow inside the headless Linux container. The returned trip fare exactly matched its signed quote. Uber confirmed the ride was cancelled, no ride charge applied, and the temporary authorization hold was removed. The final account state reported `ClientCanceled` and zero active orders. No Android device or browser process was used for this test. Private addresses, payment identifiers, trip identifiers and receipts are excluded from the repository and package.

The recovered protocol is based on Uber Android 4.651.10003. Internal endpoints can change. Runtime use does not require that app to be installed.
