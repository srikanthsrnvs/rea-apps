# Spotify tool instructions for models

Use the checkout’s absolute `bin/spotify` path. The default backend is native Node with direct Spotify Connect/Pathfinder requests. Do not launch Spotify desktop, Chromium, Docker, Xvfb or a browser. Do not use `api.spotify.com` or fall back to the legacy desktop backend. `tools` returns only currently supported schemas; MCP names are `spotify_COMMAND` with underscores replacing hyphens.

Start with `connect` or `login-status`. If logged out, call `login`, give the human the returned `verificationUri` and `userCode`, and poll `login-status` at its prescribed interval. This link is Spotify’s own pairing page. A waiting code is not a completed login, and Spotify sends no automatic notification. Never request account passwords, cookies or tokens. Transient authentication errors preserve the pending grant and defer the next poll.

Playback commands affect the active Spotify Connect receiver, which may be a speaker. Use `devices` before transferring and select its exact device ID or unique exact name. Resolve names with `search`. `play --query` selects the first playable track result; clarify ambiguity when appropriate. The CLI does not provide local audio output on the Linux host.

`discover` finds nearby Connect, Sonos and Cast speakers without login. `devices` merges this with the account list. Select only an `available:true` account receiver for transfer; network-only devices need activation first. `devices --network=false` skips multicast scanning. LAN discovery cannot cross isolated/routed networks. Read results have short bounded caches; use `--refresh` for current reads after an uncertain action. Mutations always bypass and invalidate caches. See [discovery and caching](discovery-and-caching.md).

Playback responses include a prebuilt `spotify.player` component. Preserve its descriptor when forwarding results to a UI-capable renderer. Do not write replacement HTML. MCP serves the static resource; a custom frontend can use `spotify component` and the supplied host adapter. Buttons call the backend directly without a model round trip. Shell JSON alone does not render an interactive card. See [integration details](player-component.md).

Use URIs and exact row UIDs from current results. A track URI identifies a song; a row UID identifies an occurrence. Read queue or playlist before moving/removing entries. Preserve zero-based indices, server revisions and pagination. Do not guess a UID for duplicated rows. Native queue mutations retain unrelated context rows; incomplete or ambiguous snapshots fail.

Private playlist creation confirms privacy before reporting success. If it fails with `createdUri`, inspect that resource before creating another. Follow/unfollow is recoverable library membership; playlist writes and folder operations still need exact returned identifiers.

On `NETWORK_ERROR`, `CONNECT_DISCONNECTED`, `STATE_NOT_CONFIRMED` or an uncertain mutation, read state before retrying. Do not repeat a purchase-like creation or queue addition merely because a reply was lost. Rate limits return a delay when supplied by Spotify and are never bypassed or automatically replayed.

Use `queries` to discover pinned native read queries and `query` with their JSON variables. A rejected/outdated query requires a CLI update; do not guess persisted hashes or switch to a browser. Renderer service introspection, app-only settings/navigation and per-track account history are not supported in the native tool catalog. Keep their historical desktop implementation out of normal operation.
