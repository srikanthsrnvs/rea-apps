# Uber standalone CLI

A Node.js CLI reconstructed from Uber's Android app and official login frontend. It signs in using Uber verification codes, refreshes OAuth credentials, and performs ride shopping, booking and cancellation using HTTP. Login runs on a headless Linux machine without an Android device, display server, browser process, tunnel or developer API key.

Requires Node.js 22.19 or later. No npm dependencies, Java, ADB or REA are needed to run it.

## Install

From this repository's `uber/` directory on macOS, or with an existing supported Node runtime:

```sh
npm install --global .
uber login --phone +15555550123
```

On Linux, the native installer reuses a compatible Node runtime or downloads a checksummed Node 24 release. It supports x86_64 and ARM64 with glibc 2.28 or newer and requires Git, curl, tar, xz and sha256sum if Node must be downloaded. It leaves system Node unchanged:

```sh
git clone https://github.com/srikanthsrnvs/spotify-desktop-cli.git rea-apps
cd rea-apps
./scripts/setup-linux.sh --uber-only
export PATH="$HOME/.local/bin:$PATH"
uber login --phone +15555550123
```

For both apps, run `./scripts/setup-linux.sh`; see the [combined installation guide](../README.md). A package archive also includes `scripts/setup-linux.sh` for installing Uber alone. Keep its unpacked directory in place because the command links to it.

Start login with your phone number. Use `--country-code 1` to specify its dialing code when needed. The JSON response includes `loginId`, `status: "waiting_for_code"`, and a `challenge` with its `id`, delivery `channel`, masked `contact`, and `codeLength`. Enter the code Uber sends using the returned IDs:

```sh
uber auth complete --login-id LOGIN_ID --challenge-id CHALLENGE_ID --code CODE
uber auth poll --login-id LOGIN_ID
uber auth status
uber products --from 37.7749,-122.4194 --to 37.7849,-122.4094
```

Uber may require another verification code, such as an email code after SMS. Show the returned challenge and call `auth complete` again with the same `loginId`, the new `challenge.id`, and the new code. An agent must forward the current returned challenge ID; the user only supplies the code. A completed challenge ID cannot be reused for a later step. `auth poll` inspects the pending login; `auth status` also includes its `login` summary. Stop a pending login with `uber auth cancel --login-id LOGIN_ID`.

Instead of `--code CODE`, use `--code-file /path/to/code.txt` to read the code from a file. In an interactive terminal, omit both options to enter the code at a prompt. Keep `--login-id` and `--challenge-id` bound to the current response.

Each code delivery is requested once. If the result is uncertain, inspect the saved login before taking further action; do not automatically repeat `login` or request another message. This flow needs no browser approval or copied callback URL.

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

| Command                                                     | Behavior                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `tools`                                                     | Print tool definitions for models                                                |
| `login --phone NUMBER [--country-code CODE]`                | Start login and return its verification-code challenge                           |
| `auth complete --login-id ID --challenge-id ID --code CODE` | Submit the current challenge's code; return the next challenge or complete login |
| `auth poll --login-id ID`                                   | Inspect the pending login                                                        |
| `auth validate --login-id ID`                               | Validate an already exchanged session after an interrupted validation            |
| `auth cancel --login-id ID`                                 | Stop the pending local login                                                     |
| `login-url`                                                 | Print a legacy browser approval URL for manual recovery                          |
| `auth complete --callback-url URL`                          | Exchange a completed supported browser callback using the retained PKCE verifier |
| `auth status`                                               | Inspect token timestamps and pending login without exposing credentials          |
| `auth refresh`                                              | Refresh stored OAuth credentials                                                 |
| `auth logout`                                               | Remove local credentials and private response files                              |
| `search --query TEXT --near LAT,LON`                        | Find places and their Uber location IDs                                          |
| `resolve --id ID --provider PROVIDER`                       | Resolve a search result to coordinates                                           |
| `status`                                                    | Query current trip state and active orders                                       |
| `map [--trip-id UUID]`                                      | Read the selected ride's route, waypoints and driver-position snapshots          |
| `route --from LAT,LON --to LAT,LON`                         | Read an Uber driving-road route recommendation                                   |
| `map link --trip-id UUID`                                   | Retrieve the official trip-sharing URL without sending it to anyone              |
| `map stream --trip-id UUID [--duration 30]`                 | Read native driver and ETA events as NDJSON; no browser                          |
| `map serve [--trip-id UUID]`                                | Return an expiring iframe map URL and keep its foreground server running         |
| `payments`                                                  | List payment method IDs, masked labels and expiry state                          |
| `products --from LAT,LON --to LAT,LON`                      | List ride options for a route                                                    |
| `quote --from LAT,LON --to LAT,LON`                         | Get server-issued fare estimates and product options                             |
| `shopping --request FILE`                                   | Send a supplied modern shopping request                                          |
| `book --from LAT,LON --to LAT,LON --product UberX`          | Prepare an immediate Personal ride with a signed quote and selected payment      |
| `book --plan-id UUID --confirm`                             | Dispatch the reviewed ride using its unchanged signed fare                       |
| `cancel --trip-id UUID`                                     | Preview current cancellation terms and save a short-lived plan                   |
| `cancel --plan-id UUID --confirm`                           | Execute a reviewed cancellation plan after rechecking its terms                  |
| `operation --id UUID`                                       | Inspect a saved booking or cancellation outcome                                  |

