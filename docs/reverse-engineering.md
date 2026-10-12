# Spotify runtime investigation

The investigation used the [REA repository](https://github.com/morluto/rea) at commit `6611bcf6e86630c775c24e6afa00d7239c64e70e`, package 6.4.0. `npm ci` and `npm run build:cached` succeeded using existing Node 24.19.0 and npm 10.9.2. REA's exact pins are Node 24.18.0 and npm 11.16.0; no global toolchain was upgraded.

`bin/rea` selects the compatible bundled runtime. Set `REA_NODE` to override it. The shell's default Node 23 is unsupported by REA. Its MCP stdio smoke test listed 172 tools. Persistent Codex registration was not changed. See REA's [installation guide](https://github.com/morluto/rea/blob/6611bcf6e86630c775c24e6afa00d7239c64e70e/docs/installation.md). The CLI runs independently of REA. To reproduce the optional investigation setup:

```sh
git clone https://github.com/morluto/rea.git rea
git -C rea checkout 6611bcf6e86630c775c24e6afa00d7239c64e70e
cd rea
HUSKY=0 npm ci
npm run build:cached
cd ..
./bin/rea --help
./bin/rea inspect-plist /Applications/Spotify.app --format json
./bin/rea inspect-artifact /Applications/Spotify.app/Contents/Resources/Apps/xpui.spa --format json
./bin/rea mcp
```

## App packaging and bridge

The tested Spotify 1.2.92.148 build is arm64 and uses CEF rather than Electron. `Contents/Resources/Apps/xpui.spa` is a ZIP. REA extracted it and analyzed `xpui-snapshot.js` and `dwp-now-playing-bar.js`: two successful parses, zero failures, 249 relevant files inventoried, 247 outside the selected scope. This static evidence is partial coverage.

The renderer is `https://xpui.app.spotify.com/index.html`. The CLI selects that origin through Chrome DevTools Protocol and validates that the websocket belongs to its loopback port. It finds the platform object in the React root, resolves services by registry Symbol descriptions, and invokes the app's methods.

Playback and queue operations use `PlayerAPI`. Playlist rows use `PlaylistAPI`; the playlist tree and folders use `RootlistAPI`. On this build, `LibraryAPI.contains` does not correctly represent saved playlists, so playlist membership uses `RootlistAPI.contains`. Device transfer needs the app's logging argument as well as a device ID.

The webpack or Rspack chunk loader provides shipped GraphQL definitions and routes. Production code discovers query names and hashes from loaded factories and has no hardcoded module IDs or persisted hashes. Loading a route adds definitions without UI navigation. Requests use the app's GraphQL loader and authentication context.

New playlists have an asynchronous permissions boundary. The public setter can discard a native error status. Private creation waits for the permissions transport, checks the native status, and verifies `BLOCKED` access before success. The observed protobuf enum uses `BLOCKED = 1`.

## Advanced examples

```sh
./bin/spotify queries --route track-v2
./bin/spotify query getTrack '{"uri":"spotify:track:2LD2gT7gwAurzdQDQtILds"}'
./bin/spotify query getAlbumNameAndTracks '{"uri":"spotify:album:1gHpRoAeRbwlG4v8RYBzE3","offset":0,"limit":10}' --route album
./bin/spotify apis PlayerAPI getState
./bin/spotify api-call PlayerAPI getState '[]'
```

Twenty-five service families were discovered, including offline state, equalizer, private session, local files, follow state, and audio output. Signatures and support vary by build and device. The generic interface excludes authentication services and selected broad deletion methods. It reports service results without claiming that every method was exercised.

## Evidence

| File | Purpose |
| --- | --- |
| `analysis/spotify-plist.json` | Bundle metadata |
| `analysis/spotify-xpui-artifact.json` | ZIP inventory |
| `analysis/spotify-xpui-extraction.json`, `analysis/xpui/` | Extraction provenance and sources |
| `analysis/spotify-javascript.json` | REA static analysis |
| `analysis/spotify-runtime-targets.json` | Runtime discovery |
| `analysis/playlist-creation-boundary.json` | Permissions behavior |
| `analysis/cli-live-verification.json` | Live checks and restoration |
| `analysis/spotify-mcp-verification.json` | MCP schemas and live invocation |
| `analysis/cli-reconnect.json` | Launch and reconnection |

These evidence files are local investigation artifacts, contain account-specific state, and are not distributed in this repository. They are ignored by version control. The CLI does not extract or persist credentials. Named operations return compact data; credential-shaped fields in generic results are redacted.
