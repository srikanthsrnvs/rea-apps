# Charts: TradingView provider assessment

Assessed October 26, 2026. This is the provider decision and research record. The Mathieu-backed app is now implemented; see the [current command guide](../README.md) for its actual scope and verification limits.

## Decision

Build `charts` as one provider-independent Node CLI with JSON output and explicit model tools, consistent with the other apps in this repository.

Use **`@mathieuc/tradingview@4.1.0` as the first unofficial TradingView data adapter**. It is the strongest fit among the options examined: native Node, broad coverage, bounded one-shot operations and streaming, and a current TypeScript API. Wrap it rather than rebuilding its WebSocket protocol or spreading its types through the application. This is a technical integration choice, not a claim of TradingView approval or production data rights.

Use **official Lightweight Charts for a future interactive viewer**, backed by our own normalized datasets. Advanced Charts becomes attractive if a rich drawing and indicator interface becomes necessary and library access is approved. Neither renderer is a market-data provider. A headless CLI does not need a browser to retrieve data; rendering belongs in a consumer-side viewer.

Keep official exchange or licensed market-data adapters possible from the first release. This matters both for reliability and for deeper crypto analysis. One provider's outage, data permissions or symbol coverage should not determine the entire app's capabilities.

## Official MCP correction

The initial assessment missed TradingView's separate **official MCP service**. Its [primary documentation](https://www.tradingview.com/mcp/docs) describes market-data and account tools with OAuth 2.1, PKCE, and Essential-or-higher access (trials excluded). Its endpoint is `https://mcp.tradingview.com/mcp`. The absence of a general public REST data API does not imply the absence of an official agent interface.

The authorization server metadata advertises authorization-code/refresh grants, S256, dynamic client registration and `mcp:read`/`mcp:tools` scopes. It is a concrete alternative for a future provider. The requested implementation remains the Mathieu adapter; official OAuth bearer tokens are not interchangeable with its website session cookies. The adapter's native callback protocol was recovered separately and is documented in [authentication evidence](auth-protocol.md).

## What TradingView officially provides

