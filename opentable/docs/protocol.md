# OpenTable protocol and verification

Investigation target: installed Android `com.opentable` 26.25.0, versionCode 2116289. Base APK SHA-256: `0f551382c5a3439aff991acbda99f055e78ac4cb4ad9a77e423f2b89b9c6522e`. REA inspected the package, focused native classes, concrete callers and references using the existing JADX provider. Android is an investigation target, not a runtime dependency of this CLI.

## Evidence boundaries

Native class and method observations below are static evidence, not proof of server acceptance. Abstract Retrofit methods generally lacked method bodies; supplemental ordinary DEX annotation parsing from the same APK recovered endpoint strings and Gson serialized field names. This supplemental parsing is distinguished from retained REA Evidence.

Private APKs, decompiled code, raw API responses, credentials and investigation tooling remain outside Git. No live inventory hold, payment, booking or cancellation was sent during routine verification. Partner API documentation is not substituted for native consumer API contracts.

## Native HTTP contracts

The US native service base is `https://mobile-api.opentable.com`. The shipped anonymous grant uses `grant_type=implicit` and its bundled client identifier/shared constant, without a Bearer header. Authenticated native requests send `Authorization: bearer …`, `Accept: application/json`, `Accept-Language` and `X-OT-SessionId`. The CLI uses the recovered native client format, app version 26.25.0 and an Android 16/display compatibility profile observed on the investigation device. These are protocol compatibility fields, not a claim about the Linux host. Its generated client UUID comes from saved session state; no Android hardware ID or app secret is copied. Token exchange requests do not forward a previous access token. Origins and routes are restricted, redirects are manual, responses are bounded, integer identifiers preserve precision, and errors exclude response payloads and credentials. There are no automatic retries.

| Feature | Native contract |
| --- | --- |
| Anonymous/user token exchange | POST form `/oauth/consumer/token`; implicit, authorization_code or refresh_token grant |
| Verification-code start | POST JSON `/api/v1/2fa/start`; phone `{countryCode,countryId,number}` or email, plus target SMS/EMAIL |
| Verification-code confirmation | POST JSON `/api/v1/2fa/confirm`; contact, code, correlationId, allowPhoneRecycling=false |
| Account/wallet/current reservations | GET `/api/v3/user`; account identity `globalPersonId`, optional explicitly selectable profiles `diners[].id`, saved cards `wallet.cards` |
| Reservation history | GET `/api/v3/user/history/{page}` |
| Exact reservation | GET `/api/v3/user/reservation`; rid, confirmationNumber, securityToken |
| Restaurant search | POST JSON `/api/v5/personalize/search/{page}?forcebannercheck=true`; term, covers, dateTime, location, page, size and native availability flags |
| Restaurant/tables | GET `/api/v3/restaurant/{rid}`; local dateTime, partySize and native table/offer query flags |
| Feature config | GET `/api/configuration/android_feature_config_v11.json` |
| Inventory hold/release | POST JSON or DELETE `/api/v3/reservation/{rid}/lock`; release query slotLockId |
| Booking | POST JSON `/api/v3/reservation/{rid}` |
| Cancellation | DELETE `/api/v3/reservation/{rid}/{confirmationNumber}?token=…` |

Live table reads use the restaurant GET route, whose nested table envelope is `availability.availability.timeslots`. The native PUT availability route was recovered statically but returned HTTP 400 in the bounded runtime probes; the CLI does not rely on it.

Verification confirmation proceeds only for native `nextStep: LOGIN`, then exchanges the returned authorizationCode using the bundled passwordless client. Registration, credential confirmation, phone recycling, and unknown account states produce an explicit additional-step error. Candidate credentials are persisted privately before account validation so a validation failure can be recovered with `auth refresh`. An uncertain code request or token exchange is not replayed automatically.

The live account uses `global: true` and omits `diners`. Native default booking assigns `gpid` and leaves `dinerId` unset; its diner setter has a single caller for explicit profile selection. The CLI follows that global-account branch without inventing a diner ID from customerId or dinerProfile.

## Tables, prices and transactions

Native local times use `yyyy-MM-dd'T'HH:mm`; the CLI accepts explicit restaurant-local times without converting through the host's timezone. Each offered seating/dining-area choice gets a private local UUID, bound to restaurant, date, party and session. An expired or mismatched reference requires fresh availability. Missing native primitive booleans and numeric fields retain their proven constructor defaults; explicit null and unfamiliar shapes remain unknown.

The booking payload uses the selected slot's `slotHash` as `hash`, `token` as `slotAvailabilityToken`, and either tableAttribute or the selectedDiningArea. The submitted `lockId` comes from native `SlotLock.id`, not its separate `lockId` member. A successful booking is a native ReservationHistoryItem; a malformed response after submission can still mean a reservation was created, so it becomes uncertain rather than automatically retried.

Native deposit totals use divisor 100; offer prices supply their own divisor. TimeSlot.priceAmount scaling remains unverified and is preserved as raw data. Unsupported deposits, experiences, new-card and verification flows must not be treated as ordinary zero-charge inventory.

The native stored-wallet branch maps wallet.token to CreditCardLock.customerId and last4 to last4. Provider selection follows a freshly fetched integer config key: `android_alternate_payment_processor_v3 > 0` selects SPREEDLY, otherwise the native default is STRIPE. A successful response omitting that key differs from a failed config fetch. Lock restrictions can disable the wallet or require a separate payment form; these are not bypassed. Payment tokens are excluded from normal output.

