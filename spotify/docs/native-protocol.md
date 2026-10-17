# Native Spotify protocol migration

The default backend is an independent Node controller. It has no runtime dependency on Spotify desktop, Chromium, CEF, WebView, Docker, emulation, Android, or a locally running audio player. It uses the account’s approved Spotify session to control an existing Spotify Connect receiver.

## Observed endpoints

| Feature | Native service and wire behavior |
| --- | --- |
| New-machine sign-in | Form POST `https://accounts.spotify.com/oauth2/device/authorize`; return Spotify approval URL/code. |
| Poll and renew | Form POST `https://accounts.spotify.com/api/token`; device grant and refresh-token grant. |
| Service discovery | GET `https://apresolve.spotify.com/?type=dealer&type=spclient`. |
| Playback/device reads | GET resolved spclient `/connect-state/v1/cluster`. No local player registration needed for reads. |
| Real-time state | Secure WebSocket to resolved dealer, with the account’s token; its welcome supplies `Spotify-Connection-Id`. |
| Short-lived controller | PUT `/connect-state/v1/devices/hobs_<id>` with the connection ID and hidden, non-player capabilities. |
| Player controls | POST `/connect-state/v1/player/command/from/<id>/to/<receiverId>` with the shipped JSON command shape. |
| Volume | PUT `/connect-state/v1/connect/volume/from/<id>/to/<receiverId>` with a 16-bit integer volume. |
| Transfer | POST `/connect-state/v1/connect/transfer/from/<id>/to/<receiverId>`. |
| Catalog/profile/library | POST `https://api-partner.spotify.com/pathfinder/v2/query`, using pinned first-party operation definitions. |
| Playlist hierarchy/folders | Native `/playlist/v2/user/<username>/rootlist` and revision-guarded changes. |
| Private playlist setup | Native `/playlist/v2/playlist` and `/playlist-permission/v1/playlist/<id>/permission/base`. |

The controller registers `can_be_player:false`, `hidden:true`, `needs_full_player_state:true`. It never advertises itself as an audio receiver. A command opens only a small WebSocket connection when needed, sends the mutation once, confirms state, unregisters its observer and closes. CLI reads and commands exit; MCP keeps its Node server alive only while the host is connected.

The public Web API at `api.spotify.com` is deliberately excluded from the HTTP helper. Its attempted reads returned HTTP 429 during investigation, and no further Web API requests or automatic fallback are used. Native endpoint rate limits likewise stop execution and expose a server delay when supplied; the implementation does not rotate proxies, replay requests or bypass those responses.

## Authentication

The shipped desktop public OAuth client identifier is `65b708073fc0480ea92a077233ca87bd`. It is an application identifier, not a developer API key or client secret the user must obtain. An independent RFC 8628 device-grant implementation sends form data directly from Node. The user approves only on Spotify’s own site. No password, browser cookie, desktop cache or copied authentication token is needed on a new machine.

The actual Orin experiment issued a new device code through this endpoint, received the user’s approval and exchanged it for access/refresh tokens. The device-grant token was accepted directly by native spclient HTTP, the dealer WebSocket and Pathfinder. A Login5/AP bootstrap, client token or browser fingerprint was not needed for these tested calls.

Tokens are stored in owner-only files and renewed before expiry under a shared command lock. Concurrent CLI/MCP processes cannot exchange the same device code or rotate a refresh token simultaneously. Pairing respects the server interval and `slow_down`; temporary service failures retain the grant and respect `Retry-After`. A revoked grant permits fresh pairing. Mutations are never automatically repeated after a network error.

## Shipped evidence and corroboration

- Retained REA login analysis: `ev_61d0ae342fcf2e5583ae8a85f5701b95a2cdcb0aff5560c07a6ee6499bc2a35b`. Its selected login bundle contains the public client ID; native strings contain both authorization endpoints and the device-grant identifier. Static evidence is scoped to those artifacts and is not a network capture.
- Fresh REA target observation: `ev_007104fd1ddc8fa1cff5a58ebb01ef398d1933a2409a99376ec621eb11a0b6a4`; passive runtime observation: `ev_fd78327985af795462b598fcc9c27c88e42ff84b8f935b85b554c7a2e1955318`. The observed desktop was Spotify 1.3.5.3058 / CEF Chrome 151. The passive window captured no new network requests, so it is not evidence of individual endpoint execution.
- Current desktop `xpui.spa` SHA-256: `dd25db62f22ee19683c0cfc73db9eb82400181618b6ee9930bb48fc641b98e73`. Selected current search member identities and operation hashes are retained in `QUERY_MANIFEST`.
- Native Connect JSON behavior is present in the retained first-party mini-player snapshot and corresponding current native strings/descriptors. The `SetVolumeCommand` descriptor confirms no `command_id` field; adding it caused a measured HTTP 400 and removing it fixed the request. This regression is covered by a strict body test.
- The official Spotify web-player build `web-player.0079e2e5.js`, SHA-256 `1129f07952e06b00be6af909364b0a6285f80636164613019cf4fa5fefe64062`, corroborates shared native profile, library, playlist and rootlist contracts. It is inspected as static source only; no downloaded JavaScript is executed at runtime.
- Independent primary references: [librespot device authorization](https://github.com/librespot-org/librespot/blob/19959512c212cbc48a3ff64382fe204f52c659a7/docs/device-authorization.md), [OAuth implementation](https://github.com/librespot-org/librespot/blob/19959512c212cbc48a3ff64382fe204f52c659a7/oauth/src/lib.rs), and [native session implementation](https://github.com/devgianlu/go-librespot/blob/90a4fdaf0314269e3fa25698a5f4270c026d2c03/session/session.go). No native playback library or its audio dependencies are required by this controller.

The endpoint results above were additionally tested through direct Node/Python requests on the Orin. Those are ordinary runtime experiments, distinct from the REA evidence. Their raw account-specific responses and tokens remain private outside Git.

## Validation and limits

Verified live: independent pairing, token renewal, dealer handshake, Connect cluster, native profile, search, liked songs, library, playlists and playlist contents. A same-value speaker volume command succeeded through native Connect. After stopping the desktop container, normal CLI status/devices/search/liked and the prebuilt component continued to work. Peak RSS measured with per-process OS resource accounting was approximately 97–99 MiB for these commands. The previous desktop container sample was 1.218 GiB and 242% CPU; these are workload observations, not general resource guarantees.

Queue, playlist and folder write contracts have simulated protocol/state tests. They are not all live account mutation acceptance tests. Creation preserves an uncertain resource’s URI; row/folder edits use exact identifiers and revisions and fail closed on incomplete snapshots. A read confirmation does not make an uncertain failed mutation safe to repeat.

Account/device restrictions still apply. This program controls an existing Connect receiver; it does not provide local audio decoding. Native private services can change. Pinned-query mismatch requires updating the manifest from fresh first-party artifacts. App-local settings/navigation, renderer service introspection and per-track account history remain outside the native tool catalog.

The historical desktop bridge is preserved for explicit comparison through `SPOTIFY_BACKEND=desktop`, with no automatic fallback. Default setup no longer builds, starts or restarts that application.

The controller also supports bounded native mDNS speaker discovery and account-scoped read caching. The historical desktop modules are imported only on their explicit path. See [discovery, cache policies and reference attribution](discovery-and-caching.md).
