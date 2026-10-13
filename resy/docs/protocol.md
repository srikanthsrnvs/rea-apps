# Resy protocol and evidence

Investigation date: 2026-10-12. Target: installed Android `com.resy.android.prod` 3.24, versionCode 978756. Base APK SHA-256: `81409f0a3c9b0e8c88ce09200fd7811308189a634ea9d046ce8d19f270539655`. REA pulled the complete APK set and inspected the base package with the existing JADX 0.7.1 provider. The app was used for investigation only; runtime CLI commands use Node HTTP.

## Login handoff

The Android manifest contains restaurant/blog app links and Stripe callbacks; no dedicated Resy login callback was established in that manifest. Native authentication contains password, phone/email verification, challenge continuation, access-token and refresh-token flows. That does not establish a device approval protocol.

Resy's official widget provides a supported embedding boundary: after successful phone, email, password or challenge authentication, it calls `window.parent.postMessage({event:"loginSync", token:user.token}, "*")`. The CLI's connection page checks the exact `https://widgets.resy.com` origin, the designated iframe's window, event name, and bounded token before sending the result to a one-time, same-origin endpoint. The session is validated through `GET /2/user` before being saved.

The public widget's `authSuccessRedirectUrl` alone does not carry a token back to a headless host. Its `authRedirect` message contains a redirect URL only. A top-level widget posts to itself, so it cannot serve as a cross-device callback. The CLI therefore hosts an iframe connection page, optionally exposed through a temporary HTTPS relay. This is CLI design around Resy's observed first-party widget behavior, not a claimed Resy OAuth/device-code grant. Credential entry and verification remain in the official widget. Existing browser-session refresh does not emit `loginSync`; a fresh sign-in is required.

The final connection page has no added visible text or branding. Its widget URL uses the shipped `authSuccessRedirectUrl` and phone-prefill parameters. An empty-space prefill normalizes to a blank phone field with country code 1, preventing the widget's initial null-country fallback into email/password. Desktop and mobile Chromium probes verified the initial phone form inside the actual full-viewport page with its CSP. This parameter behavior is observed client behavior and may change. Successful handoff clears the approval fragment and redirects to the official Resy homepage.

## API contracts

API origin: `https://api.resy.com`. The public widget supplies an application identifier through `Authorization: ResyAPI api_key="…"`; this is shipped client configuration and requires no developer registration. Authenticated reads send the approved access token in both `X-Resy-Auth-Token` and `X-Resy-Universal-Auth`. The origin profile is the official widget. Redirects are manual, responses are bounded to 20 MiB, large integer identifiers retain precision, and errors omit server payloads and credentials. Requests are not automatically retried.

| Capability | Contract |
| --- | --- |
| Account / saved methods | GET `/2/user`; `payment_methods` belongs to this account response |
| Restaurant search | POST JSON `/3/venuesearch/search`; `query`, `geo`, `page`, `per_page`, `slot_filter.day`, `slot_filter.party_size`, `availability`, `types` |
| Restaurant | GET `/3/venue`, query `id` |
| Daily table options | POST JSON `/4/find`, `venue_id`, `day`, `party_size`, `lat`, `long` |
| Calendar | GET `/4/venue/calendar`, `venue_id`, `num_seats`, `start_date`, `end_date` |
| Reservations | GET `/3/user/reservations`, optional `type`, `offset`, `limit` or exact `resy_token` |
| Quote | POST JSON `/3/details`, `config_id`, `day`, `party_size`, `commit=0` |
| Confirmed booking preparation | Same details endpoint with `commit=1`, after reviewed-plan confirmation |
| Booking | POST form `/3/book`, fresh `book_token`, optional JSON-encoded `struct_payment_method:{id}`, `venue_marketing_opt_in=0` |
| Cancellation | POST form `/3/cancel`, `resy_token` |

The website and native app corroborate table `config.token`, seating type and local start time. The CLI does not parse an opaque token to guess its restaurant. It verifies that exact token against the selected venue/date/party's current availability before creating a booking plan.

Quote responses can omit restaurant ID and name in their `venue` object. The verified availability result supplies those review fields; root `locale.currency` supplies currency. Service charges can be structured `{amount,value}`, and cancellation refund/credit cutoffs are nested. Native monetary fields are `BigDecimal` passed into the money constructor without division by 100; CLI amounts retain their currency-unit values.

Booking obtains a fresh committed `book_token.value`, checks `date_expires` when provided, and sends it once. An HTTP 412 conflict is not an instruction to retry or replace an existing reservation. Committed details can be preparatory server state; tests and live read probes do not claim `commit=1` is a pure read. No committed-detail or live booking request is sent during routine verification.