Use `--via LAT,LON` repeatedly for intermediate stops, `--dry-run` to inspect a request, and `--raw` to retain the full shopping response in stdout. `shopping` outputs the full response by default. Coordinates are latitude followed by longitude.

Booking returns a `tripId` and `map.command`; run that command to get the expiring `mapUrl`. Use that exact trip ID for the viewer: if Uber's account-status response omits its order list, the CLI recovers the selected ride through the native trip-sharing API. A call without a trip ID fails with instructions instead of assuming the account is idle.

The experimental map viewer renders in the **client's** browser. For an explicitly selected trip, it can recover missing account-status details through Uber's native trip-sharing data API. The CLI keeps tracking tokens on the server. A ride without usable coordinates cannot produce a viewer link. The headless
host uses Node HTTP/2 for the native Ramen stream, with status snapshots as a fallback, and sends changes to the iframe immediately over authenticated SSE. It reuses
Uber's real cartography and selected product artwork. Native route pulse, queued motion and server-prediction timing are reconstructed; camera behavior and pixel parity remain unverified. For remote embedding,
use a reachable `--public-url` and HTTPS reverse proxy, with optional
`--frame-origin` restrictions. See the [map reconstruction findings and embedding guide](docs/map-reconstruction.md).

The native driver stream supplies pickup ETA in minutes, current road geometry and server-authored predictions. After six seconds without a new observation, prediction playback follows the native queue; it does not estimate movement from speed. Reconnects resume the stream cursor, and logout or account replacement revokes the viewer. A controlled real-trip test on the headless Orin verified native driver, ETA, road-route and prediction delivery; the user confirmed the ETA and motion looked right. The ride was cancelled and the final receipt reported no charge. Full Android visual parity remains unverified.

The viewer now includes the recovered native route reveal/pulse timing, a
solid base line, persistent car sprites, queued road-following animation and
remaining-route clipping at the animated car. A native Android recording
corroborates the 2.5-second pulse and dark route color. Full visual parity is
still unverified; source evidence, browser adapter boundaries and the remaining
comparison work are tracked in the [map parity ledger](docs/map-parity.md).

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

The CLI starts an authentication session through `/rt/silk-screen/submit-form` and selects a server-returned verification challenge. `/rt/silk-screen/prepare-field` requests its code. Successful verification can return another challenge; after the final challenge, the CLI exchanges the session with its retained PKCE verifier and saves OAuth credentials. It uses Uber's current official login JavaScript and native API contracts; see [protocol details](docs/protocol.md).

Code delivery and code submission are recorded before sending and are not automatically replayed after an uncertain outcome. Login state, the PKCE verifier and responses remain private. A successful login replaces the pending state with the authenticated session; later commands refresh OAuth credentials as needed.

If login reports `validation_pending`, run `uber auth validate --login-id LOGIN_ID`. It validates the already exchanged session without submitting a code again or requesting another message. Existing authenticated credentials remain in place until candidate validation succeeds.

Ride endpoints additionally require a short-lived client integrity credential. The CLI requests a **server-issued exemption** through the app's `/rt/devices/exemption` flow and passes it in `x-uber-cit`. It automatically renews expired credentials and retries an integrity challenge once. It does not fabricate device attestation or certificates.

The server granted this credential and accepted ride shopping for the tested account. Eligibility is controlled by Uber; this is not a guarantee for every account or future app version. No API key is required.

State defaults to `$XDG_CONFIG_HOME/uber-cli`, or `~/.config/uber-cli`. Override it with `UBER_CLI_STATE_DIR`. Directories are mode 0700 and files 0600; writes are atomic. A process lock serializes token changes and requests across local CLI processes. Docker uses a kernel `flock` across each command. The long-lived map viewer instead acquires that same lock for each state transaction, allowing other commands to proceed. Kernel locks release when their owned processes exit, including across PID namespaces. Use separate state directories on separate hosts; do not share a live state directory over a network filesystem.

OAuth tokens, refresh tokens, integrity credentials and raw server responses remain in this private state directory. `auth logout` removes the local copies; it does not revoke the account's server sessions.

### Manual browser recovery

The previous browser flow remains explicit recovery:

```sh
uber login-url
# Finish the printed approval link in your own browser.
# If it exposes a completed supported callback URL, supply it manually:
uber auth complete --callback-url 'FULL_CALLBACK_URL'
```

This route requires the full callback containing `session` and `authCode`, bound to the saved PKCE verifier. Keep it private. It does not automatically deliver browser approval to the CLI. Uber's callback allowlists discard arbitrary return URLs, and Safari may fail to expose the native return link. Use verification-code login for the normal headless workflow.

## Linux container

