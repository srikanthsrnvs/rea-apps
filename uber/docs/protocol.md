# Recovered protocol and validation

Sources: Uber rider Android 4.651.10003, base APK SHA256 `2a92686a421d1d37bd16d287869ac9dbc5c71f36a6b0793b187f0a2bc1c24a91`, and Uber's current official authentication frontend. Native analysis used REA/JADX. The APK, full evidence and live sessions are private local artifacts excluded from packages, Docker builds and Git.

| Capability              | Recovered contract                                                                                                                                                                 | Runtime observation                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verification-code login | `/rt/silk-screen/submit-form` initial session, server-selected challenges, `/rt/silk-screen/prepare-field` code delivery, PKCE session exchange                                    | Native ARM64 Linux completed SMS → email → session verification → OAuth; account identity matched the existing session; refresh and trip status succeeded |
| Manual browser recovery | `login-url` approval at auth.uber.com, supported native callback, `/rt/silk-screen/submit-form` exchange                                                                           | Previous manual callback exchange returned OAuth credentials; arbitrary callback URLs are discarded by Uber's allowlists                                  |
| OAuth refresh           | `/rt/identity/oauth2/token`, `request.clientID`, refreshToken, REFRESH_TOKEN                                                                                                       | Succeeded on macOS and Linux ARM64                                                                                                                        |
| Integrity               | `/rt/devices/exemption`, `request.token` and `request.exemptToken`; response token and Unix-seconds metadata.expiry                                                                | Server issued a nonempty exemption; x-uber-cit resolved shopping's Uber-CIT-Sig challenge                                                                 |
| Shopping                | `/rt/shopping-service/order_selection/`, coordinate waypoint specs                                                                                                                 | HTTP 200, 22 ride options on the sample San Francisco route                                                                                               |
| Fare estimate           | `/rt/riders/me/fare-estimate`, pickupLocation, destination, vehicleViewIds, optional viaLocations                                                                                  | HTTP 200, real USD prices in packageVariants; 27 price variants on the sample route                                                                       |
| Trip status             | `/rt/riders/me/status`, direct optional-field request                                                                                                                              | HTTP 200, clientStatus and empty active-order list                                                                                                        |
| Location resolution     | `/rt/riders/me/resolve-location`, direct requestLocation with source `Search`                                                                                                      | HTTP 200, resolved coordinates for the selected airport                                                                                                   |
| Address search          | `/rt/pudo-presentation-helix/text-search`, wrapped query, Point and context                                                                                                        | HTTP 200, named places and location IDs                                                                                                                   |
| Cancellation preview    | POST `/rt/trips/{tripUUID}/cancellation-info`, direct optional-field request; explicit `chargeFee` decision                                                                        | HTTP 200, explicit fee-free preview; synthetic tests verify changed terms block cancellation                                                              |
| Cancellation            | POST `/rt/trips/{tripUUID}/rider-cancel`, direct reason, optional refundStrategy, fulfillmentOrderId `{uuid}`, cancellationInput `{comment}`                                       | HTTP 200, cancellation receipt confirming no ride charge and hold removed; final status ClientCanceled, zero active orders                                |
| Saved payment methods   | GET `/rt/payment/v3/payment-profiles` (POST at this path creates a profile)                                                                                                        | HTTP 200; masked summaries omit billing and token data                                                                                                    |
| Personal profile        | POST `/rt/profiles/v2/get-profiles`, `{request:{userUuid}}`                                                                                                                        | HTTP 200; RIDER default payment resolves to a saved method                                                                                                |
| Booking                 | POST `/rt/riders/{riderUUID}/v2/pickup`, direct PickupRequestV2 with native ClientRequestLocation wrappers, paymentProfileUUID, profileUUID/profileType, full upfrontFare, jobUUID | HTTP 200, concrete trip UUID matching requested jobUUID, Dispatching state, actual fare matching signed quote, no additional checkout required            |

Key retained evidence IDs:

