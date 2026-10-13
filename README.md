# REA apps

Standalone tools reconstructed from installed apps, with separate Spotify, Uber, Instagram, Resy, and OpenTable CLIs.

| App | Commands | Runtime |
| --- | --- | --- |
| [Spotify](spotify/README.md) | Login, search, playback, library, playlists, speakers, MCP | macOS Spotify or the maintained headless Linux container |
| [Uber](uber/README.md) | Login, address search, ride options, fares, payment selection, booking, cancellation | Native Node.js HTTP client; no Android device or display server required |
| [Instagram](instagram/README.md) | Search, Explore, inbox summaries, followers, following, saved collections | Headless HTTP login with an Instagram approval link; Android used for protocol investigation |
| [OpenTable](opentable/README.md) | Verification-code login, paginated restaurant search, tables, payments, reservations, reviewed booking and cancellation | Headless Node HTTP; no Android, browser or display required on the host |
| [Resy](resy/README.md) | Restaurant search, tables, calendars, prices, payment methods, reservations, booking, cancellation | Headless Node HTTP; official Resy widget login in a separate client browser |

The CLIs output JSON and expose tool definitions for models. First login uses approval in a browser on another phone or computer, or a verification code for OpenTable. Subsequent use is headless; no developer API key is required.

## Install on Linux

```sh
git clone https://github.com/srikanthsrnvs/spotify-desktop-cli.git rea-apps
cd rea-apps
./scripts/setup-linux.sh
```

The installer sets up Spotify's container and native Node runtime, then installs `spotify`, `uber`, `instagram`, `resy`, and `opentable` in `~/.local/bin`. Add that directory to your shell's `PATH` if needed. Spotify needs Docker Engine with Compose v2; see its [Linux prerequisites](spotify/docs/headless-linux.md). On ARM64, its emulator setup requires systemd and sudo. The other apps reuse the native Node runtime and need no Android or emulation at runtime. Instagram and Resy return login links opened in a separate browser; the Linux host needs no browser, display, or developer API key. Resy also installs cloudflared for its temporary login relay.

For one native app, use `./scripts/setup-linux.sh --uber-only`, `--instagram-only`, `--resy-only`, or `--opentable-only`.

For an existing Spotify installation, preserve its saved container volume and use:

```sh
./scripts/setup-linux.sh --no-build
```

When moving an older checkout, keep its private `.env` (including the device hostname) in `spotify/.env`. Run setup from the new directory to refresh the runtime and command links.

The fixed Spotify Compose project and volume names are retained when updating this repository, so moving into `spotify/` preserves its saved login. Never run `docker compose down -v` during migration.

## Sign in and use

```sh
spotify login
spotify login-status
spotify devices --pretty
spotify tools

uber login
uber auth complete
uber auth status
uber tools
```

Spotify and Uber login commands print instructions for approval on another device. `uber auth complete` accepts the final browser URL even if the callback page says it cannot be found. Keep that URL private.

For Instagram, run `instagram login` on Linux, send its `approvalUrl` to the user, then run `instagram auth wait`. The user signs in and confirms the code on Instagram’s own website. The host receives and saves the session automatically; see its [login guide](instagram/README.md).

For Resy, run `resy login`, send its `approvalUrl` to the user, and run `resy auth wait`. The user signs in through the official Resy widget in their own browser; the host validates and saves the session. See its [login and reservation guide](resy/README.md).

For OpenTable, run `opentable login --phone NUMBER` (or `--email ADDRESS`), then `opentable auth complete --code CODE`. The code comes directly from OpenTable. See its [guide and live verification limits](opentable/README.md).

Read the app-specific guides for commands, installation on macOS, and protocol details. Uber, Resy and OpenTable booking/cancellation use reviewed plans. Models must show the current terms and obtain user approval before confirming a real booking or cancellation.

## Development

```sh
npm --prefix spotify ci
npm --prefix spotify test
npm --prefix uber test
npm --prefix instagram ci
npm --prefix instagram test
npm --prefix resy test
npm --prefix opentable test
```

The apps have separate dependency trees and private session storage. Spotify and Uber have separate Docker build contexts. Spotify's profile stays in its existing Docker volume. Instagram stores its session under `~/.config/instagram-cli`, Uber under `~/.config/uber-cli`, Resy under `~/.config/resy-cli`, and OpenTable under `~/.config/opentable-cli` (or `$XDG_CONFIG_HOME/APP-cli`). APKs, analysis tools, captured account data and session files are excluded from Git and release packages. REA is an investigation tool and is not required to run any CLI.
