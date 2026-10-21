# Spotify CLI

Control Spotify directly from Node on macOS or headless Linux. The default backend uses Spotify’s native device authorization, Connect HTTP/WebSocket protocol, and Pathfinder catalog calls. **No Spotify desktop app, Chromium, Chrome, Xvfb, Docker, emulator, Android device, or developer API key is needed.**

This is a remote controller for Spotify Connect devices such as your speaker. It does not decode or play audio through the Linux host’s sound hardware.

## Install and sign in

Linux ARM64 or x86-64:

```sh
git clone https://github.com/srikanthsrnvs/spotify-desktop-cli.git rea-apps
cd rea-apps/spotify
./scripts/setup-headless.sh
export PATH="$HOME/.local/bin:$PATH"
spotify login
# Approve the returned Spotify URL/code on your phone or computer.
spotify login-status
spotify devices --pretty
```

The setup filename is retained for compatibility; it now installs only native Node and the CLI dependencies. `--no-build` is accepted but no container is built. Node downloads use official release checksums. There is no browser process on the host at login or during later commands.

On macOS, install Node 22.19 or newer, run `npm ci`, and use `bin/spotify`. First login follows the same pairing flow; there is no desktop application prerequisite.

Login calls `accounts.spotify.com/oauth2/device/authorize` directly and returns Spotify’s own approval URL and code. `login-status` polls the token endpoint at its prescribed interval. The CLI saves access/refresh tokens privately under `~/.config/spotify-cli` (override: `SPOTIFY_STATE_DIR`) and renews them when needed. No account password or developer client secret is requested. `spotify logout` removes local authorization.

## Play and control

```sh
spotify search "Daft Punk" --type track --limit 5
spotify play --query "Veridis Quo"
spotify play liked
spotify play spotify:playlist:PLAYLIST_ID --index 0
spotify pause
spotify resume
spotify next
spotify previous
spotify seek 30
spotify volume 25
spotify shuffle on
spotify repeat context
spotify devices
spotify transfer "EXACT SPEAKER NAME"
```

Commands affect the account’s active Connect device. `transfer` requires its exact ID or a unique exact name. No speaker is invented when none is available. Availability and account/device restrictions are reported by Spotify.

`devices` also performs a short local-network scan for Connect, Sonos and Cast speakers. `spotify discover` works without login; `devices --network=false` skips the LAN scan. Network-only speakers are marked unavailable until activated in Spotify. Discovery does not start audio or a background player. See [speaker discovery and efficient reads](docs/discovery-and-caching.md).

Repeated reads reuse small, account-scoped snapshots: one second for playback state, 15 seconds for searches/library reads, and 30 seconds for LAN discovery. Use `--refresh` for current data. Mutations invalidate account snapshots and always use fresh confirmation reads. No mutation is retried automatically.

Playback commands return the observed state, not just a request acknowledgement. An uncertain mutation is never automatically repeated; inspect status before retrying. Seeking through the host adapter includes the expected track URI so a stale client cannot seek a replacement track.

## Song radio and mixes

Generate Spotify's song radio from a specific track URI, track link, or search:

```sh
spotify radio spotify:track:2LD2gT7gwAurzdQDQtILds --limit 10
spotify radio --query "Veridis Quo Daft Punk"
spotify radio play --query "Veridis Quo Daft Punk"
# Equivalent playback command: spotify radio-play TRACK_URI
```

`radio` returns Spotify's generated mix playlist URI/link, seed URI, name and a page of track metadata. It leaves playback and library membership unchanged. Use `playlist RETURNED_PLAYLIST_URI --offset NEXT_OFFSET --limit 20` to continue reading the same mix. `radio-play` generates the mix and plays its playlist context on the active Connect receiver; `--index N` selects a zero-based starting position. Playback returns confirmed state and the prebuilt player component. Search selects the first playable track result, as with `play --query`; use an exact track URI when the song name is ambiguous.

The corresponding model tools are `spotify_radio` and `spotify_radio_play`. Both use the existing login and native HTTP backend. Spotify calls this service `inspiredby-mix`; it decides the recommendations and refresh schedule. `radio --refresh` bypasses the CLI's short read cache and does not guarantee a different playlist. Generation does not create a saved custom playlist. Account and regional recommendation restrictions are reported explicitly. See [protocol evidence](docs/native-protocol.md#song-radio-and-mixes).

## Prebuilt music controls

Playback results also include a versioned `spotify.player` component reference with current song, artist, album artwork, adjacent tracks, playback position, device and control bindings. Its static HTML uses a neutral frosted card, a rounded album sleeve beside an animated CD, blurred previous/next covers, and directional transitions. The visible controls are previous, play/pause and next; seek and volume remain available through CLI tools and the host adapter. Artwork and neighbors use existing native playback metadata, with no extra Spotify API request. Long titles scroll on one line. The model never generates the component or handles button clicks.

