# Spotify desktop CLI

Control Spotify desktop on macOS or headless Linux with JSON commands or MCP tools. Playback, queue editing, search, library actions, private playlists, playlist folders, Spotify Connect devices, and app settings use Spotify's own runtime services. Native device pairing supports first login through the CLI, with one-time approval on another phone or computer. No Spotify developer account, API key, or copied session token is required.

Playback and library operations were tested with Spotify 1.2.92.148 on Apple Silicon. Native session inspection also works with macOS 1.3.4.258; headless pairing, restart, search, library reads, devices and MCP were tested with Linux 1.2.95.453. This app uses Chromium Embedded Framework (CEF). The CLI connects to its renderer on a loopback debugging port and discovers services and query definitions from the running app. Spotify handles authentication, playback, and account restrictions.

## Start using it

Install Node 22.19 or newer and Spotify for macOS. The launcher uses `node` from PATH, or an existing bundled Codex runtime when available. Set `SPOTIFY_NODE` to choose a specific executable.

```sh
git clone https://github.com/srikanthsrnvs/spotify-desktop-cli.git
cd spotify-desktop-cli
npm ci
export PATH="$PWD/bin:$PATH"
spotify connect
spotify status --pretty
spotify search "Daft Punk" --type track --limit 5
spotify play --query "Veridis Quo"
spotify pause
spotify resume
```

If Spotify is running without debugging on macOS, use `spotify connect --restart` once. This quits and relaunches the desktop app with debugging bound to `127.0.0.1:9222`. A normal launch from the Dock may require this again. For first login, run `spotify login`, open its returned `verificationUri` on another device, and approve its `userCode`. No notification is sent automatically. Run `spotify login-status` to confirm `loggedIn:true`. Spotify stores the session itself. App files and persistent launch settings are unchanged. The debugging endpoint allows local processes to control this session; quit Spotify to close it.

Use `--port N` or `SPOTIFY_PORT` for another loopback port. On a fresh checkout, run `npm ci` before starting. The cloned REA project is needed for investigation, not for running this CLI.

## Headless Linux

The included container runs the official Linux desktop client under Xvfb, a virtual display. It needs no physical screen, desktop session, VNC, or browser on the Linux host. Another device is used only for first-login approval.

```sh
docker compose up -d --build
docker compose exec -T spotify /opt/spotify-cli/bin/spotify connect
docker compose exec -T spotify /opt/spotify-cli/bin/spotify login
# Open the returned URL on another device and approve the code.
docker compose exec -T spotify /opt/spotify-cli/bin/spotify login-status
docker compose exec -T spotify /opt/spotify-cli/bin/spotify search "Daft Punk" --limit 5
docker compose exec -T spotify /opt/spotify-cli/bin/spotify devices
```

Allow the app to finish starting before calling `connect`. Login returns a pending pairing state; it does not claim authentication until `login-status` reports `loggedIn:true`. Repeated `login` calls reuse the pending code. If the phase is `expired` or `error`, run `login` again. A restart during pairing requires a new code.

The named `spotify-home` volume preserves Spotify's native session across container recreation. Keep this private and preserve it; `docker compose down -v` deletes it and requires pairing again. The debugger has no published port. Commands run inside the container, including MCP:

```sh
docker compose exec -T spotify /opt/spotify-cli/bin/spotify mcp
```

For an MCP client, use `docker` as the executable with arguments `compose`, `--project-directory`, your absolute checkout path, `exec`, `-T`, `spotify`, `/opt/spotify-cli/bin/spotify`, `mcp`.

The current official Linux package is amd64. The image uses Debian 13 because Spotify requires glibc 2.39 or newer; Debian 12 fails dependency resolution. Docker can emulate amd64 on an ARM host, with additional startup cost. On native Linux, install Spotify, Node, Xvfb, xauth and dbus-run-session, run `npm ci`, then `bin/spotify connect`; it starts a virtual display and D-Bus session when `DISPLAY` is absent. `SPOTIFY_BINARY` selects a nonstandard native executable. Stop an existing Linux Spotify service before enabling debugging.

For playback, select an available Spotify Connect speaker/computer using `devices` and `transfer DEVICE_ID`. Local sound on the Linux host requires an audio service and output device configured separately; the container does not configure audio hardware.

## Commands

`spotify help` lists commands. `spotify help playlist-move` describes arguments. `spotify tools` emits JSON Schemas for all 47 app commands. Both `playlist-add` and `playlist add` work, as do equivalent queue and folder aliases. Quote multi-word values.