- Coordinate and pickup semantics: `ev_198b636fc87310483003a393ad586194fb9e3dbaf5f51f3a43c79fec45fb9b82`; scalar writer `ev_e00e3047cd2e2f02167938aa7e7c90e0cdf1971d2762b8a89ada122f67697f9c`.
- Native 401 + Uber-CIT-Sig classification: `ev_4333b4f8ad00be8c9ca37b7551fe3f1ea7890b08be099937ffb885347bfa687d`.
- Exemption request construction: `ev_553a920dd52ed641e9a5f5064410ca2b14c8a05f3bfec39953bcd21e04206ed1`; credential handling `ev_e91c52fa805d1c42febe303e3316c4d5c3413644f3e4a28e9190141de9b645d7`.
- Fare request Gson keys: `ev_be52e3819e2f2d203958041bfe14a1844af244d5dc3b5dcac8fbc4fcbe462237`; Location writer `ev_64dd2030d9636ba1c1747a71d9316857e6c0f4d0b5e9ac155b070f0e6aee76ea`.
- Status API: `ev_9d6a6e2a63bb35577527fc984632daa4a4e0591aa3cfb1dab08da67b1fd7e0e1`; all-null default request `ev_e685f33ed16a722e0f64f5f9d33c4d9900afc6715ea4e2a4507b06c1c68604a5`.
- Text search wrapper: `ev_e77a7ba02841e8090dfffb432608462eb44f71bb567032e23a457d59994018bc`.

Static evidence establishes client behavior and field encoding; live HTTP responses establish backend acceptance for this account at the time tested. Exemption eligibility and future protocol compatibility remain server controlled.

## Verification code authentication

`uber login --phone NUMBER [--country-code CODE]` starts a private login operation. It returns `loginId`, a `waiting_for_code` status, and `challenge` fields `id`, `channel`, masked `contact`, and `codeLength`. `uber auth complete --login-id ID --challenge-id ID --code CODE` answers the current challenge and may return another one chosen by Uber. Forward the current `challenge.id` on every completion; later steps return a new challenge ID. `auth poll --login-id ID` inspects the operation; `auth cancel --login-id ID` stops it locally. `auth status` includes the pending `login` summary.

`--code-file FILE` reads the code from a file instead of a command argument; an interactive terminal can omit both code options to prompt for it. If OAuth exchange succeeds but validation is interrupted, `auth validate --login-id ID` validates the retained candidate without repeating verification or exchange. The prior authenticated session remains until validation succeeds.

The initial request wraps `formContainerAnswer` with an empty initial session and a form answer using flow `INITIAL`, screen `PHONE_NUMBER_INITIAL`, and event `TypeInputMobile`. Its field answers use `phoneCountryCode` and `phoneNumber` strings. The accepted initial request also includes `standardFlow`, empty-string `deviceData`, the PKCE `codeChallenge`, `uslURL`, `authDomain`, and `appContext` with an allowed Uber app return URL and `isChromeCustomTabSession: false`. Metadata belongs to the initial contract; the field serializers alone do not define a valid login request.

The server's primary form can be social login while SMS is offered as an alternate. Selecting its returned `PHONE_OTP` form requires preparing the field before asking for a code. The official frontend emits:

```json
{
  "request": {
    "flowType": "SIGN_IN",
    "inAuthSessionID": "SERVER_SESSION",
    "eventType": "TypeSMSOTP",
    "fieldType": "PHONE_SMS_OTP"
  }
}
```

This JSON is sent to `/rt/silk-screen/prepare-field`; `flowType` and event come from the selected returned form. It requests delivery rather than submitting an empty OTP answer. The response supplies `success` and `formContainer.form`. Verification uses `/rt/silk-screen/submit-form` with the current session, selected screen/event, and the corresponding code field. Email verification and any additional server-selected challenges continue the same login operation.

After the final challenge, the returned `SESSION_VERIFICATION_CODE` supplies the auth code. The CLI submits `SESSION_VERIFICATION` / `TypeVerifySession`, retaining `inAuthSessionID` and sending that code with its locally generated `CODE_VERIFIER`. The response supplies the authenticated account and OAuth credentials. Refresh continues through `/rt/identity/oauth2/token`.

