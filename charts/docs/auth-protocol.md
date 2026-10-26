# TradingView native callback authorization

This implementation uses a genuine provider protocol, without running TradingView Desktop or a browser on the host. Its lifecycle is fixture-tested. A successful user-approved account exchange is still unverified, so account capabilities must retain that qualification.

## Evidence

On October 26, 2026, inspected the official [Linux desktop package](https://tvd-packages.tradingview.com/ubuntu/stable/latest/jammy/tradingview_amd64.deb), version **3.4.1**, SHA-256 `ec381f4239db177e1f3d9bed151a635c4ec56b5c3780ebd1b18a63657806c868`. Only static package/archive inspection was used on the development Mac. The app was not installed or executed. No desktop package, extracted application source or binary is part of Charts or its installer.

The `AuthenticationHandler` in `resources/app.asar` establishes this flow:

1. Generate a private 32-byte ASCII proof string and compute its SHA-256 hex digest.
2. Open `https://auth.tradingview.com/accounts/tvd/connect/?locale=en&key=HASH&redirect_url=tradingview%3A%2F%2Fbrowser-auth%2F` in the user's browser.
3. TradingView sends the final app callback `tradingview://browser-auth/?token=TOKEN`.
4. The native client makes a single GET to `https://auth.tradingview.com/accounts/tvd/complete/?token=TOKEN&key_source=PRIVATE_PROOF`, with the TradingView referer. Native code considers HTTP 200/409 responses before interpreting the returned JSON.
5. The issued session is usable by the account HTTP API. Charts additionally validates it with the Mathieu SDK's independent `getUser` call before saving an account.

Charts generates 32 ASCII hex characters from 16 cryptographically random bytes, then hashes the UTF-8 string. Only the hash goes to the approval page; the private proof stays in the host's protected pending record. The token alone cannot replace that proof.

An anonymous request using the native redirect reached the provider's sign-in redirect, whose response was rate-limited; this was **not** a completed login. An arbitrary `https://example.com/callback` redirect was rejected with HTTP 400 and `Unknown redirect path`. Therefore, this implementation neither invents an HTTPS redirect nor starts a callback tunnel or unsupported polling loop. The user copies the official final app-button link to the host instead.

## Durable lifecycle

- `login` persists an expiring pending attempt before returning its approval URL. No network helper remains running. The current local approval deadline is ten minutes.
- `auth complete` accepts exactly one unmodified native callback token. A callback file must be an owner-only regular file, at most 16 KiB, opened without following symlinks.
- The pending phase becomes `exchanging` before the one-time GET. A network/parse failure becomes `exchange_uncertain`, and the exchange cannot be replayed. Cancel and begin a fresh grant.
- Session cookies must have usable TradingView domain/path scope; host-only `auth.tradingview.com` cookies are not accepted as website account credentials.
- Persist the acquired candidate, then mark `validating`. Failed independent validation can be retried without sending the callback again. A validated account must match any requested username and the previous-session binding.
- If interruption occurs between the candidate save and phase update, completion recovers the candidate without repeating the exchange. If the account was committed before cleanup finished, completion reconciles that saved login ID and removes the stale pending state.
- Replace a saved account only after validation. State transitions use the native apps' participant-ticket filesystem lock. Files use 0600, directories 0700, and atomic writes.
- Cancellation and deadlines apply while waiting for the state lock. Private reads verify ownership/type, avoid blocking on FIFOs, refuse symlinks and cap actual bytes read even if a file grows after inspection.
- `auth cancel` deletes pending/candidate records and preserves the saved account. `logout` deletes local authorization. Neither operation revokes other provider sessions.

The pending proof, callback, cookies and full upstream exceptions must never appear in logs or tool results. A callback file is itself a credential and should be removed after successful use.

## Additional verification and boundaries

The native client can receive `2FA_required` or `2FA_challenge_not_generated` and then uses an in-app verification webview under `/accounts/two-factor/complete/…`. Charts has not implemented that additional protocol. It returns `additional_verification_required`, saves no new account and preserves any previous account. It never launches a host browser as a fallback.

Real callback exchange, populated watchlists, account Pine studies, private layouts and strategy parity still need user-authorized integration checks. No user account was accessed for the anonymous live harness.

TradingView also has a separate [official MCP service](https://www.tradingview.com/mcp/docs), using OAuth 2.1 and PKCE. Its bearer tokens do not establish that they can be exchanged for this adapter's website cookies. An official MCP provider should implement its own authorization contract rather than borrowing or inventing a cookie conversion.
