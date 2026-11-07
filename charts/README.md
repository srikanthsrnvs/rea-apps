# Charts

A native Node CLI and optional stdio MCP server for market research. Its 29 tools wrap `@mathieuc/tradingview@4.1.0`: symbol discovery, quotes, candles, technical ratings, screening, studies, strategy reports, saved account data, chart datasets and finite streams. The public interface leaves room for additional market and crypto providers.

The Orin uses HTTP and WebSocket only. No Chrome, CDP, Playwright, desktop app, emulator or display server is used, including during login. Public tools work anonymously. Account authorization happens on the user's separate device through TradingView's native callback protocol.

Anonymous tools passed thirteen bounded live checks. User-approved callback login, session reuse, watchlist reading and authenticated quotes were verified on an NVIDIA Jetson AGX Orin with Node 24.21.0. An additional native-app 2FA challenge remains unsupported. Private Pine scripts, strategy reports and UI parity have not been independently verified.

## Install

From the repository root:

```sh
npm --prefix charts ci --ignore-scripts
node charts/bin/charts tools
```

Linux x64/ARM64:

```sh
./scripts/setup-linux.sh --charts-only
charts state
```

The installer reuses a compatible native Node runtime or downloads a checksummed Node 24.21.0 release. It installs no browser, tunnel or background service. The Linux launcher defaults to a 64 MiB V8 old-space target (`CHARTS_HEAP_MB`, 32–256); this is not a total process RSS limit.

## Public tools

```sh
charts symbols search --query COINBASE:BTCUSD --type crypto --limit 5
charts symbol --symbol COINBASE:BTCUSD
charts quotes --symbols '["COINBASE:BTCUSD","BINANCE:BTCUSDT"]'
charts candles --symbol COINBASE:BTCUSD --timeframe 1h --count 100
charts candles --symbol BITFINEX:BTCUSD --timeframe 1d --period last_calendar_month
charts compare --symbols '["BITFINEX:BTCUSD","BITFINEX:BTCUSDLONGS"]' --period year_to_date --include-data
charts technicals --symbol COINBASE:BTCUSD
charts screener fields
charts screener --market crypto --columns '["name","close","volume","RSI"]' --sort-by volume --limit 10
charts hotlist --kind gainers --market crypto --limit 10
charts indicators search --query RSI --limit 10
charts indicator values --symbol COINBASE:BTCUSD --indicator Volume@tv-basicstudies-241 --count 20
charts chart --symbol COINBASE:BTCUSD --timeframe 1h --count 100
```

`charts tools` is the canonical command/schema catalog; `charts --help` also works without loading the provider or accessing the network. Array/object CLI flags contain JSON; MCP clients supply typed arrays/objects. Unknown flags and invalid cross-field arguments are rejected before state or network access. Commands write one JSON result to stdout; failures write sanitized JSON to stderr and exit nonzero.

Network tools accept `--auth auto|anonymous|required` and `--timeout-ms 15000`. `auto` uses a saved session if present. `anonymous` does not read saved credentials. An expired saved session produces an actionable error rather than silently changing account scope.

Candles are ordered and include requested/returned coverage, venue, settings and a warning that the final bar may be open. Counts do not prove gap-free history; completeness stays unknown when the provider cannot establish it. Missing prices and ratings remain null. Technical ratings retain the scanner's original [-1,1] scale. Study rows align to candle timestamps, excluding earlier warm-up rows; compiled scripts and Pine source are omitted.

`chart` returns a portable candlestick/volume dataset, without launching a viewer. Strategy reports are provider-generated reports, can contain open positions, and place no orders. `compare` performs local calculations on aligned source bars and can return a normalized line-overlay dataset with `--include-data`. Watchlist writes, a visual viewer and deeper crypto providers remain future work.

## Finite stream samples

```sh
charts stream quotes --symbols '["COINBASE:BTCUSD"]' --seconds 5 --max-updates 10
charts stream candles --symbol COINBASE:BTCUSD --timeframe 1m --seconds 5 --max-updates 5
```

`stream indicator` uses the same study arguments as `indicator values`. Streams retain bounded compact updates and close on completion, cancellation or failure. Candle/study events include the latest bar rather than repeated histories. These commands do not create a background monitor or automatically reconnect after disconnection. A partial sample reports the failure and retained updates.

## Account authorization

This CLI keeps the native TradingView provider and works with free accounts. It does not require TradingView's paid official MCP API. Public market-data commands still work anonymously.

On the **user's Mac**, configure the login receiver once with a trusted, passwordless SSH connection to the host:

```sh
CHARTS_NODE=/absolute/path/to/node sh charts/scripts/setup-macos-client.sh \
  --ssh-target truffle@ORIN_ADDRESS \
  --remote-cli /home/truffle/.local/bin/charts \
  --profile orin
```

The installer builds `~/Applications/Charts Login.app`. Node 24.21+ and Apple's command-line developer tools are required on the Mac. The SSH target and remote executable are saved privately on that Mac; links cannot override them. The receiver is a client dependency only: nothing graphical is installed on the Orin.

On the **Orin**, an agent runs:

```sh
charts login --client-profile orin
```

Send the returned **`clientUrl`** to the user. Their client must open `rea-charts://` links through macOS. The receiver checks the current login against the trusted host, opens the official TradingView approval page in the user's browser, and forwards the resulting native callback over SSH using stdin. The host validates the account before saving it. No callback copying or credential export is required. Verify completion with:

```sh
charts auth poll --login-id LOGIN_ID
charts auth validate
charts watchlists --limit 10 --symbol-limit 50
```