```sh
docker build -t uber-cli .
docker volume create uber-cli-state
docker run --rm -v uber-cli-state:/state uber-cli login --phone +15555550123
docker run --rm -v uber-cli-state:/state uber-cli auth complete --login-id LOGIN_ID --challenge-id CHALLENGE_ID --code CODE
docker run --rm -v uber-cli-state:/state uber-cli quote \
  --from 37.7749,-122.4194 --to 37.7849,-122.4094
```

Use a named volume for state, particularly on Docker Desktop: the Mac host file-sharing mount failed cross-container lock checks. The image rejects that observed filesystem. Linux local filesystem bind mounts can be used.

This image includes Node, the CLI and the base image’s `flock` utility. APKs, private sessions, analysis tools and evidence are excluded from its build context.

## Validation and current scope

The animation kernels and adapter have automated coverage for timing, route
merging, road corners, clipping, teleport thresholds, freeze behavior and Android
geodesy. An optional networked browser smoke check verifies route layers, pulse
frames, marker reuse, animated trimming, real font loading and theme changes:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  PLAYWRIGHT_CHANNEL=chrome node scripts/check-map-browser.mjs
```

This check uses synthetic coordinates and does not access an account or book a
ride. It requires a separately installed Playwright browser. Normal CLI use has
no Playwright dependency.

On 2026-10-15, all 163 automated checks passed in a Node 22 Linux
container. Browser checks verified that route layers are accepted by the
renderer, pulse gradients advance, the vehicle marker survives updates, road
geometry clips at the animated position, and light/dark themes load without
renderer errors. A private replay of two recorded tracking observations produced
303 distinct intermediate positions with the same sprite marker; this was a
recorded cancelled ride, not a new live booking.

Earlier authorized headless Linux ride tests verified actual driver coordinates
and moving original car artwork. A native Android prebooking video corroborated
the 2.5-second pulse and its legacy fade branch. Full active-trip pixel and timing
parity remain unverified. Map serving uses short state transactions so the
long-lived viewer does not block other CLI commands.

On 2026-10-14, a live HTTP protocol pilot on native ARM64 Linux completed SMS verification, a subsequent email challenge, session verification, PKCE exchange, OAuth refresh, and authenticated trip status. The returned account matched the existing signed-in account. These login steps used no Android device, browser, display server or tunnel. The production authentication module replayed captured responses, and `uber auth validate` validated the already exchanged live candidate through the CLI.

All 89 automated tests passed on macOS and Linux ARM64; 49 focused checks also passed in a Node 22 Linux container. Coverage includes verification-code challenges, stale and concurrent completion, recovery after a process crash, PKCE, callback validation, coordinate bounds, trusted regional redirects, refresh and integrity renewal, bounded read retries, mutation journals, payment selection, signed fare binding and expiry, cancellation fee changes, response normalization and state locking. Previous native deployment on ARM64 Ubuntu 22.04 also verified installer reruns, persisted login with automatic OAuth refresh, account status, place search and resolution, and signed quotes returning 22 car options. This native run used no Android device, Docker container, browser process or display server.

Live Linux ARM64 HTTP shopping returned 22 ride options for a sample city route. A complete search → resolution → quote → status test for an airport route returned 19 products and 23 price variants using persisted credentials. Live booking preparation resolves the current Personal profile and payment method and binds a selected car to its signed fare. Pickup ETA is unavailable in these responses and remains null.

An authorized live test completed the entire search → resolve → select UberX → prepare → book → cancellation preview → cancel → status flow inside the headless Linux container. The returned trip fare exactly matched its signed quote. Uber confirmed the ride was cancelled, no ride charge applied, and the temporary authorization hold was removed. The final account state reported `ClientCanceled` and zero active orders. No Android device or browser process was used for this test. Private addresses, payment identifiers, trip identifiers and receipts are excluded from the repository and package.

The recovered protocol is based on Uber Android 4.651.10003. Internal endpoints can change. Runtime use does not require that app to be installed.

## Development layout and checks

- `src/cli.mjs` parses command arguments and prints JSON. `map-cli.mjs` owns the map command lifecycle.
- `auth.mjs` and `auth-protocol.mjs` own verification-code login and explicit manual browser recovery.
- `shopping.mjs`, `booking.mjs`, `cancellation.mjs`, `plans.mjs` and `mutations.mjs` keep quote selection, reviewed actions and the operation journal separate.
- `map-live-feed.mjs`, `ramen-transport.mjs` and `ramen-codec.mjs` receive authenticated native updates; `map-live.mjs` projects selected-trip data.
- `native-*.mjs`, `map-motion.mjs` and `route-animation.mjs` contain the recovered motion and timing kernels. `map-web/` contains the client renderer.
- `test/` contains offline tests. Reference fixtures are retained separately from source formatting; investigation captures and credentials stay outside the repository.

From a repository checkout:

```sh
npm test
npx --yes prettier@3.6.2 --check .
```

The optional browser check requires an existing Playwright installation and a browser on the development computer, plus network access to public Uber map assets:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
PLAYWRIGHT_CHANNEL=chrome node scripts/check-map-browser.mjs
```

It uses synthetic coordinates and cannot book a ride. Runtime packages and the Linux host require no Playwright, browser, Android device or npm runtime dependencies. Packaging includes only the command wrappers, runtime source, documentation and scripts.