Saved-card retrieval initially failed with HTTP 405 because a source path was misclassified. Tracing the actual caller showed `GET /2/user`; `/2/user/payment_method` is a card mutation path and is excluded from this CLI. The corrected read was corroborated by the authenticated account response. No card mutation was attempted.

## Evidence provenance

All listed native evidence is static, not observed execution. Most Retrofit abstract method inspections supplied no body; supplementary direct DEX annotation parsing recovered their endpoint/parameter strings from the same APK. Those supplemental findings are labeled ordinary static inspection rather than REA Evidence. Concrete callers, models and manifest observations were recovered through REA.

| Source | REA Evidence |
| --- | --- |
| Package identity and manifest | `ev_9efdb8dc0db5ff0c4bc21d46c17bd51d72ea5207a0578f438edf5444a7ade4fa` |
| Native access/refresh token and account model | `ev_fd54e1ca82b4be5024f78f2dc7fd382c0f4ea60a0d5e33d3c810a40ad765d5ed` |
| Native token headers | `ev_1208f2e148bc5b57361c45475c04c7a5298900d0119fad089a92f27921a03338`, `ev_c13bb526965b6b6c3be55fe51875b116c98bbea84587b0db6dfa102c1d0c03c2` |
| Native venue-search request fields | `ev_0c8225a616149587064b4281dc658e0415e40c02c19e79962dfc285fa667789e` |
| Native preview details caller, `commit=0` | `ev_46b4893b04e42669f4fea92512d0138d60f5d838d8f104f55f8ac3ed15d661b5` |
| Native fresh committed details → booking caller | `ev_f0ac632beb1d7c504e6aeda15575bc5a8e09b31e92010489e83c4f15f0dd8f2e` |
| Native book-token expiry model | `ev_38923925028db30b07ab3943fc7cddffa6400b8224792458bcc8b329845d2936` |
| Native booking form and explicit conflict handling | `ev_4cfe8df57b7f7dd1d2439360b4aa9dd0a95d1891ee5c240e81d2aac1edf3cdd2` |
| Native currency-scale construction | `ev_2725646356f51574b519abb301483f7e6c4998de4d99f54cd9c3fc66ca8dded1` |
| Native cancellation caller and success handling | `ev_c83ae002b5e6efa6affb4e8cd5f36b43af1a0f3639de75ae669da8ed381fcab6` |
| Official widget static syntax analysis | `ev_118c6bb86c0dc22f9cc863057e8ff29efed790e7dbd36c4782743359e4b1fd05` |
| Official website application / shared modules | `ev_75b838fa3fdedf2cc4e809f09b9dc52f5e11204afb601b00bafcb102e482e633`, `ev_9d6ae872aa77e0c6a4a5976e76f06d44f680a85c1b78fecb77f2ce283a6b0ff5` |

The selected widget and website app syntax records were retained, but their semantic workers exceeded the default 1024 MiB heap. Exact source slices and concrete native callers support the contracts above; this is not a claim of complete semantic or cross-bundle reconstruction. Other client features and unselected files remain outside the investigation scope.

First-party web sources: [Resy](https://resy.com/), [official widget](https://widgets.resy.com/), and its served app/shared bundles. Relay configuration follows [Cloudflare Quick Tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/); the installer pins checksummed assets from [cloudflared 2026.10.0](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.0). Private raw responses, APKs, decompiled text and account data are stored outside Git.

## Verification scope

Automated tests exercise real local HTTP handoff handlers and the page message bridge, injected API transport, process-state boundaries, model schemas, projected reads, and synthetic booking/cancellation responses. They cover price and cutoff changes, missing cards, account mismatch, concurrency, durable replay prevention, HTTP 412, lost responses, and unconfirmed cancellation.

On 2026-10-12 the headless Linux ARM64 Orin generated a public HTTPS login link. The user completed a fresh Resy sign-in in a separate client browser. The host received the widget's session, validated the account through plain HTTP and persisted a mode-0600 session. The link and relay closed after completion. Public venue, daily tables, calendar and uncommitted quote reads also succeeded from plain Node HTTP.

The 35 automated tests pass on macOS and Linux ARM64. With `DISPLAY` and `WAYLAND_DISPLAY` unset, the packaged Linux CLI validated the saved session, returned search pages of five restaurants each, read 30 table options and three calendar days, projected saved payment methods and upcoming reservations, and prepared a venue-bound booking review. That preview used `commit=0`; it was not confirmed. Its unsubmitted test plan was removed afterward.

Live booking, `commit=1`, and cancellation have not been performed. Their contracts are supported by native/web source and synthetic transaction tests; no real reservation was created or canceled for testing. Mobile Safari compatibility has not been specifically verified. Private service versions, eligibility, CAPTCHA requirements, and rate limits can change; the CLI reports a challenge rather than trying to defeat it. An uncertain operation requires manual reconciliation before another operation of that kind.
