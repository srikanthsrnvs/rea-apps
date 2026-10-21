# Authentication protocol

Phone login was verified through the installed CLI on Linux ARM64 on 2026-10-21. The host ran Node HTTP and a temporary tunnel only. A genuine verification result from the user's browser satisfied Airlock; Airbnb acknowledged the phone-code request, the user received its SMS, and the native flexible-auth endpoint accepted that code. A separate `Account` request confirmed the returned identity before the CLI saved it. A later CLI process successfully read the account using the saved session.

```sh
airbnb login --phone +15555550123 --country US
# If a verification link is returned: open it on the user's own device, then:
airbnb auth verification resume --login-id ID
airbnb auth verify --login-id ID --code 012345
airbnb account
```

`login` performs the initial identify and one source-backed phone-code dispatch, retaining the same native auth attempt. A repeated command reuses the pending state or saved session rather than sending another SMS. An additional code request requires an explicit `auth resend` or `auth request-sms` command and respects the cooldown. HTTP acceptance of a dispatch alone is never reported as carrier delivery.

`src/auth-protocol.mjs` implements the APK's first-party flexible auth protocol without network, browser, Android, or storage dependencies. Its source evidence is recorded in the private investigation's `auth-findings.md` and `auth-ledger.json`.

Call `createAuthFlow({email})` or `createAuthFlow({phone,countryCode})`, where phone is a full international number with `+` and calling code, such as `+14155550123`, and countryCode is a separate two-letter country such as `US`. Common spaces, parentheses and hyphens are removed; bare national numbers are rejected before any request. The countryCode field must not be assumed to tell the server how to parse a national number. A complete server OTP destination that disagrees with the requested international number stops the flow with `AUTH_DESTINATION_MISMATCH`; it cannot be verified or resent. Masked destinations do not establish a mismatch. Optional `deviceId` and `persisted` values belong to the caller's private client state.

`buildAuthRequest(flow,{action:'identify'})` returns `{path,method,headers,body,nextFlow}`. Send the request once using the shared transport and feed the response to `applyAuthResponse(nextFlow,{status,headers,body})`. Preserve the returned state and serialize work on each flow. On `code_required`, explicitly request `verify` with a six-digit string, including any leading zero. A resend requires a separate user action; choose only a server-offered `method` to request an alternate OTP channel.

The protocol retains accumulated steps and the opaque server auth headers. Private state can contain verification codes needed for subsequent steps. Protect it as credential data, delete it after completion/expiry, and print only `publicAuthStatus(flow)`. This public view excludes codes, tokens, opaque header values, full destinations, and raw server messages.

A response token produces `validation_required` and private `candidateTokens` (`{token,aaj}`), plus `userId`. The module never returns `authenticated:true`. Independently validate the candidate with an authenticated account read before replacing any saved session. Unknown steps, passkeys, social authentication, signup and other unsupported requirements return `action_required`; they cannot produce a successful login merely because HTTP status is 200 or a token appears beside a challenge. Airlock is handled separately by the durable orchestration described below.

Local policy expires the flow after 15 minutes, waits at least 30 seconds between explicit code requests, allows three explicit resends and ten verification attempts, and honors HTTP 429 Retry-After. These are client bounds, not a claim about server OTP or access-token lifetime. No background requests or automatic resends occur. An uncertain network outcome leaves a request pending for the caller to resolve; this module does not silently repeat it. Failed verification rolls back that failed step before an explicit retry.

The CLI reproduces the shipped client's `appHashType: ANDROID` format selector while reporting unsupported passkey capabilities and its actual Node/OS user agent. That enum is not treated as a hardware attestation or proof. Omitting it was accepted by the API but did not establish SMS delivery. The CLI supplies no fabricated device integrity, captcha, passkey, or other verification proof. A server challenge must be satisfied through a supported legitimate flow. No access-token refresh mechanism is established by this module; AAJ maxAgeSecs is not treated as access-token expiry.

All functions accept an optional numeric `now` (milliseconds since epoch) for deterministic clock testing. Flow/request/response arguments remain unchanged.

Run the isolated tests with `node --test airbnb/test/auth-protocol.test.mjs` from the repository root.

## SMS lifecycle evidence

The examined Android code does not issue an extra Airbnb challenge request upon entering the phone OTP screen. `PhoneOTPChallengeScreen.mo8436` creates state from the response; `te31` records a local timestamp and starts a Google SMS Retriever listener through `x931` and `l490`. That listener receives arriving SMS messages. The `auth/challenge/sms_otp` request runs from the separate resend callback with `RESEND_OTP`; there is no source basis for adding a guessed initial `challengeRequested` request. Relevant REA Evidence: screen state `ev_99586f60e09b7b1127e5adcb326ee280ea10b6b60c7629072f76b3da66b37f2a`, lifecycle `ev_4700445999de69fa087e7e367723bf9bbd6fba797898bf1f0b52234c186c72ce`, SMS Retriever `ev_fab565f7a231de41391f97ea313907275674cbe196c243c292d6957dc9ca1332`, resend callback `ev_fcfef9f6ffaa17d17c6abfd5458f6f5737c27220c72ebefbf115a18824e0b6fa`.

