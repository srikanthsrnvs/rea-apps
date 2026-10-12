# Spotify tool instructions for models

Use the checkout's absolute `bin/spotify` path to control the user's existing Spotify desktop session. Run `tools` for command schemas and `help COMMAND` for argument details. In MCP, commands are named `spotify_COMMAND`, with underscores replacing hyphens. `spotify_connect` takes an optional boolean `restart`.

For [headless Linux](headless-linux.md), setup must run once before using tools. Use the absolute `bin/spotify-headless` path with the same app commands or `mcp`. If its container is stopped, `service start` starts it and waits for the native login service. `service logs` helps diagnose startup failures. The ordinary `bin/spotify` launcher also selects the private native Node runtime installed by setup; `connect` alone does not start the Docker service.

Start with `connect` or `login-status`. If logged out, call `login` and give the human its `verificationUri` and `userCode` to approve on another device. There is no automatic notification. Poll `login-status` until `loggedIn:true`; then use the operational commands. A pending pairing response is not a completed login. Repeated `login` calls reuse the current code; an expired or failed attempt permits a new one. Never request the user's password or session tokens. On macOS, `connect --restart` enables debugging if necessary; on Linux, stop an existing service before relaunching. CLI commands return an `ok` boolean and a `result` or typed `error`; MCP also sets `isError` for failures.

Follow the user's requested scope. Playback commands affect the active Spotify Connect device, which may be a speaker rather than this Mac. Use `devices` before `transfer`; select its exact device ID or unique name. Use `search` to resolve names into URIs and clarify ambiguity when needed. `play --query` intentionally chooses the first track result.

Use URIs and row UIDs from tool results. A track URI identifies a song; a queue or playlist UID identifies one occurrence. Read `queue` or `playlist` immediately before removing or moving a row. Indices and offsets are zero-based; playlist pages support `--offset` and `--limit`. Folder URIs can have the form `spotify:user:USERNAME:folder:ID`.

`playlist-create` verifies private, unpublished access. Preserve its returned URI. If creation fails with `createdUri` in error details, inspect that playlist before creating another. `playlist-unfollow` removes it from the user's library and is recoverable by following its URI. `queue-clear` removes explicit additions while retaining the playback context.

Read a setting with `setting KEY` before changing it. Setting values are JSON: `true`, `false`, numbers, or quoted strings, for example `setting language '"en"'`. Use `settings` to discover writable keys. Spotify determines supported values.

Read state after `TIMEOUT`, `DISCONNECTED`, or `STATE_NOT_CONFIRMED` before retrying a mutation. Repeated additions or creations can produce duplicates. Normal commands confirm their effects; generic `api-call` returns the underlying service response.

For additional capabilities, use `apis` to discover services and `apis SERVICE METHOD` to inspect the shipped implementation. Pass positional arguments as a JSON array to `api-call`. Advanced methods can change persistent data. Discover query names with `queries`; optionally load a route with `--route album`, `search`, `show`, or `track-v2`, then pass a JSON object of variables to `query`. Use current definitions rather than guessing module numbers or persisted hashes.
