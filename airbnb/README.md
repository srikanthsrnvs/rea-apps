# Airbnb CLI

Standalone Airbnb tools for agents, reconstructed from the Android app using REA. Commands use Node's built-in HTTP client. No Chromium, browser driver, Android runtime, emulator, desktop session, extension, or developer API registration is required on the host.

## Install

```sh
./scripts/setup-linux.sh --airbnb-only
airbnb tools
```

The installer supports Linux ARM64 and x86-64 and reuses the repository's Node runtime when available. It installs `airbnb` in `~/.local/bin`, plus `cloudflared` for temporary login verification links. On macOS, run `node airbnb/bin/airbnb tools` with Node 24.21 or newer; install `cloudflared` separately if verification is requested.

There are no npm dependencies. REA and the APK are investigation inputs, not runtime dependencies. A live dated search on the ARM64 Orin peaked at approximately 105 MiB RSS; this is a measurement of that command, not a guaranteed upper bound for every response.

## Sign in

```sh
airbnb login --phone +15555550123 --country US
# If the result contains a verification URL, open it on your own device, then:
airbnb auth verification resume --login-id RETURNED_ID
# After Airbnb sends the SMS:
airbnb auth verify --login-id RETURNED_ID --code 012345
airbnb account
```

The first command identifies the phone and requests one code through the shipped phone gateway. Airbnb can require verification first: the returned link shows its official Arkose widget in the user's own browser, and `auth verification resume` submits that genuine result before continuing the pending code request. The Orin runs only Node and a temporary HTTPS tunnel; it never runs a browser or Android. The agent then asks the user for the SMS code and submits it. The link expires with the pending login, and its relay closes after completion or expiry.

Always use an international phone number beginning with `+`; national numbers are rejected locally. `--code-file FILE` avoids putting a code in shell history. If Airbnb requests another verification step, use the next server-issued code. Repeating `login` reuses pending or saved state and does not resend the SMS. Native email login is available through `--email ADDRESS`, but the phone flow is the live-verified path.

The CLI saves a login only after a separate account request validates the expected user. A failed replacement keeps the previous session. If that account request is interrupted, use `airbnb auth validate --login-id ID`; this retries the read without resending the code. `auth status` reports pending state without exposing tokens. `auth resend` is explicit and has a cooldown. `auth cancel` discards a pending login. `logout` removes only the local CLI session.

An unrecognized challenge returns `action_required`. The CLI does not fabricate Android attestation, claim a browser challenge was completed, or silently create a new account. No token refresh grant has been verified; use `login --replace` if Airbnb rejects a saved token.

## Search and account reads

```sh
airbnb places search --query 'Venice, California'
airbnb stays search --query 'Venice, CA' --checkin 2026-11-06 --checkout 2026-11-08 --adults 2
airbnb stays search --cursor 'RETURNED_CURSOR'
airbnb listing get --listing-id ID --checkin 2026-11-06 --checkout 2026-11-08 --adults 2
airbnb listing calendar --listing-id ID --month 11 --year 2026
airbnb wishlists list --offset 0
airbnb wishlist get --wishlist-id ID
airbnb trips list --limit 9
airbnb inbox list --page-size 20
airbnb inbox search --query 'arrival'
```

Commands return JSON. `airbnb tools` returns machine-readable command definitions. Search returns a local opaque cursor that retains the upstream cursor and original dates, destination and filters for one hour; pass it to the same CLI installation to continue. Two searches cannot overwrite each other's cursor context. The original upstream response remains available with `--raw`. Listing IDs are decimal strings, including large IDs that do not fit JavaScript's safe integer range. Raw account responses may contain personal data.

## Booking

```sh
airbnb booking preview --listing-id ID --checkin 2026-11-06 --checkout 2026-11-08 --adults 2 --currency USD
# Show the returned stay, total, payment choices, terms and required actions to the user.
# Only after approval of that exact purchase, selected card and host message:
airbnb booking confirm --review-id ID --payment-option payment-1 --max-total 700.00 --currency USD --accept-terms HASH --message-to-host 'USER_APPROVED_MESSAGE' --confirm
airbnb booking status --review-id ID
```

Preview initializes Airbnb's draft checkout and returns its exact total, taxes, payment choices and policies. A draft confirmation code is not a booked reservation. Reviews expire after ten minutes and belong to the signed-in account. Confirmation requires the exact terms hash, currency, approved maximum total, selected payment option and explicit `--confirm`. A required host note must be supplied by the user. The CLI supports an existing unexpired saved card that needs neither CVV nor 3DS; new-card, insurance-choice, identity, unsupported sections and other payment actions stop explicitly. It never invents attestations or a host message.

Submission is journaled before its single POST. Repeating the command returns the recorded result; a second review cannot bypass a submitted or uncertain booking for the same stay. Only a recognized explicit fulfillment success counts as confirmed. `booking status --lookup` can additionally fetch confirmation presentation data, but does not resubmit or resolve an ambiguous transaction merely because a page exists.

## Cancellation

```sh
airbnb cancellation preview --confirmation-code CODE
# Choose one of the server's offered reasons, then review its current refund terms:
airbnb cancellation preview --confirmation-code CODE --reason-id OFFERED_REASON_ID
# Only after the user approves cancellation and the displayed refund/fees:
airbnb cancellation confirm --review-id ID --accept-terms HASH --confirm
airbnb cancellation status --review-id ID
```

The CLI preserves the server's formatted refund and fee information rather than guessing amounts or currencies. A five-minute review requires an offered reason, supported sections, refund information and the native primary confirmation button. Intervention and unsupported refund-choice flows stop with `action_required`. Confirmation refreshes the terms; a change requires a new review. The final request uses the native reason enum and omits unrequested messages, subreasons and refund-method overrides. It is journaled once, with a separate guard against replay through another review.

## Verification status

Verified on Linux ARM64 on 2026-10-21: phone login through genuine browser verification and SMS; independent account validation; session reuse in new CLI processes; destination search; distinct pages of dated stay search, trips and inbox; listing details/calendars; saved lists and saved-list details; inbox search; and authenticated draft checkout with an exact total, taxes, saved-payment options and policies. A live search command peaked at approximately 105 MiB RSS.

Final booking and cancellation requests are reconstructed from the shipped app and covered by offline tests, including changed terms, account mismatch, price limits, unsupported actions and lost responses. **No real reservation has been placed or cancelled to validate those final submissions.** Additional payment/identity actions and automatic reconciliation of an uncertain write remain unsupported. Do not treat a successful checkout preview as proof that payment or final booking will succeed.

## Storage and failures

Private state is in `$XDG_CONFIG_HOME/airbnb-cli` or `~/.config/airbnb-cli`, with directory mode `0700` and file mode `0600`. Set `AIRBNB_STATE_DIR` for a separate account or test environment. Do not commit or share this directory.

Requests have time and response-size limits. No state-changing request is automatically retried after a missing response. `request_pending` or an `unknown` submission outcome means it may already have reached Airbnb. Inspect status and the account before taking further action; creating another review does not bypass a pending transaction. Booking/cancellation journals are retained across login and logout to protect against duplicate submissions. Revocation, service changes, rate limits, or additional verification can interrupt future use.

## Development

```sh
node --test airbnb/test/*.test.mjs
```

See [protocol evidence](docs/protocol.md), [authentication](docs/auth-protocol.md), and [checkout/cancellation](docs/booking-protocol.md). Production source and synthetic tests are public; APKs, raw captures, OTPs and account data stay outside the repository.
