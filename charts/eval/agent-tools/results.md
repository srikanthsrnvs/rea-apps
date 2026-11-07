# Charts tool evaluation — 2026-11-07

The revised CLI reduced Qwen's tool calls from **22 to 8** across seven scenarios
(eight user turns). The authored reference also uses eight calls with the new
tools. Checks improved from **1/7 to 6/7**. This is a useful improvement, but the
overlay answer still fails a factual review; this is not a claim of foolproof
model behavior.

Model: local `qwen3.6:35b`, 35.5B MoE, Q4_K_M, served by Ollama through Pi 0.99.2
RPC on the Mac. Temperature 0, seed 20261107, context 32768, max output 3072,
thinking off. The system prompt is identical between versions and is recorded
in `scenarios.mjs`. No OpenAI model, shell tools or task-specific hidden prompt
was used. See [reproduction instructions](README.md).

## Prompts and actual outcomes

The before/after runs used the same synthetic backend. Its daily YTD window has
311 observations: BTCUSD changes from 100,000 to 81,397.21 (**−18.60279%**), while
BTCUSDLONGS changes from 50,000 to 78,578.87 BTC (**+57.15774%**). Their matched
daily-return correlation is −0.134462. These are test values, not live prices.

| User request | Old Qwen calls / result | Revised Qwen calls / result | Revised reference calls |
| --- | --- | --- | --- |
| Compare Bitfinex BTCUSD and BTCUSDLONGS from Jan 1, 2026 through today, daily | 3; parallel request rejected, then confused which series changed | 1; −18.6% price, +57.16% BTC positions, correct values and units | 1 |
| BTC and ETH quotes in USD on Bitfinex, together | 1; correct prices, wrong observation time | 1; both correct prices without substituting request time | 1 |
| BTCUSD daily for the last calendar month; report actual dates | 1; wrong dates/year, then asked to retry | 1; Oct 1–31, 2026, 31 bars | 1 |
| Free-account login on Orin, configured Mac receiver; provide link | 1; valid receiver link | 1; valid receiver link | 1 |
| All symbols in all saved watchlists; keep headings separate | 1; called a truncated list complete | 1; included all 79 symbols across two lists with separate headings | 1 |
| RSI for Bitfinex BTCUSD, daily | 2; failed Pine request followed by candles, no RSI value | 1; `technicals`, RSI 62.5 | 1 |
| Overlay BTCUSD and BTCUSDLONGS; then “Only this year, 1D…” | 13; wrong years, units, values and interpretations | 2; correct YTD changes and weak correlation, but incorrect prose/units; **failed** | 2 |

Complete prompt strings, final responses, checks and measurements are preserved
in [results.json](results.json). Synthetic login IDs are redacted. The reference
is an authored primary-agent trajectory, not a sampled stronger-model benchmark
or a proven lower bound. Before the new comparison tool, its total was 11 calls.

## Tool changes driven by observed failures

- `compare` handles 2–6 series in one agent call, fetching them sequentially,
  aligning actual timestamps and calculating changes and return correlation.
  It never fills absent observations or presents an undefined ratio as zero.
- Named periods remove repeated calendar arithmetic. Candles also return ISO
  dates and first/last/change summaries. Quotes distinguish observation time
  from retrieval time. Position series have explicit units.
- Watchlists default to 200 entries per page and return `complete` and executable
  continuation requests. The tool description explicitly distinguishes listing
  every symbol from giving an abbreviated sample.
- `technicals` exposes current RSI through the existing scanner. Historical
  Pine remains a separate operation; the provider's Pine failure is not fixed
  by this change and is not disguised as an authentication problem.
- Comparisons retain full plot rows in MCP `structuredContent`, while the text
  given to the model contains compact summaries. The default CLI still returns
  all requested data; `--agent-view` explicitly selects the compact form.
  Clients must keep renderer data out of model context for this to help.
- Login output explicitly identifies our receiver and the official website,
  after a development run incorrectly described a required native TradingView
  app. The authentication transport itself is unchanged.

All **28 existing tool names and input fields remain**; `compare` adds a 29th
tool. **60 deterministic tests pass**, including actual MCP transport tests
that verify full rows survive while the model text stays compact. Pagination,
calendar boundaries, null data, argument rejection and serial provider requests
are covered separately from the model's behavior.

## Calls and data volume

Across the same prompts, model-facing tool output fell from **158,771 to 19,534
UTF-8 bytes** (87.7% smaller), while tool calls fell by **63.6%**. These are bytes
of returned tool text, not token counts or the full context including schemas.
The revised model trajectory matches the reference call count in every case.
A comparison still performs one provider history request per symbol internally;
one agent call does not mean one network request.

The final YTD summary alone was 2,436 bytes, compared with 61,156 bytes and three
attempted calls for the old Qwen trajectory. Full plot data remains available
for consumers that request it. The first overlay's normalization starts at zero
percent change, not a base-100 index.

## Remaining failure: correct data does not guarantee correct prose

In the final overlay conversation, Qwen received `unit: "BTC"` and nevertheless
wrote “BCNT.” It described +57% as “nearly doubled,” invented intermediate price
moves, and attributed buying/selling motives to traders. Its first response also
incorrectly described zero-percent normalization as starting at 100%.

Earlier development runs produced other unsupported stories even when both
headline percentages were correct. Explicit limits and smaller outputs helped
the ordinary comparison request, but did not eliminate this problem in the
open-ended overlay conversation. A renderer should use the structured rows and
units directly; these results do not justify trusting unrestricted narrative
analysis from this model. There is no rendered-image parity claim in this test.

## Live cross-check

Two additional Qwen cases used the real provider anonymously, one call each,
with no browser, login change or account mutation. Their numbers match their
actual tool results. At approximately **23:25 UTC on Nov 7, 2026**, quotes returned
BTCUSD 75,784 and ETHUSD 2,234.20. The separate 311-observation YTD comparison
returned **−14.730636%** and **+24.250769%**, with correlation **−0.246869**.
These are historical snapshots, not current quotes or independent exchange
verification. The last daily bar was still potentially open.

See [live-results.json](live-results.json) for observation timestamps, exact
values and Qwen's responses. Live response values must not be graded against
the synthetic fixtures.

## Evaluation limits

This is a development set with one measured final run per prompt, following
iterations on the same prompts. It is not a held-out accuracy estimate. The
automated grader checks selected factual requirements and is supplemented by
manual review; it does not prove every sentence true. Latency is omitted from
the comparison because cold loading and overlapping early development runs
make it a poor controlled measurement.

The initial baseline overlay used an invalid hourly fixture. It was discarded
and rerun against the frozen original application with the corrected fixture;
only that corrected baseline is counted above. Other development attempts are
also excluded from final totals. Raw transcripts remain in private local run
directories, not the public repository.
