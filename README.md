# Spotify desktop CLI

Control the logged-in Spotify desktop app on macOS with JSON commands or MCP tools. Playback, queue editing, search, library actions, private playlists, playlist folders, Spotify Connect devices, and app settings use Spotify's own runtime services. No Spotify developer account, OAuth app, or copied session token is required.

Tested with Spotify 1.2.92.148 on Apple Silicon. This app uses Chromium Embedded Framework (CEF). The CLI connects to its renderer on a loopback debugging port and discovers services and query definitions from the running app. Spotify handles authentication, playback, and account restrictions.

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

If Spotify is running without debugging, use `spotify connect --restart` once. This quits and relaunches the desktop app with debugging bound to `127.0.0.1:9222`. A normal launch from the Dock may require this again. Login, when needed, happens in Spotify. App files and persistent launch settings are unchanged. The debugging endpoint allows local processes to control this session; quit Spotify to close it.

Use `--port N` or `SPOTIFY_PORT` for another loopback port. On a fresh checkout, run `npm ci` before starting. The cloned REA project is needed for investigation, not for running this CLI.

## Commands

`spotify help` lists commands. `spotify help playlist-move` describes arguments. `spotify tools` emits JSON Schemas for all 45 app commands. Both `playlist-add` and `playlist add` work, as do equivalent queue and folder aliases. Quote multi-word values.

| Controls | Commands |
| --- | --- |
| Playback | `status`, `play`, `pause`, `resume`, `toggle`, `next`, `previous`, `seek`, `volume`, `shuffle`, `repeat` |
| Discovery | `search`, `history`, `recent` |
| Queue | `queue`, `queue-add`, `queue-remove`, `queue-move`, `queue-clear` |
| Library | `library`, `liked`, `save`, `unsave`, `contains` |
| Playlists | `playlists`, `playlist`, `playlist-create`, `playlist-update`, `playlist-add`, `playlist-remove`, `playlist-move`, `playlist-follow`, `playlist-unfollow` |
| Folders | `folder-create`, `folder-rename`, `folder-move` |
| Devices | `devices`, `transfer` |
| App | `settings`, `setting`, `open` |
| Advanced discovery | `queries`, `query`, `apis`, `api-call` |

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

The MCP server exposes 46 tools: `spotify_connect` plus all 45 app commands, such as `spotify_search`, `spotify_play`, and `spotify_playlist_add`. CLI and MCP share validated schemas and runtime code. Persistent registration in a particular model client is separate from running the server.

## Results and errors

Operational commands emit one JSON object to stdout:

```json
{"ok":true,"result":{"percent":25}}
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