| Product or interface | What it actually provides | Fit for Charts |
| --- | --- | --- |
| Official MCP service | OAuth-authorized market data and account tools for eligible subscriptions | Worth a separate provider; use its supported OAuth contract. [Official MCP docs](https://www.tradingview.com/mcp/docs) |
| Public market-data / indicator REST API | TradingView's support page says it does not currently offer this | Cannot serve as our official data backend. [Official statement](https://www.tradingview.com/support/solutions/43000474413-i-need-access-to-your-api-in-order-to-get-data-or-indicator-values/) |
| Lightweight Charts | Open-source financial rendering; we provide the dataset, calculations and surrounding interface | Preferred renderer when needed; small integration surface, custom data and overlays. [Product comparison](https://tradingview.github.io/lightweight-charts/docs/product-comparison) |
| Advanced Charts + Datafeed API | A self-hosted chart application with built-in indicators and drawing tools; we implement the datafeed | Consider later for a richer UI. It supplies no market data. [Datafeed overview](https://www.tradingview.com/charting-library-docs/latest/connecting_data/) |
| Trading Platform + client-side Broker API | Chart trading, order tickets and account UI connected to our own trading backend | Outside the research app's initial scope. [Trading concepts](https://www.tradingview.com/charting-library-docs/latest/trading_terminal/trading-concepts/) |
| Broker REST integration | Allows brokers/exchanges to expose their own services to TradingView | The integration direction does not give our app general access to TradingView data or user accounts. [Official explanation](https://www.tradingview.com/support/solutions/43000479602-the-broker-i-want-to-trade-through-is-not-supported-can-you-add-it/) |
| Hosted widgets | TradingView-hosted visualizations with included data | Optional display shortcut; cannot accept our custom data and are not a data API. Paid account upgrades do not upgrade widget feeds. [Widget data FAQ](https://www.tradingview.com/widget-docs/faq/data/) |
| Alert webhooks | Outbound HTTP notifications from configured TradingView alerts | Useful optional event input later. Not a candle API or a general alert-creation API. [Webhook documentation](https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/) |

Advanced Charts and Trading Platform do **not** run Pine Script. JavaScript custom indicators are supported instead; embedding the library does not import a user's TradingView account or reproduce all website features. Access to these proprietary libraries is intended for companies with public projects, rather than personal or hobby use. [Pine and product limitations](https://www.tradingview.com/charting-library-docs/latest/getting_started/Frequently-Asked-Questions/), [access FAQ](https://www.tradingview.com/free-charting-libraries/).

Lightweight Charts leaves indicator calculations and much of the application UI to us. Its distribution requires license/NOTICE handling and TradingView attribution, including a link; preserve that in the viewer. [Official repository](https://github.com/tradingview/lightweight-charts#license).

## Unofficial ecosystem: which parts are worth using

These are representative, relevant options, not an audit of every TradingView fork or MCP wrapper. Feature claims for alternatives below were assessed from their primary documentation; only the selected Node package received our live probes.

| Project | Useful coverage | Assessment |
| --- | --- | --- |
| [Mathieu2301/TradingView-API](https://github.com/Mathieu2301/TradingView-API) / `@mathieuc/tradingview` | Quotes, candles, streaming, symbol metadata, indicators, strategy reports, screening, ratings and account watchlist reads | **Choose as the first adapter.** Node matches this repo; covers the central workflows without a Python sidecar. Published npm default verified as 4.1.0; package declares ISC and Node >=20. Source audited at `f04af705f24dfd883a730e92d18215222bdff272`. [Package manifest](https://github.com/Mathieu2301/TradingView-API/blob/f04af705f24dfd883a730e92d18215222bdff272/package.json) |
| [shner-elmo/TradingView-Screener](https://github.com/shner-elmo/TradingView-Screener) | Extensive scanner fields, SQL-like/nested filters, many instrument universes and timeframe-specific columns | **Keep as a scanner reference.** Its field documentation and query construction are valuable; a second runtime is unnecessary for v1. The README's description of an “official API” is not evidence of a supported public API; TradingView's own statement governs that distinction. |
| [deepentropy/tvscreener](https://github.com/deepentropy/tvscreener) | Rich screening; current docs also cover fundamentals, calendars, news, filings, transcripts, curves and MCP tools | **Best complementary research reference.** Worth a later adapter or selected endpoint additions if those workflows become priorities. Avoid introducing a Python process merely to duplicate the Node adapter's initial scanner. Features were documentation-reviewed, not live-tested here. |
| [rongardF/tvdatafeed](https://github.com/rongardF/tvdatafeed) | Historical candles and a threaded live-bar extension | **Do not choose as the foundation.** Narrower coverage, Python/pandas overhead and documented 5,000-bar requests; its live extension explicitly does not provide real-time samples. Last repository push reported August 2024. |
| [AnalyzerREST/python-tradingview-ta](https://github.com/AnalyzerREST/python-tradingview-ta) | Scanner-derived technical ratings | **Skip as a dependency.** Archived in June 2024, narrow functionality already covered by the selected package. |
| [tradingview-sdk on PyPI](https://pypi.org/project/tradingview-sdk/) | Typed Python search, quotes, bars/streams, screening and published strategy data | **Monitor as a Python alternative.** Current registry metadata reports 0.5.0 and Python >=3.11; no runtime or coverage advantage established for this Node app. This review did not audit its source or run it. |
| [LuxAlgo/PineTS](https://github.com/LuxAlgo/PineTS) | Local Pine-oriented execution using supplied data | **Separate future analysis-engine evaluation.** It is not a client for the TradingView service or a way to access private scripts. Script compatibility, execution semantics and licensing need their own assessment before choosing it. |

Repository activity was checked through GitHub's API on the assessment date. The selected project's last push was October 25, 2026; both scanner projects were active in October 2026. Activity is evidence of maintenance, not proof that every endpoint works. The GitHub “latest release” endpoint still points to v3.5.2 from October 2025, while npm `latest` resolves to 4.1.0: use the actual installed version and lockfile, not release-page assumptions.

## What the chosen package gives us, and what we must add

The [current data API](https://github.com/Mathieu2301/TradingView-API/blob/f04af705f24dfd883a730e92d18215222bdff272/docs/data-api.md) covers the core read workflows. It accepts account session cookies for entitled data, exposes cancellation/timeouts and can reuse a shared client. Its provider interface already permits alternative candle sources, but only covers a minimal candle lifecycle; Charts needs a broader contract for quotes, screening, provenance and analysis. [Provider interface](https://github.com/Mathieu2301/TradingView-API/blob/f04af705f24dfd883a730e92d18215222bdff272/src/data/provider.ts).

Our adapter must handle these differences explicitly:

| Area | Observed or documented limitation | Charts responsibility |
| --- | --- | --- |
| Anonymous data | Limited history; feed availability and delays vary | Report actual coverage and feed mode. An authenticated account is not proof of a particular exchange entitlement. |
| Historical completeness | The source can stop before satisfying a request; the high-level candle array does not expose every completion reason | Return requested/returned counts and actual range. Mark partial/unknown coverage; use the lower-level completion information where necessary. Never call a truncated load complete. |
| Streaming | Watchers stop on fatal disconnects and do not reconnect automatically | Current tools provide bounded finite samples with cancellation and explicit disconnect results. Sustained monitoring would require reconnection, backoff, deduplication and gap backfill; none is implied by a completed sample. Heartbeats alone do not establish fresh prices. |
| Indicators | Plot rows can extend before the returned candle window | Align by timestamps, retain warm-up information, and distinguish server studies from local calculations. Our volume probe returned 120 study rows for 20 candles. |
| Pine/account access | Pine studies need an account; private/invite-only scripts depend on that account's access | Expose availability and clear errors. Do not advertise unrestricted private-script access. |
| Login | Upstream password login explicitly does not support 2FA/CAPTCHA | Do not make password collection the normal login flow. Validate a user-owned session handoff before advertising account features. [Login source](https://github.com/Mathieu2301/TradingView-API/blob/f04af705f24dfd883a730e92d18215222bdff272/src/http/account.ts) |
| Screening | Snapshot pagination, provider-defined fields and delays | Bound page sizes and validate fields; distinguish snapshots from subscriptions. [Scanner contract](https://github.com/Mathieu2301/TradingView-API/blob/f04af705f24dfd883a730e92d18215222bdff272/docs/screener.md) |
| Watchlists | Account read API; live examples used empty lists | Keep local watchlists separate from account lists; verify populated lists before claiming account parity. No upstream list writes are implied. [Watchlist evidence](https://github.com/Mathieu2301/TradingView-API/blob/f04af705f24dfd883a730e92d18215222bdff272/docs/watchlists.md) |
| Backtests | Published Pine reports, local candle backtests and Deep Backtesting are different capabilities | Preserve engine, window, fees, inputs and open/closed position semantics. Do not advertise Deep Backtesting support. [4.1.0 release notes](https://github.com/Mathieu2301/TradingView-API/blob/f04af705f24dfd883a730e92d18215222bdff272/docs/release-4.1.0.md) |

Upstream publishes useful [reliability evidence](https://github.com/Mathieu2301/TradingView-API/blob/f04af705f24dfd883a730e92d18215222bdff272/docs/v4-reliability.md), including parity and lifecycle checks, with explicit limitations. Some documents describe historical beta checks; their counts and coverage should not be represented as our validation of 4.1.0. The record does not establish universal long-running stream health, all chart types, private scripts or Deep Backtesting.

## Independent bounded probes

Installed the exact published `@mathieuc/tradingview@4.1.0` package in an isolated temporary directory with lifecycle scripts disabled. Ran its data entry point directly on Node v25.6.1, without the interactive launcher or account credentials. Each operation had a ten-second deadline. This is a published-package probe; the audited repository commit is recorded separately and is not assumed to be the tarball's exact commit.

| Probe | Result |
| --- | --- |
| Symbol search | Passed; exact `COINBASE:BTCUSD` present among 43 returned matches |
| Hourly candles | Passed; 20 `COINBASE:BTCUSD` bars, finite OHLCV, strictly increasing timestamps and valid price bounds |
| Quote | Passed; finite last price for `BINANCE:BTCUSDT`; upstream mode reported `streaming` |
| Crypto scanner | Passed; both selected symbols returned with the requested price, volume, rating, RSI and feed-mode fields populated |
| Technical ratings | Passed; eight timeframe entries with finite numeric values |
| Anonymous built-in study | Passed; volume study returned 20 candles and 120 study rows |

See the [machine-readable results](../research/tradingview-probe-results.json) and [probe source](../research/probe-tradingview.mjs). These checks establish bounded reachability and response shape on one host. They do not prove independent price accuracy, exchange entitlement, GUI parity, sustained streaming, authenticated Pine execution, populated account watchlists or strategy behavior. No human UI verification was performed.

To reproduce the developer assessment from the repository root:

```sh
probe_dir=$(mktemp -d /tmp/charts-probe.XXXXXX)
cp charts/research/probe-tradingview.mjs "$probe_dir/probe.mjs"
npm install --prefix "$probe_dir" --ignore-scripts --no-audit --no-fund --save-exact @mathieuc/tradingview@4.1.0
(cd "$probe_dir" && node probe.mjs)
```

The script writes `probe-results.json` in that temporary directory. It does not log market prices or account secrets. This is developer maintenance tooling, not a required end-user setup step.

## Data permissions affect the architecture

TradingView's current [terms, section 3](https://www.tradingview.com/policies/#:~:text=non-display%20usage) restrict non-display processing and products built on that data, and say commercial API use requires a separate agreement. The open-source package's software license does not grant those market-data rights; paid TradingView access does not by itself establish them either. For a distributed analytics product, use separately authorized feeds or obtain appropriate permission. The technical recommendation is therefore to keep the unofficial adapter replaceable and distinct from approved production sources. This issue applies to webhook-derived data too; receiving an official webhook is not a blanket data-use license.

## Later crypto depth

Preserve a path for venue-specific spot/perpetual prices, funding, open interest, basis, order-book imbalance, executed order flow, options surfaces and on-chain metrics. Some of this can be charted through TradingView symbols, but reliable comparative analytics needs explicit source identity, units, history and time alignment. “Beyond TradingView” should mean richer raw inputs and reproducible calculations, not simply more indicators on the same candles.

Official exchange APIs are a concrete expansion path: Coinbase documents [historical candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles), while Binance documents funding, open interest, order books, basis and taker-volume endpoints in its [derivatives market-data API](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data). Provider selection, regional reachability, retention and redistribution terms remain separate evaluations. No broader crypto integration is claimed in this assessment.

The [original v1 plan](v1-plan.md) retains the wider roadmap. The [current implementation guide](../README.md), [thirteen live tool checks](../research/live-tools-results.json) and [auth protocol evidence](auth-protocol.md) describe what is implemented and what remains unverified.
