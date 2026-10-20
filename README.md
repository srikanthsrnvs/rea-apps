# REA apps

Standalone tools reconstructed from installed apps, with separate Spotify, Uber, Instagram, Resy, OpenTable, Erewhon, Expedia, Amazon, Claude and ChatGPT CLIs.

| App | Commands | Runtime |
| --- | --- | --- |
| [Spotify](spotify/README.md) | Device pairing, search, playback, queues, library, playlists, folders, Spotify Connect devices and prebuilt music controls | Native Node HTTP/WebSocket; no desktop app, Chromium, Docker or emulator |
| [Uber](uber/README.md) | Verification-code login, address search, ride options, fares, payment selection, booking, cancellation, experimental iframe map | Native Node.js HTTP; map renders in the client's browser; no Android device or browser on the host |
| [Instagram](instagram/README.md) | Search, Explore, inbox summaries, followers, following, saved collections | Headless HTTP login with an Instagram approval link; Android used for protocol investigation |
| [OpenTable](opentable/README.md) | Verification-code login, paginated restaurant search, tables, payments, reservations, reviewed booking and cancellation | Headless Node HTTP; no Android, browser or display required on the host |
| [Erewhon](erewhon/README.md) | SMS login, membership, rewards, purchase history, catalog, pickup and delivery carts, reviewed order submission | Headless Node HTTP; no Android, browser, display or developer API key input required |
| [Resy](resy/README.md) | Restaurant search, tables, calendars, prices, payment methods, reservations, booking, cancellation | Headless Node HTTP; official Resy widget login in a separate client browser |
| [Expedia](expedia/README.md) | Flight search, fare selection, round trips, checkout preparation and guarded booking; live payment verification pending | Node HTTP; email code plus a verification link in the user’s own browser; no host browser or Android |
| [Amazon](amazon/README.md) | Official code pairing, product search, cart, orders and checkout review; guarded submissions with live mutation verification pending | Node HTTP and HTML parsing; no host browser or Android runtime |
| [Claude](claude/README.md) | Email login, paginated chats, content search, full conversations, new chats, replies and completion stops | Node HTTP; official verification in the user's browser during login; no host browser, Android or Mac helper |
| [ChatGPT](chatgpt/README.md) | Device-code login, conversation listing/search, reading, new chats and replies; Codex cloud task reads, models and environments | Node HTTP/WebSocket; official device approval in the user's browser; no host browser or Android |

The CLIs output JSON and expose tool definitions for models. Uber, OpenTable and Erewhon accept verification codes directly; Spotify, Instagram and Resy use approval in a browser on another phone or computer. Amazon uses official code approval at amazon.com/code. Subsequent use is headless; no developer API key is required.

## Install on Linux

```sh
git clone https://github.com/srikanthsrnvs/spotify-desktop-cli.git rea-apps
cd rea-apps
./scripts/setup-linux.sh
```

The installer sets up Spotify's native Node runtime, then installs `spotify`, `uber`, `instagram`, `resy`, `opentable`, `erewhon`, `expedia`, `amazon`, `claude-chat` and `chatgpt` in `~/.local/bin`. Add that directory to your shell's `PATH` if needed. Spotify uses native HTTP/WebSocket protocols and needs no Docker or emulator; see its [Linux setup](spotify/docs/headless-linux.md). The other apps reuse the native Node runtime for API commands. Expedia login uses an email code and a temporary verification link opened on the user’s device. Instagram and Resy return login links opened in a separate browser; the Linux host needs no browser, display, or developer API key. Resy, Expedia and Claude also install cloudflared for temporary verification relays.

For one native app, use `./scripts/setup-linux.sh --uber-only`, `--instagram-only`, `--resy-only`, `--opentable-only`, `--erewhon-only`, `--expedia-only`, `--amazon-only`, `--claude-only`, or `--chatgpt-only`.

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

Expedia's flight search, fare selection and checkout preparation use HTTP. Login combines an email code with official verification in the user's browser; the Linux host runs Node and a temporary tunnel. See its [flight tools and verification limits](expedia/README.md).

Amazon runs `amazon login`, then `amazon auth complete --login-id LOGIN_ID` after approval in the user’s browser. Its host uses only HTTP, including cart and checkout review. Purchase and cancellation adapters still need live submission verification; see its [guide](amazon/README.md).

Claude uses `claude-chat login --email ADDRESS`, then accepts the email code/button URL through `auth complete`. Open its returned verification link in the user's own browser; the Orin validates and saves login automatically. It lists/searches/reads chats and creates replies through HTTP. See its [guide](claude/README.md), [command reference](claude/docs/commands.md), and [agent workflows](claude/docs/agent-guide.md).

ChatGPT uses `chatgpt login`, which returns an official approval link and a device code. After approval, run `chatgpt auth poll --login-id ID`. The host makes HTTP requests only. Chat listing, reading and a new message with its reply were verified on Linux ARM64; see its [guide](chatgpt/README.md).

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
npm --prefix expedia test
npm --prefix amazon ci
npm --prefix amazon test
npm --prefix claude test
npm --prefix chatgpt ci --ignore-scripts
npm --prefix chatgpt test
```

The apps have separate dependency trees and private session storage. Native Spotify stores its session under `~/.config/spotify-cli`; historical desktop Docker files remain only for recovery/comparison. Instagram stores its session under `~/.config/instagram-cli`, Uber under `~/.config/uber-cli`, Resy under `~/.config/resy-cli`, OpenTable under `~/.config/opentable-cli`, and Erewhon under `~/.config/erewhon-cli` (or `$XDG_CONFIG_HOME/APP-cli`). APKs, analysis tools, captured account data and session files are excluded from Git and release packages. REA is an investigation tool and is not required to run any CLI.