Primary frontend sources: [current main bundle](https://auth.uber.com/v2/_static/client-main-b21c2eb7aef3e4cc.js), [challenge selection and preparation](https://auth.uber.com/v2/_static/client-5734-0e6f3164154cdf0b.js), and [phone OTP component](https://auth.uber.com/v2/_static/client-otp-a48152c8a5fefed3.js). Current main SHA256 is `5d5bcad9209dacb95fde5254584a6fb112b76af85791c98cb33a4d74b7fe26a9`. Main module36122 builds the initial form; chunk5734 module73843 selects an alternate and module49106 builds its prepare request. Native session exchange is retained in evidence `ev_98c466e38b69069239050056a97ff470b7e27b5ea4246e94d08266a6c43a246d`.

Code delivery and submission are persisted before sending. Each prepared challenge has a local ID bound to its login and step. Completion rejects a stale ID before sending, so concurrent submissions of an SMS code cannot answer a later email challenge. Each delivery is sent once; uncertain transport outcomes are not automatically replayed. Poll the saved login and resolve its state rather than starting another request blindly. Tokens, verifiers, session codes and full authentication responses stay in private local state.

The live native Linux protocol pilot on 2026-10-14 completed SMS, email, session verification, PKCE exchange, OAuth refresh and trip status for the expected account using HTTP only. No browser, Android device or Cloudflare tunnel participated in these steps. Captured responses were replayed through the production authentication module; the production CLI separately validated the already exchanged live candidate with `auth validate`. All 89 automated tests passed on macOS and Linux ARM64, with 49 focused checks passing in a Node 22 Linux container.

## Manual browser recovery

`uber login-url` preserves the previous browser approval route. `uber auth complete --callback-url URL` requires manually supplying a completed supported callback bound to the retained PKCE verifier. It does not provide automatic browser-to-host delivery.

Uber's hydrated `appURLAllowlist` and `pkceAppURLAllowlist` discard arbitrary callback destinations. Completion uses `pkceAppNextURL` only for event `TypeVerifyWebPKCESession`; other native completions use an allowed `appNextURL` or a fixed app scheme. On Android-classified sessions, the Continue button can convert an HTTPS return into `uberlogin://`. A custom HTTPS relay therefore does not establish automatic callback delivery. The verification-code flow uses the native session response directly.

## Ride requests and validation

The standard native signing path uses EC AndroidKeyStore certificate attestation. This CLI uses the server's exemption path instead. No private hardware key was exported and no certificates were fabricated. One explicitly authorized ride was booked and cancelled to verify these endpoints.

Prices are preserved as decimal strings and display text. Product matching uses numeric legacy vehicle view IDs; all variants and unmatched variants remain available in the summary. An estimated trip time describes the journey and is not a pickup ETA. Unsupported response shapes fail explicitly rather than producing invented quotes.

Booking and cancellation transport records an operation before sending and never automatically retries a mutation. A failed connection, server error, unrecognized success response, or failure to persist the result leaves the outcome uncertain. The same operation cannot be sent again; query trip status and inspect the saved operation. HTTP validation/authentication rejections are recorded separately. Server deduplication has not been assumed.

Cancellation uses a private plan bound to the signed-in rider. Confirmation fetches the cancellation preview again and refuses changed terms. A missing fee decision blocks confirmation. Numerical fee amounts are not inferred from presentation strings. Modern rider order IDs are separate from transport job IDs: native `JobProviderRAO` and `JobProviderTrip` establish that the transport job ID is the backwards-compatible trip ID for cancellation.

Cancellation evidence: modern JobProvider constructor `ev_eb427d0e01ff212e6223699713f4ed4efffb381851c296a2efa812d6ffa73e85`; legacy constructor `ev_d0b5ed589a0100f71e2b1d4377e0bb7d6c2aad233dd259a646bbf8f5f405f55c`; legacy Trip UUID getter `ev_ec447ffedc325c6ec6b371e8c540092a76a569f5efd51f5a2719c5ee6594cc65`; fulfillment ID adapter `ev_7438c9f0f7e200b3b11ea0b90381a032b8ad76e9affffb9ab59f3d53946fc789`.

Booking source evidence: native constructor `ev_d0ee6104fcd7be144a699d9f5dbca3bad1ab89d8b295b413e3c92238add88fa2`; pickup writer `ev_4b37f293179f4f41e067e3d2227e83a7d41b0f7a02636d66529b43950c43bfcb`; location conversion `ev_74fc588c30b3080533ecbeb00841dc0f8ac78d875ed5e6c5050e0bef240660f4`; generated trip ID setter `ev_9730ccb3fa39428b9c1c6016e9fdc0f674d5d03c46ab00ddbcf5da01458a3952`. Native assembly supplies null timestamp, transactionId and paymentProfileId, so the CLI omits them. Legacy profile type serializes as `Personal`; modern participant type is `PERSONAL`.

Modern order creation binds a shoppingOrderPlanID, not the legacy signed fare directly. Including real payer/consumer context in read-only modern shopping still returned products without prices for this account. The CLI therefore uses the native legacy pickup request that carries the complete signed upfrontFare. It does not claim an unbound catalog estimate caps modern order creation. Draft-order creation was recovered statically but not submitted; its financial/dispatch semantics were not established sufficiently for a live probe.

Previous end-to-end Linux ARM64 validation completed search → resolve → quote → book → cancellation preview → cancel → trip status using only HTTP and persisted credentials. Both mutations returned HTTP 200 and were recorded as accepted; the previous 51 tests passed on macOS and Linux. Docker named-volume locking excluded a simultaneous container and released correctly when its holder was killed. Live mutation acceptance is established for the tested account and quoted trip, not every product, payment challenge or account.