The native shared auth builder always supplies the constant `appHashType: ANDROID`; the older request-verification-code implementation supplies the same literal alongside phoneNumber, otpMethod and workFlow. These call paths serialize a client configuration value without generating a signed attestation. A client/SMS-format selector is the supported interpretation; its precise backend meaning and delivery dependency remain unverified. Builder Evidence: `ev_eff9741b1ea5f488ccb717a98a3f8ee75c3c80b5cbd52f345322f65b6cf58620`; older verification-code request: `ev_6e1d04205d7401a8c1c04225977193c8a12da1c8165673e492fea2df84a31e40`.

`nextStepConfig.smsOtp` contains phoneNumber, fallbackChallenges and optional copy. It has no sent or delivered marker, receipt, message ID or send timestamp. HTTP 200 and `code_required` therefore establish the next protocol step, not SMS dispatch or receipt. DTO Evidence: `ev_c6de4d0f54896b9f09b7f1e99fd154c8f0c8df703449cfd74d63f053986687d1`.

## Airlock verification

The shipped `POST /v2/phone_one_time_passwords` uses `workFlow: GLOBAL_SIGNUP_LOGIN`, the full international phoneNumber, `otpMethod: AUTO`, and `appHashType: ANDROID`. It can return HTTP 420 with `CAPTCHA_FLOW` and `ARKOSE_BOT_DETECTION`. Completing Airbnb's standalone Airlock page did not by itself enable this request in an earlier test. The working flow submits the genuine widget result to the exact pending native Airlock and checks its replay authorization.

`src/airlock-protocol.mjs` models the native handoff: submit the full genuine Arkose token with `AirlockArkoseBotDetectionSubmitToken`, then check `/v2/airlocks/{internalAirlockId}` for status 2 and `should_replay_request: true`. Native retries carry `x-airbnb-replay-airlock-id`; initial requests advertise `X-Airbnb-Supports-Airlock-V2: true`. The GraphQL ID is opaque and distinct from the signed decimal internal ID. A successful page load or widget completion alone does not authorize a retry. No booking/payment retry is connected to this module.

The CLI returns a temporary HTTPS link whose page contains the official Arkose widget. The capability lives in the URL fragment. Its relay validates source/origin, public key, expiry and one-shot consumption. The user completes any challenge in their own browser; no browser is started on the Orin. A durable journal reserves token submission and the one protected replay before either POST. Unknown outcomes are not replayed. The relay and its owned tunnel stop after completion or expiry.

The replayed gateway response acknowledged `success: true`, `deliveryMethod: TEXT`, and `codeLength: 6` in the verified run. The code was then submitted to the modern `/v2/auth/authenticate/sms_otp` endpoint with its original accumulated steps and auth session, rather than the older `/v2/authentications` endpoint. Both the browser verification and OTP remain genuine server-issued values.

Native token variable serialization: `ev_8b50356940ea766e4a72a755c46b426884f21460a2c4226172e58c389cfbe7f7`. Replay interceptor: `ev_41b6e8e62d42b68178838a6b69eaeec8764780ace7ccdf51bef051e845fb7887`.

## Wire compatibility fixes

The `Authentication` DTO's identity field is `userId_str`; internal CLI state uses `userId`. A response without that required string cannot become a validated session. The normal native `AuthFlowArgs(entrypoint, null)` path serializes `X-Airbnb-Flex-Auth-Options` as the four-character JSON literal `null`. An empty object is not the same header value. The recovered `/login` handler explicitly uses the `Other` entrypoint. The successful fresh installed flow includes these corrections. Earlier tests without retained raw responses do not establish whether a token was issued or discarded.

## Native device assignment

`bootstrap.mjs` reproduces the separate startup `POST /v2/client_configs` with empty `configs`/`trebuchet_keys` and `deviceAssignmentsToRequest: [{deviceAssignmentType: 'STRICTLY_NECESSARY', deviceType: 'ANDROID'}]`. The native response observer selects the matching `device_assignments` entry, saves its `device_id` and absolute `expire_at_epoch_second`, then the shared provider sends that ID as `X-Airbnb-Everest-Device-Id`. This is a genuine server-issued assignment, distinct from the locally generated installation ID and from ordinary API response cookies.

The CLI persists and reuses the assignment until its server expiry, serializing concurrent first-run registration. Failure stops before submitting an OTP request. A live request from the Orin returned the matching assignment on 2026-10-20. The corrected retry still required Airlock verification; registration alone did not establish SMS delivery.

REA actual bootstrap dispatch: `ev_a7c259691fc0f7d8a5e1dbd960103dcd7b6a4af18afaca8b8300517bf5c6890f`. Response observer: `ev_96ad3ae6b490b97805f1ecac867cf9e0ae67847b5144d19bfa8096bc0b82c1a5`. Assignment JSON adapter: `ev_9136ab321f14c6b813a6b503f6ec1c1c4122283739326158d15bd7f5f0b8fa77`. The app's `everest_cookie` conversion is specific to its WebView; the CLI does not copy a browser cookie jar.
