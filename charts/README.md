# Charts

A native Node CLI and optional stdio MCP server for market research. Its 27 tools wrap `@mathieuc/tradingview@4.1.0`: symbol discovery, quotes, candles, technical ratings, screening, studies, strategy reports, saved account data, chart datasets and finite streams. The public interface leaves room for additional market and crypto providers.

The Orin uses HTTP and WebSocket only. No Chrome, CDP, Playwright, desktop app, emulator or display server is used, including during login. Public tools work anonymously. Account authorization happens on the user's separate device through TradingView's native callback protocol.

Anonymous tools passed thirteen bounded live checks. Account login and account-dependent features have fixture coverage but still require a real user-approved integration test. An additional native-app 2FA challenge is explicitly unsupported; no session is saved in that case.

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

`chart` returns a portable candlestick/volume dataset, without launching a viewer. Strategy reports are provider-generated reports, can contain open positions, and place no orders. Local calculations, comparisons, watchlist writes, a visual viewer and deeper crypto providers remain future work.

## Finite stream samples

```sh
charts stream quotes --symbols '["COINBASE:BTCUSD"]' --seconds 5 --max-updates 10
charts stream candles --symbol COINBASE:BTCUSD --timeframe 1m --seconds 5 --max-updates 5
```

`stream indicator` uses the same study arguments as `indicator values`. Streams retain bounded compact updates and close on completion, cancellation or failure. Candle/study events include the latest bar rather than repeated histories. These commands do not create a background monitor or automatically reconnect after disconnection. A partial sample reports the failure and retained updates.

## Account authorization

```sh
charts login --username YOUR_TRADINGVIEW_USERNAME
```

Open the returned `approvalUrl` on your own phone or computer, sign in and approve access. Copy the final **Open TradingView** app-button link (`tradingview://browser-auth/?token=...`) into an owner-only local file, then complete the exchange on the Orin:

```sh
chmod 600 /private/path/tradingview-callback.txt
charts auth complete --login-id LOGIN_ID --callback-file /private/path/tradingview-callback.txt
charts auth validate
charts watchlists --limit 10 --symbol-limit 50
charts indicators saved --limit 10
```

The callback is a credential: keep its contents out of logs and delete the file after use. `--callback-url` is supported, but a file keeps it out of shell history/process arguments. No password, manual cookie export, invented polling endpoint or host browser is involved. The private proof remains on the host. TradingView does not accept an arbitrary HTTPS redirect for this native grant.

`auth status` inspects local metadata. If a candidate was acquired but independent account validation failed, repeat `auth complete --login-id LOGIN_ID` without a callback to retry validation. Completion also recovers an interrupted candidate save or post-save cleanup without repeating the exchange. An exchange with an uncertain outcome and no acquired candidate is never replayed: use `auth cancel` and start again. `login --replace` preserves the previous account until the new one validates. `logout` removes local authorization.

The native protocol was recovered by static inspection and tested with fixtures; a successful real account exchange has not been verified here. Extra native-app 2FA requires a separate protocol implementation and returns `additional_verification_required`. See [protocol evidence and lifecycle](docs/auth-protocol.md).

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

Private state lives under `$CHARTS_STATE_DIR`, otherwise `$XDG_CONFIG_HOME/charts-cli` or `~/.config/charts-cli`. Directories use 0700, files 0600, and authorization changes use a cross-process state lock. Account cookies and proof values are excluded from output and Git.

```sh
npm --prefix charts test
npm --prefix charts run test:live
```

The 32 deterministic tests cover argument validation, normalization, crash recovery, cancellation, private-file bounds, secret redaction, real stdio MCP transport, bounded HTTP/WebSocket transports and stream cleanup. The opt-in live harness makes thirteen sequential anonymous reads/samples; [recorded results](research/live-tools-results.json) identify platform, runtime flags and RSS. No human UI comparison or account-dependent integration test is claimed.

- [Agent guide](ai.md)
- [Provider assessment and official MCP correction](docs/provider-assessment.md)
- [Original roadmap and remaining work](docs/v1-plan.md)

TradingView's separate [official MCP service](https://www.tradingview.com/mcp/docs) uses OAuth and is a possible future provider. Its OAuth tokens are not interchangeable with the Mathieu adapter's session cookies.
