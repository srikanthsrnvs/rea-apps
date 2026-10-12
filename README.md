# REA apps

Standalone tools reconstructed from installed apps, with separate Spotify and Uber CLIs.

| App | Commands | Runtime |
| --- | --- | --- |
| [Spotify](spotify/README.md) | Login, search, playback, library, playlists, speakers, MCP | macOS Spotify or the maintained headless Linux container |
| [Uber](uber/README.md) | Login, address search, ride options, fares, payment selection, booking, cancellation | Native Node.js HTTP client; no Android device or display server required |

Both CLIs output JSON and expose tool definitions for models. First login uses approval in a browser on another phone or computer. Subsequent use is headless; no developer API key is required.

## Install both on Linux

```sh
git clone https://github.com/srikanthsrnvs/spotify-desktop-cli.git rea-apps
cd rea-apps
./scripts/setup-linux.sh
```

The installer sets up Spotify's container and native Node runtime, then installs `spotify` and `uber` in `~/.local/bin`. Add that directory to your shell's `PATH` if needed. Spotify needs Docker Engine with Compose v2; see its [Linux prerequisites](spotify/docs/headless-linux.md). On ARM64, its emulator setup requires systemd and sudo. Uber uses the same native Node runtime, with no emulation or Android dependencies.

For an existing Spotify installation, preserve its saved container volume and use:

```sh
./scripts/setup-linux.sh --no-build
```

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

Each login command prints instructions for approval on another device. `uber auth complete` accepts the final browser URL even if the callback page says it cannot be found. Keep that URL private.

Read the app-specific guides for commands, installation on macOS, and protocol details. Uber booking and cancellation use preview-and-confirm plans; models must show the route, car, fare, payment method and cancellation terms before performing those actions.

## Development

```sh
npm --prefix spotify ci
npm --prefix spotify test
npm --prefix uber test
```

The apps have separate dependency trees, Docker build contexts and private session storage. Spotify's profile stays in its existing Docker volume. Uber stores credentials under `~/.config/uber-cli` (or `$XDG_CONFIG_HOME/uber-cli`). APKs, analysis tools, captured account data and session files are excluded from Git and release packages. REA is an investigation tool and is not required to run either CLI.
