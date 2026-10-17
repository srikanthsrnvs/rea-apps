# Speaker discovery and efficient reads

## Controller only

The CLI and MCP server control an existing Spotify Connect receiver. They do not initialize an audio engine, advertise a playable receiver, download audio, or keep a player/TUI process running. A mutating Connect command briefly registers a hidden non-player observer and closes it afterward. Reads need no observer. `spotify tools` reports these capabilities explicitly.

The prebuilt player is rendered by the client. It does not require a browser on the Orin. The historical desktop backend is loaded only when explicitly selected; native imports are tested to reject any attempt to load its renderer or lifecycle modules.

Volume, shuffle and repeat getters also use direct cluster reads without opening a WebSocket. Their setters use the short-lived native observer and fresh confirmations. A successful component action reuses its confirmed playback result instead of immediately polling it again; manual refresh and recovery after an uncertain action request fresh state.

## Local discovery

```sh
spotify discover --refresh                 # No Spotify login needed
spotify discover --timeout-ms 1000
spotify devices --pretty                  # Account devices + nearby speakers
spotify devices --network=false           # Account device list only
spotify devices --refresh                 # Fresh account state and LAN scan
```

Discovery sends bounded mDNS queries for `_spotify-connect._tcp.local`, `_googlecast._tcp.local`, and `_sonos._tcp.local` on private IPv4 interfaces. It uses native UDP and HTTP, with no extra runtime packages or discovery daemon. PTR/SRV/TXT/A records are assembled across replies; follow-up queries are sent only for missing records. UDP sockets close after the scan (default two seconds). Connect/Sonos `getInfo` probes use bounded timeouts, response sizes and concurrency. Redirects are rejected and Spotify credentials are never attached to local requests.

`discover` returns `{devices, warnings, source}`. Its account visibility is unknown because it does not authenticate. `devices` retains account-derived availability, active state, volume and exact IDs while attaching matching network metadata. Physical speakers advertising Connect and Cast are combined when the address matches unambiguously. Connect aliases retain their distinct selectable IDs.

A network-only device is marked `available:false`, `accountVisibility:"not-listed"`, and `requiresActivation:true`. This implementation discovers those speakers but does not automatically log them in or launch a Cast receiver. `transfer` requires an available account Connect device; activate a network-only receiver through Spotify first. Discovery does not claim that merely finding a device makes it controllable.

Results are reused for at most 30 seconds, scoped to the current interface addresses. `--refresh` rescans and replaces the snapshot. Multicast discovery covers the host's local network: routed networks, guest Wi-Fi isolation and multicast filters can prevent results. Account Connect discovery still works in those cases; it does not depend on mDNS.

## Read cache

Repeated commands share a bounded owner-only cache under the normal private state directory. The cache is scoped to the authenticated controller/account and contains data plus hashed request identities, never access or refresh tokens. It has at most 64 entries and about 2 MiB total; individual responses over 512 KiB are not cached. CLI processes still exit, and MCP requires no separate player daemon.

| Read | Maximum snapshot age |
| --- | --- |
| Service discovery | 10 minutes |
| Playback/device/queue cluster | 1 second |
| Search, library, membership, recent reads | 15 seconds |
| Playlist contents | 5 seconds |
| Playlist hierarchy/rootlist | 10 seconds |
| Profile | 5 minutes |

Identical in-flight reads share their request. Separate CLI/MCP commands use the shared state lock and saved snapshots, so a second waiting command can reuse the first result. Search type and pagination remain part of the key. No retry is introduced for rate limits, network errors or mutations. Failed command results are not persisted as new cache entries.

Every native read command except login-status accepts `--refresh` to replace saved reads with fresh data. Read caches are invalidated before mutations; all reads used by the mutation, including revision checks and final confirmations, bypass caching. Successful pairing and logout also clear account snapshots. Fresh rootlist requests preserve their on-wire cache buster. Transient cache I/O problems fall back to live reads; a failure to invalidate a cache stops a mutation before it is sent.

## Reference and verification

These design ideas were informed by the MIT-licensed [spotatui](https://github.com/LargeModGames/spotatui/tree/c44f106faa49642832ba224ee01b760cb2351f52), especially its [LAN discovery](https://github.com/LargeModGames/spotatui/blob/c44f106faa49642832ba224ee01b760cb2351f52/src/infra/spotify/lan.rs), [search caching](https://github.com/LargeModGames/spotatui/blob/c44f106faa49642832ba224ee01b760cb2351f52/src/infra/spotify/search.rs), and [session without playback](https://github.com/LargeModGames/spotatui/blob/c44f106faa49642832ba224ee01b760cb2351f52/Cargo.toml). The Node discovery/cache code is independently implemented using the standard library; spotatui and librespot are not runtime dependencies.

Protocol tests cover DNS parsing/compression bounds, socket cleanup, credential-free local probes, duplicate protocols and aliases, concurrent read sharing, expiry/account isolation, cache size limits, and real native dispatch invalidating reads before simulated writes. Browser acceptance still exercises the actual prebuilt player adapter without changing real playback.

Live checks on the ARM64 Orin found additional local devices, including LSX speakers outside its account device list. Instrumented separate CLI processes measured two HTTP requests for a fresh search (service discovery + Pathfinder), then zero for the repeated search; a fresh status read and subsequent device read likewise shared the cluster snapshot. Cached command peak RSS was approximately 53 MiB versus approximately 97–98 MiB for fresh network reads in that sample. These are workload measurements, not universal memory limits. The desktop container stayed stopped throughout.