| Controls           | Commands                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login              | `login`, `login-status`                                                                                                                                   |
| Playback           | `status`, `play`, `pause`, `resume`, `toggle`, `next`, `previous`, `seek`, `volume`, `shuffle`, `repeat`                                                  |
| Discovery          | `search`, `history`, `recent`                                                                                                                             |
| Queue              | `queue`, `queue-add`, `queue-remove`, `queue-move`, `queue-clear`                                                                                         |
| Library            | `library`, `liked`, `save`, `unsave`, `contains`                                                                                                          |
| Playlists          | `playlists`, `playlist`, `playlist-create`, `playlist-update`, `playlist-add`, `playlist-remove`, `playlist-move`, `playlist-follow`, `playlist-unfollow` |
| Folders            | `folder-create`, `folder-rename`, `folder-move`                                                                                                           |
| Devices            | `devices`, `transfer`                                                                                                                                     |
| App                | `settings`, `setting`, `open`                                                                                                                             |
| Advanced discovery | `queries`, `query`, `apis`, `api-call`                                                                                                                    |

URI arguments accept `spotify:…`, `https://open.spotify.com/…` links, or `liked`. Multiple URIs use commas. Search categories are `all`, `track`, `album`, `artist`, `playlist`, `episode`, `show`, `user`, and `audiobook`. Availability depends on the account and region.

```sh
spotify play liked
spotify play spotify:album:1gHpRoAeRbwlG4v8RYBzE3 --index 0
spotify seek 30
spotify volume 25
spotify shuffle on
spotify repeat context
spotify devices
spotify transfer local_device
spotify queue add spotify:track:2LD2gT7gwAurzdQDQtILds
spotify queue
spotify liked --offset 20 --limit 20
spotify contains spotify:track:2LD2gT7gwAurzdQDQtILds
spotify settings
spotify setting playback.autoMix false
```

Playlist creation returns its URI and confirms private, unpublished access. Editing or removing rows requires the exact `uid` returned by `playlist` or `queue`, so duplicate songs can be changed independently. Move indices and pagination offsets start at zero. `queue-clear` clears explicit additions; the playback context continues. `playlist-unfollow` removes a playlist from the library and is recoverable by following its URI again.

```sh
spotify playlist create "Evening mix" --description "A private playlist"
# Substitute returned URI and row UID in subsequent commands:
spotify playlist add PLAYLIST_URI TRACK_URI
spotify playlist PLAYLIST_URI
spotify playlist move PLAYLIST_URI ROW_UID 0
spotify playlist update PLAYLIST_URI --description ""
spotify folder create "Music"
spotify folder move PLAYLIST_URI FOLDER_URI
spotify folder move PLAYLIST_URI root
```

## Give it to a model

Models with shell access can invoke the checkout's `bin/spotify` launcher directly and discover arguments using `tools`. [Model instructions](docs/model-tools.md) explain results and identifiers.

For an MCP client supporting local stdio servers, use [mcp-config.example.json](mcp-config.example.json), replacing the example path with your checkout's absolute path:

```json
{
  "mcpServers": {
    "spotify-desktop": {
      "command": "/absolute/path/to/spotify-desktop-cli/bin/spotify",
      "args": ["mcp"]
    }
  }
}
```

The MCP server exposes 48 tools: `spotify_connect` plus all 47 app commands, including `spotify_login`, `spotify_login_status`, `spotify_search`, `spotify_play`, and `spotify_playlist_add`. CLI and MCP share validated schemas and runtime code. Persistent registration in a particular model client is separate from running the server.

## Results and errors

Operational commands emit one JSON object to stdout:

```json
{ "ok": true, "result": { "percent": 25 } }
```

Failures return `{"ok":false,"error":{"code":"…","message":"…"}}`. Exit status is `0` for success, `2` for invalid arguments or unknown commands, and `1` for execution failures. `--pretty` indents JSON. A timeout or `STATE_NOT_CONFIRMED` may mean a mutation completed; read state before retrying. Failed creation includes `error.details.createdUri` if a playlist already exists.

Common mutations check observed state before reporting success. Advanced `api-call` returns the service response and may require a separate read to confirm its effect. `queries --route album` discovers shipped read queries by loading that route without navigating the UI. Advanced signatures and variables must be discovered from the app; [reverse engineering notes](docs/reverse-engineering.md) include examples.

Spotify updates can change these private interfaces. Missing capabilities return typed errors. Account and device restrictions still apply. Advanced methods have broader scope than the individually verified commands.

## Verification

```sh
npm test
# Deliberately changes playback and disposable library data, then restores them:
npm run test:live
```

The live acceptance run passed 55 operations against the logged-in app, including exact duplicate playlist editing, private creation, queue reordering, playback, settings, and transfers between the Mac and a speaker. It restored the original track, context, position, device, volume, shuffle, and repeat settings, and unfollowed its temporary playlist. Additional live checks covered folders, catalog queries, search categories, cold launch, and MCP execution. Reports and static evidence are stored under the ignored `analysis/` directory.
