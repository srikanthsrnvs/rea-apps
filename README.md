# Uber standalone CLI

A Node.js CLI reconstructed from Uber's Android app. It performs login exchange, OAuth refresh and ride shopping using HTTP. After one browser approval, it runs on a headless Linux machine without an Android device, display server, browser process or API key.

Requires Node.js 22.19 or later. No npm dependencies, Java, ADB or REA are needed to run it.

```sh
npm install --global .
uber login
```

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
| `products --from LAT,LON --to LAT,LON` | List ride options for a route |
| `quote --from LAT,LON --to LAT,LON` | Get server-issued fare estimates and product options |
| `shopping --request FILE` | Send a supplied modern shopping request |

Use `--via LAT,LON` repeatedly for intermediate stops, `--dry-run` to inspect a request, and `--raw` to retain the full shopping response in stdout. `shopping` outputs the full response by default. Coordinates are latitude followed by longitude.

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

`npm test` verifies PKCE, callback validation, coordinate bounds, trusted regional redirects, refresh and integrity renewal, bounded retries, response normalization and concurrent/crashed-process state handling. All 25 checks pass on macOS and Linux ARM64 using Node 22.

Live Linux ARM64 HTTP shopping returned 22 ride options for a sample city route. A complete search → resolution → quote → status test for an airport route returned 19 products and 23 price variants using persisted credentials. The quote command combines the catalog with fare estimates, preserving price variants and quote expiry. Pickup ETA is unavailable in these responses and remains null. Address search, coordinate resolution and current trip status are supported. Booking and cancellation commands are not implemented. No ride has been booked or cancelled by this project.

The recovered protocol is based on Uber Android 4.651.10003. Internal endpoints can change. Runtime use does not require that app to be installed.
