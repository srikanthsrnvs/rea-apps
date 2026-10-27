# Charts agent guide

Read the root AGENTS.md, this app's README and docs/auth-protocol.md before changing runtime/authentication. This app targets a low-memory headless Orin. Never add Chrome, CDP, Playwright, desktop binaries, emulators or display servers to its runtime, even for login.

## Interface and architecture

`src/tool-definitions.mjs` is the shared CLI/MCP schema catalog. `cli.mjs` handles typed flags; `validation.mjs` rejects unknown/invalid arguments before state/network access; `service.mjs` normalizes the pinned Mathieu provider. `mcp.mjs` loads only for explicit stdio use. New providers belong behind the same interface rather than separate user-facing CLIs.

Call `state` to inspect local capabilities/session metadata. A saved session's `authenticated` flag means present; `validated: false` means it was not checked online in that call. Use `auth validate` for an independent account read. Public reads need no login; `auth=anonymous` avoids reading account credentials. Never silently switch away from a rejected saved account.

Tools return structured JSON with status/message, provenance and coverage. Preserve unknown values as null. Provider exceptions can contain account cookies or compiled code: use the static safe error mapping, not raw messages, details or stacks.

## Authentication

Use the genuine native TradingView callback protocol described in docs/auth-protocol.md. The user opens the official approval URL on another device and provides the final app callback link through `auth complete`, preferably in an owner-only callback file. There is no generic HTTPS callback or polling API for this grant. Do not collect passwords, export browser cookies or pretend an ordinary login page transfers a session.

Persist the pending proof before returning the approval URL. Mark an exchange as started before submission; never replay an uncertain exchange. Persist a candidate before independent `getUser` validation, and allow validation retries without resubmission. Verify expected username and previous-session binding before replacing the saved account. Cancellation preserves the saved account; logout removes local state. Keep all proof/cookie records private and out of logs/results.

Recover a persisted candidate if interruption occurred before its phase update. Reconcile a committed login ID before applying the previous-account binding check, so a post-save cleanup failure cannot strand a successfully validated account. Keep file reads bounded by actual bytes, refuse FIFOs/symlinks and respect cancellation while waiting for state locks.

Native extra 2FA currently returns an explicit unsupported result. Callback exchange, independent identity validation, saved-session reuse, watchlist reads and authenticated quotes were verified on the actual Orin. See research/orin-auth-results.json. Do not extend that evidence to private Pine, saved scripts, populated-watchlist UI parity, strategies or private layouts.

The client on the user's device must receive the native `tradingview://browser-auth/` callback. A plain browser approval link cannot complete that handoff without a registered receiver; Safari's invalid-address message demonstrates this. The test used a temporary Mac receiver, then removed it. Never turn that client requirement into a browser or desktop-app dependency on the Orin. The completion request is POST, not GET. Accept 2xx responses with independently validated session cookies: the real service returned 201 Created despite the inspected desktop client's narrower status checks.

## Data pitfalls

- The SDK's high-level technical-analysis helper converts missing values to zero and rescales ratings. Use its scanner primitive, preserve nulls and retain the raw [-1,1] scale.
- SDK study rows can precede the candle window. Align by `$time`, not array position; report excluded warm-up rows. Never return Pine source or compiled `.script` values.
- A fulfilled bar count does not prove complete/gap-free history. Label partial counts, unknown coverage, synthetic chart types and the possibly open last bar. Preserve source venue, timeframe, session, adjustment and currency.
- Quotes may be absent in a batch; preserve per-symbol availability and missing values. Provider feed mode is not independent proof of latency or exchange entitlement.
- Crypto hotlists need `filter: []` to avoid inheriting the SDK's stock-only default. Scanner pages are snapshots; field availability varies by universe.
- Watchlist `###` entries are section markers, not markets. Saved account lists are read-only.
- Strategy records may include open positions. Use the upstream summary and retain its settings/currency; don't infer that a populated exit field proves closure or advertise Deep Backtesting.

## Memory and verification

Keep one online operation active per process, load provider/MCP dependencies lazily, and retain compact finite stream events. Bound response bytes, WebSocket payloads, symbols, history, pages and graphics before introducing richer datasets. No automatic resident monitors or reconnect loops currently exist. Always stop watchers on limits, aborts and errors.

Use `npm test` for deterministic checks and `npm run test:live` only when anonymous integration reads are appropriate. Record platform, Node version and peak RSS with measurements; development Mac results are not Orin results. Live anonymous checks do not establish account access, independent price accuracy, UI parity or sustained stream reliability.
