# REA apps

Standalone tools reconstructed from installed apps, with separate Spotify, Uber, Instagram, Resy, OpenTable, and Erewhon CLIs.

| App | Commands | Runtime |
| --- | --- | --- |
| [Spotify](spotify/README.md) | Device pairing, search, playback, queues, library, playlists, folders, Spotify Connect devices and prebuilt music controls | Native Node HTTP/WebSocket; no desktop app, Chromium, Docker or emulator |
| [Uber](uber/README.md) | Verification-code login, address search, ride options, fares, payment selection, booking, cancellation, experimental iframe map | Native Node.js HTTP; map renders in the client's browser; no Android device or browser on the host |
| [Instagram](instagram/README.md) | Search, Explore, inbox summaries, followers, following, saved collections | Headless HTTP login with an Instagram approval link; Android used for protocol investigation |
| [OpenTable](opentable/README.md) | Verification-code login, paginated restaurant search, tables, payments, reservations, reviewed booking and cancellation | Headless Node HTTP; no Android, browser or display required on the host |
| [Erewhon](erewhon/README.md) | SMS login, membership, rewards, purchase history, catalog, pickup and delivery carts, reviewed order submission | Headless Node HTTP; no Android, browser, display or developer API key input required |
| [Resy](resy/README.md) | Restaurant search, tables, calendars, prices, payment methods, reservations, booking, cancellation | Headless Node HTTP; official Resy widget login in a separate client browser |

The CLIs output JSON and expose tool definitions for models. Uber, OpenTable and Erewhon accept verification codes directly; Spotify, Instagram and Resy use approval in a browser on another phone or computer. Subsequent use is headless; no developer API key is required.

## Install on Linux

```sh
git clone https://github.com/srikanthsrnvs/spotify-desktop-cli.git rea-apps
cd rea-apps
./scripts/setup-linux.sh
```

The installer sets up Spotify's native Node runtime, then installs `spotify`, `uber`, `instagram`, `resy`, `opentable`, and `erewhon` in `~/.local/bin`. Add that directory to your shell's `PATH` if needed. Spotify uses native HTTP/WebSocket protocols and needs no Docker or emulator; see its [Linux setup](spotify/docs/headless-linux.md). The other apps reuse the native Node runtime and need no Android or emulation at runtime. Instagram and Resy return login links opened in a separate browser; the Linux host needs no browser, display, or developer API key. Resy also installs cloudflared for its temporary login relay.

For one native app, use `./scripts/setup-linux.sh --uber-only`, `--instagram-only`, `--resy-only`, `--opentable-only`, or `--erewhon-only`.

For an existing Spotify installation, rerun setup and complete the new native `spotify login` pairing. Once native commands work, stop the old desktop container with `spotify/bin/spotify-headless service stop` to reclaim RAM. Its saved profile volume can remain as a recovery copy; native sessions are separate. See the [migration guide](spotify/docs/headless-linux.md#existing-desktop-deployments).

## Sign in and use

```sh
spotify login
spotify login-status
spotify devices --pretty
spotify tools

uber login --phone +15555550123
uber auth complete --login-id LOGIN_ID --challenge-id CHALLENGE_ID --code CODE
uber auth poll --login-id LOGIN_ID
uber auth status
uber tools
```

Spotify prints instructions for approval on another device. Uber returns a `loginId` and verification challenge describing its ID, channel, masked contact and code length. Enter each code through `uber auth complete` with the current returned `challenge.id`; Uber may request an email code after SMS with a new challenge ID. The agent forwards the IDs while the user supplies the code. `uber auth cancel --login-id LOGIN_ID` stops a pending login. This flow uses HTTP without a browser or tunnel. The previous `uber login-url` and `auth complete --callback-url URL` commands remain manual recovery; see the [Uber login guide](uber/README.md#headless-authentication).

Uber also accepts `--code-file FILE` or an interactive code prompt. If the exchanged session needs validation, run `uber auth validate --login-id LOGIN_ID` without requesting another code.

For Instagram, run `instagram login` on Linux, send its `approvalUrl` to the user, then run `instagram auth wait`. The user signs in and confirms the code on Instagram’s own website. The host receives and saves the session automatically; see its [login guide](instagram/README.md).

For Resy, run `resy login`, send its `approvalUrl` to the user, and run `resy auth wait`. The user signs in through the official Resy widget in their own browser; the host validates and saves the session. See its [login and reservation guide](resy/README.md).

For OpenTable, run `opentable login --phone NUMBER` (or `--email ADDRESS`), then `opentable auth complete --code CODE`. The code comes directly from OpenTable. See its [guide and live verification limits](opentable/README.md).

For Erewhon, run `erewhon login --phone NUMBER`, then `erewhon auth complete --login-id LOGIN_ID --code CODE`. Codes can also come from `--code-file FILE`. The CLI validates and saves the opaque account token; new-user registration stops without creating an account. See its [login, shopping and live verification guide](erewhon/README.md).

Read the app-specific guides for commands, installation on macOS, and protocol details. Uber, Resy and OpenTable booking/cancellation use reviewed plans. Models must show the current terms and obtain user approval before confirming a real booking or cancellation. Erewhon likewise requires an approved order review before `order confirm --plan-id ID --confirm` places and pays for an order.

## Development

```sh
npm --prefix spotify ci
npm --prefix spotify test
npm --prefix uber test
npm --prefix instagram ci
npm --prefix instagram test
npm --prefix resy test
npm --prefix opentable test
npm --prefix erewhon test
```

The apps have separate dependency trees and private session storage. Native Spotify stores its session under `~/.config/spotify-cli`; historical desktop Docker files remain only for recovery/comparison. Instagram stores its session under `~/.config/instagram-cli`, Uber under `~/.config/uber-cli`, Resy under `~/.config/resy-cli`, OpenTable under `~/.config/opentable-cli`, and Erewhon under `~/.config/erewhon-cli` (or `$XDG_CONFIG_HOME/APP-cli`). APKs, analysis tools, captured account data and session files are excluded from Git and release packages. REA is an investigation tool and is not required to run any CLI.