A connected MCP Apps host loads `ui://spotify/player-v1.html`. Custom frontends can use the included sandboxed host adapter. `spotify component` returns the static resource for a CLI-backed renderer. Ordinary shell JSON alone does not make ChatGPT display UI: the host must support and connect to the component contract. See the [player integration guide](docs/player-component.md).

`spotify player` returns an optional live viewer URL for clients without MCP Apps rendering. For a remote client, use `spotify player --public --cloudflared-path /path/to/cloudflared`. It serves the same prebuilt controls, with an expiring account-bound key; Spotify credentials stay on the host. Normal CLI commands need neither a viewer process nor a tunnel. `spotify player --stop` closes only the viewer.

## Library, playlists and queue

```sh
spotify liked --offset 20 --limit 20
spotify library --limit 20
spotify playlists
spotify playlist PLAYLIST_URI --offset 0 --limit 20
spotify contains TRACK_URI
spotify save TRACK_URI
spotify unsave TRACK_URI
spotify queue
spotify queue add TRACK_URI
spotify queue remove EXACT_ROW_UID
spotify queue move EXACT_ROW_UID 0
spotify queue clear
```

Library/playlist pages preserve pagination, exact row UIDs and revisions. `playlists` reads the native rootlist including folder hierarchy. Queue edits preserve unrelated context/hidden rows and use the server’s revision. Duplicate occurrences are addressed by exact UID; ambiguous queue occurrences fail rather than guessing.

Private playlist creation, playlist edits, follow/unfollow and folder operations have native implementations:

```sh
spotify playlist create "Evening mix" --description "A private playlist"
spotify playlist add PLAYLIST_URI TRACK_URI
spotify playlist move PLAYLIST_URI EXACT_ROW_UID 0
spotify playlist update PLAYLIST_URI --description ""
spotify folder create "Music"
spotify folder move PLAYLIST_URI FOLDER_URI
spotify folder move PLAYLIST_URI root
```

Creation checks private/unpublished state. A partial setup failure returns `error.details.createdUri`; inspect that resource before retrying creation. Mutations use exact server identifiers and read confirmations, with no automatic replay.

## Tools for models

`spotify tools` returns the currently supported command schemas. `spotify help COMMAND` describes arguments. Multi-word aliases such as `queue add` and `playlist create` are supported. URI arguments accept `spotify:…` and `https://open.spotify.com/…` links; pagination and target indices are zero-based.

```json
{
  "mcpServers": {
    "spotify": {
      "command": "/absolute/path/to/rea-apps/spotify/bin/spotify",
      "args": ["mcp"]
    }
  }
}
```

MCP exposes `spotify_connect` plus supported CLI operations. It uses the same native backend, schemas and player component. Public Web API calls to `api.spotify.com` are not used and there is no automatic desktop fallback.

Pinned native read queries are discoverable through `queries` and `query`. Desktop-only settings, renderer/API introspection, app navigation and per-track account listening history are not advertised by the standalone backend. The old desktop implementation remains available for historical comparison only through an explicit `SPOTIFY_BACKEND=desktop`; it is never automatically selected or launched on a native failure.

## Results and verification

Commands emit `{ "ok": true, "result": ... }` or a typed `{ "ok": false, "error": ... }`. Playback responses additionally contain `component`. `--pretty` adds indentation. Exit status is 0 for success, 2 for invalid arguments, 1 for execution failures. Credentials and raw upstream authentication errors are never included in tool results.

On the ARM64 Orin, independent device pairing and refresh succeeded. With the old desktop container stopped, the normal CLI verified playback status, Connect device discovery, native search, liked songs and library/playlist reads. The current speaker volume was set to the same value and confirmed through the native Connect endpoint. Measured CLI peak RSS for status/devices/search/liked was about 97–99 MiB, compared with a 1.218 GiB sample for the prior desktop container. These are measured workloads, not a universal upper bound. CLI processes exit after their command; an MCP host keeps its Node server running.

Playlist/folder and queue write implementations have protocol/state tests grounded in first-party shipped code; they have not all been re-tested as live account mutations in this backend migration. No disposable playlists or queue changes were made for this migration. See [native protocol evidence and limits](docs/native-protocol.md).

```sh
npm test
# Development-only browser checks of the prebuilt component, no real playback:
node scripts/check-player-browser.mjs
```

Browser checks require Playwright in the development environment; neither Playwright nor a browser is needed by the deployed CLI. Spotify’s private interfaces can change; unrecognized pinned queries or native contracts return typed errors and require a CLI update. REA was used for investigation and is not required at runtime.