Standard zero-upfront-cost cardless tables and compatible saved-card HOLD guarantees are implemented. A newly acquired hold can supply additional guarantee/cancellation terms: the CLI releases that unused hold and returns a new review plan. After the user approves those terms, a new hold must match the reviewed policy before the saved-card payload is submitted. There is no inventory hold left active while the user reads the new terms. An unsuccessful hold release remains unresolved and blocks another operation. Card-guaranteed cancellation retains an unknown fee as unknown and requires explicit `--accept-unknown-fee`; deposit and prepaid refund flows remain unsupported.

Cancellation requires ownership of a current reservation and exact native reservation metadata. `cancellable: true` does not prove zero fees. Local and UTC cancellation cutoffs, card policy messages and refund/experience fields must be considered. Submitted operations persist before network mutation and block replay after an uncertain outcome.

## Selected REA evidence

| Observation | Evidence |
| --- | --- |
| Package identity | `ev_b005bb793ac33a30b606f123e6a1d11d1f376241940ecc8596c71a69dcf1e457` |
| US native API base | `ev_a3260f5b1ae5d5b66b8724072619a70cc649c02303449e360f7570d959816699` |
| Native authentication routing | `ev_28ad9f1a9ee89d4f5db45b683963e7b17eeb1775dbf823c4ae645aae9038a73e` |
| Anonymous grant/refresh caller | `ev_026e8d974820bd1720491691cc3c7d4f1be8f4f5bfde69cba69733eaf51d95ab` |
| Start/confirm request models | `ev_d58d83c30039138f8012c1e35d0b339cffde83dc355eeaa2b5827521e5671f85`, `ev_c361b7cc97ec558b2f4028330ff0bcdd9315874e84e76b02142bd52f60b9c631` |
| Passwordless exchange caller | `ev_5480ff4f489ef50790aa1b90113cb36417d7175232de306dc4f276afaf651547` |
| Native account/wallet models | `ev_3b221ee8753fd4b13496d52a6ecbe708ed38be0f6cf00b9ad2c0c1640768401d`, `ev_dda0f11329ae4eb08d6300e5ec57acb8f097263a52ba5a01cdf274afd35a9169` |
| Personalized search caller | `ev_1928441e63ba1c1b8ca7300a56dbd336bd40eeb694a12de88f94742ff3d0c99d` |
| Selected slot → booking fields | `ev_795a1ad490f0b58dd8c5b0598358a80b4bf9d152a8f15e71413353b83ca34d0a` |
| Hold ID → booking caller | `ev_00c88432e4a35c75e283df0c168c4a2249eb7ec48f9f2ee949651519fc4b70c7` |
| Booking response handling | `ev_db3caf525238905a802cde08c835e4b5b26ab37be387ddc2dbe2154a717e346a` |
| Cancellation caller | `ev_8e53d5394805e5670d5a35f2f26058ee68bd18c9e6c79ab4f339ca855a66ec58` |
| Native table defaults | `ev_0bf6f80321631bf9804ffa2abbf3e16111972664a5c6b5ba6407b9f91aee209d` |
| Payment feature key/default | `ev_15d41f78eba81e04c9d6f809a5eec96174e9a3c78782ed17ab3b930424fdffd0`, `ev_16b7df87d14b6a22a02690ae6c39f2b99b348bcf779664d99cf0dc56b41359e4` |
| Config service/parser | `ev_21026b25a8a3115207fcf8a4baff5b2dcaf2002b0415c9174e2792b297c07994`, `ev_41f1e32f08f81ec77153cf1a18327084d05c619211c3f5e935d7f8a34eb2addd` |
| Wallet restrictions/third-party payment | `ev_6d16986d455d0120bd1e64f860e728f9ab3ba53a4ec6ebaeff62a705f4c0e9ac`, `ev_1c31397a153df5847370b719c40496a0bc673ef516a0f1e74c4b6edec03e2115` |

## Live verification status

Anonymous native token acquisition succeeded on both macOS and the headless Linux ARM64 Orin. CLI search on macOS returned two pages of five restaurants, with 21 and 24 seating choices respectively; restaurant GET returned 21 table choices. Search totals changed between requests and do not imply snapshot pagination. A feature config GET returned HTTP 200 with no alternate-provider flag, matching the native STRIPE fallback.

Initial headless SMS start requests returned HTTP 502 with an empty response, including one request after the user signed into the Android app and confirmed email. The CLI retained an uncertain-login marker and did not automatically retry. Those failed requests did not authenticate the host. A subsequent email verification request using the recovered full client profile returned a correlation ID, and the user supplied the email code. Confirmation and token exchange succeeded on the headless Orin; GET user validated the requested email account and saved the session. Packaged CLI account and saved-wallet reads worked with the new header profile, and a token refresh succeeded. Reservation reads returned 13 account records and a 13-item first history page, with 33 total historical records.

SMS login has not succeeded in this run, and changing both contact type and User-Agent does not isolate the cause of the earlier 502. Headless packaged CLI search returned five restaurants and 17 seating options; restaurant availability returned 32 choices at Wally’s Santa Monica. A cardless booking preview succeeded using the authenticated global account without a diner ID. Reservation history page two also returned 13 records with the expected next-page pointer. A saved-card guarantee preview at Élephante Santa Monica also succeeded; the authenticated full-profile config selected SPREEDLY. This differs from the earlier bare-User-Agent anonymous config response, which omitted the flag and resolved to STRIPE. The CLI fetches current config for each guarantee review. No hold was created by those previews.

Server acceptance of live booking/cancellation remains untested.

All 53 tests passed on macOS and on Linux ARM64 with display variables unset. Automated tests cover injected native wire contracts, OTP/session lifecycle, precision, local model schemas, projected/paginated reads, reviewed transactions, concurrency, account binding, policy changes, release failures and durable prevention of uncertain replay. Synthetic booking/cancellation tests are not live reservation proof.