`login` independently checks an existing saved account. An expired or rejected session starts a replacement grant while preserving the old account until the replacement validates. `login --username NAME` pins the expected account; `login --replace` explicitly allows switching accounts. Repeated pending logins reuse their current grant. There is no reliable automatic cookie refresh endpoint: use a fresh approval when TradingView expires or revokes the session.

The original manual flow is retained: open `approvalUrl` with an existing native callback receiver, put the callback in an owner-only file, and run:

```sh
charts auth complete --login-id LOGIN_ID --callback-file /private/path/callback.txt
```

The receiver uses `--callback-stdin` instead, so the credential never appears in SSH arguments. Both mechanisms exchange the same TradingView grant; the full existing toolset is retained. If an exchange outcome is uncertain, it is never blindly retried. An acquired candidate can be validated again with `auth complete --login-id LOGIN_ID` without resending its callback. `auth cancel` preserves the previous account; `logout` removes local authorization.

The automatic Mac receiver was verified end to end with user approval on the Orin on November 7, including independent validation, persistence, watchlists and authenticated quotes. Extra native-app 2FA remains unsupported. Authenticated Pine execution returned a separate provider payload parse error and is not claimed as working. The receiver currently targets macOS, and a browser-only iPhone/Windows client cannot complete this flow without an equivalent native receiver. See the [client setup and recovery guide](docs/mac-login-client.md) and [protocol evidence](docs/auth-protocol.md).

## MCP

`charts mcp` starts the optional stdio server, exposing the same schemas and service as the CLI. Example client configuration after a local source install:

```json
{
  "mcpServers": {
    "charts": {
      "command": "node",
      "args": ["--max-old-space-size=64", "/absolute/path/rea-apps/charts/bin/charts", "mcp"]
    }
  }
}
```

An installed Linux client can instead use the absolute path to `~/.local/bin/charts` with `mcp` as its argument. Provider code loads only for online operations; MCP dependencies load only for `mcp`.

## Memory, state and verification

One online operation or authorization mutation runs at a time per process. HTTP bodies are capped at 4 MiB, WebSocket messages at 2 MiB and tool output at 2 MiB. Schemas also bound symbols, pages, bars, stream duration and retained updates. There is no persistent login worker or tunnel.

Development measurements on macOS ARM64/Node 25.6.1: tool discovery peaked near 47 MiB RSS, one anonymous quote command near 68 MiB, and the expanded thirteen-check live harness near 113 MiB with a 64 MiB old-space target. These are not Orin measurements or guarantees. Measure again on the deployed runtime; lower requested counts when history or study responses exceed the caps.

On the actual Jetson AGX Orin/Linux ARM64/Node 24.21.0, an anonymous quote peaked at 71.8 MiB RSS; a sequential authenticated watchlist/quote check peaked at 104.6 MiB. Both used a 64 MiB old-space target. The second figure measures the whole sequence in one process, not isolated per-command usage. See the [Orin authentication results](research/orin-auth-results.json).

Private state lives under `$CHARTS_STATE_DIR`, otherwise `$XDG_CONFIG_HOME/charts-cli` or `~/.config/charts-cli`. Directories use 0700, files 0600, and authorization changes use a cross-process state lock. Account cookies and proof values are excluded from output and Git.

```sh
npm --prefix charts test
npm --prefix charts run test:live
```

The deterministic tests cover argument validation, normalization, crash recovery, cancellation, private-file bounds, POST/2xx callback exchange, secret redaction, real stdio MCP transport, bounded HTTP/WebSocket transports and stream cleanup. The opt-in live harness makes thirteen sequential anonymous reads/samples; [recorded results](research/live-tools-results.json) identify platform, runtime flags and RSS. The separate Orin record covers real callback authorization and account reads. No broader human UI parity, private Pine or additional-2FA verification is claimed.

- [Agent guide](ai.md)
- [Provider assessment and official MCP correction](docs/provider-assessment.md)
- [Original roadmap and remaining work](docs/v1-plan.md)

TradingView's separate [official MCP service](https://www.tradingview.com/mcp/docs) uses OAuth and is a possible future provider. Its OAuth tokens are not interchangeable with the Mathieu adapter's session cookies.

## Agent-friendly comparisons and evaluation

`compare` fetches 2–6 series sequentially in one tool call, aligns exact timestamps,
and returns first/last values, percentage changes and return correlation. By
default it reports daily year-to-date summaries. `--include-data` adds normalized
and raw plot rows; it prepares data and does not claim to render an image.
MCP returns the full plot and exact sample observations in `structuredContent`,
with only summaries in its model-facing text. Integrations must keep the full
structured result for rendering. CLI consumers receive all rows by default;
`--agent-view` explicitly selects the compact model view.
Hosts that also serialize `structuredContent` into the model context must route
the plot payload to their renderer separately to get the context reduction.
`BTCUSDLONGS` is identified as a quantity in BTC, so it is not confused with the
BTC/USD price. The difference between these differently measured series is not
short interest.

Named UTC periods such as `last_calendar_month` remove calendar arithmetic from
the agent. Candle results retain numeric timestamps and also expose ISO dates
and a change summary. Quote `asOf` identifies observation time separately from
request time. Watchlists report `complete` and executable `nextRequests`; an
agent must follow them before claiming to have listed everything.
`technicals` includes current RSI on eight timeframes without a Pine request.
Historical indicator plots still use `indicator values`; this does not fix the
upstream Pine protocol error documented in the provider assessment.

The [local Qwen/Pi evaluation](eval/agent-tools/README.md) compares the old and
revised contracts on the same prompts and deterministic backend. Model runs use
only Charts tools, without a shell or hidden answer-specific prompts. Live runs
are restricted to public reads; the evaluation never modifies a real account.
