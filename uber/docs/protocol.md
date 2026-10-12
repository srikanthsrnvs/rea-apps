# Recovered protocol and validation

Source: Uber rider Android 4.651.10003, base APK SHA256 `2a92686a421d1d37bd16d287869ac9dbc5c71f36a6b0793b187f0a2bc1c24a91`. Analysis used REA/JADX. The APK, full evidence and live sessions are private local artifacts excluded from packages, Docker builds and Git.

| Capability | Recovered contract | Runtime observation |
| --- | --- | --- |
| Login | PKCE approval at auth.uber.com, allowed native HTTPS callback, `/rt/silk-screen/submit-form` exchange | Browser approval succeeded; Node exchange returned OAuth access and refresh tokens |
| OAuth refresh | `/rt/identity/oauth2/token`, `request.clientID`, refreshToken, REFRESH_TOKEN | Succeeded on macOS and Linux ARM64 |
| Integrity | `/rt/devices/exemption`, `request.token` and `request.exemptToken`; response token and Unix-seconds metadata.expiry | Server issued a nonempty exemption; x-uber-cit resolved shopping's Uber-CIT-Sig challenge |
| Shopping | `/rt/shopping-service/order_selection/`, coordinate waypoint specs | HTTP 200, 22 ride options on the sample San Francisco route |
| Fare estimate | `/rt/riders/me/fare-estimate`, pickupLocation, destination, vehicleViewIds, optional viaLocations | HTTP 200, real USD prices in packageVariants; 27 price variants on the sample route |
| Trip status | `/rt/riders/me/status`, direct optional-field request | HTTP 200, clientStatus and empty active-order list |
| Location resolution | `/rt/riders/me/resolve-location`, direct requestLocation with source `Search` | HTTP 200, resolved coordinates for the selected airport |
| Address search | `/rt/pudo-presentation-helix/text-search`, wrapped query, Point and context | HTTP 200, named places and location IDs |
| Cancellation preview | POST `/rt/trips/{tripUUID}/cancellation-info`, direct optional-field request; explicit `chargeFee` decision | HTTP 200, explicit fee-free preview; synthetic tests verify changed terms block cancellation |
| Cancellation | POST `/rt/trips/{tripUUID}/rider-cancel`, direct reason, optional refundStrategy, fulfillmentOrderId `{uuid}`, cancellationInput `{comment}` | HTTP 200, cancellation receipt confirming no ride charge and hold removed; final status ClientCanceled, zero active orders |
| Saved payment methods | GET `/rt/payment/v3/payment-profiles` (POST at this path creates a profile) | HTTP 200; masked summaries omit billing and token data |
| Personal profile | POST `/rt/profiles/v2/get-profiles`, `{request:{userUuid}}` | HTTP 200; RIDER default payment resolves to a saved method |
| Booking | POST `/rt/riders/{riderUUID}/v2/pickup`, direct PickupRequestV2 with native ClientRequestLocation wrappers, paymentProfileUUID, profileUUID/profileType, full upfrontFare, jobUUID | HTTP 200, concrete trip UUID matching requested jobUUID, Dispatching state, actual fare matching signed quote, no additional checkout required |

Key retained evidence IDs:

- Coordinate and pickup semantics: `ev_198b636fc87310483003a393ad586194fb9e3dbaf5f51f3a43c79fec45fb9b82`; scalar writer `ev_e00e3047cd2e2f02167938aa7e7c90e0cdf1971d2762b8a89ada122f67697f9c`.
- Native 401 + Uber-CIT-Sig classification: `ev_4333b4f8ad00be8c9ca37b7551fe3f1ea7890b08be099937ffb885347bfa687d`.
- Exemption request construction: `ev_553a920dd52ed641e9a5f5064410ca2b14c8a05f3bfec39953bcd21e04206ed1`; credential handling `ev_e91c52fa805d1c42febe303e3316c4d5c3413644f3e4a28e9190141de9b645d7`.
- Fare request Gson keys: `ev_be52e3819e2f2d203958041bfe14a1844af244d5dc3b5dcac8fbc4fcbe462237`; Location writer `ev_64dd2030d9636ba1c1747a71d9316857e6c0f4d0b5e9ac155b070f0e6aee76ea`.
- Status API: `ev_9d6a6e2a63bb35577527fc984632daa4a4e0591aa3cfb1dab08da67b1fd7e0e1`; all-null default request `ev_e685f33ed16a722e0f64f5f9d33c4d9900afc6715ea4e2a4507b06c1c68604a5`.
- Text search wrapper: `ev_e77a7ba02841e8090dfffb432608462eb44f71bb567032e23a457d59994018bc`.

Static evidence establishes client behavior and field encoding; live HTTP responses establish backend acceptance for this account at the time tested. Exemption eligibility and future protocol compatibility remain server controlled.

The standard native signing path uses EC AndroidKeyStore certificate attestation. This CLI uses the server's exemption path instead. No private hardware key was exported and no certificates were fabricated. One explicitly authorized ride was booked and cancelled to verify these endpoints.

Prices are preserved as decimal strings and display text. Product matching uses numeric legacy vehicle view IDs; all variants and unmatched variants remain available in the summary. An estimated trip time describes the journey and is not a pickup ETA. Unsupported response shapes fail explicitly rather than producing invented quotes.

Booking and cancellation transport records an operation before sending and never automatically retries a mutation. A failed connection, server error, unrecognized success response, or failure to persist the result leaves the outcome uncertain. The same operation cannot be sent again; query trip status and inspect the saved operation. HTTP validation/authentication rejections are recorded separately. Server deduplication has not been assumed.

Cancellation uses a private plan bound to the signed-in rider. Confirmation fetches the cancellation preview again and refuses changed terms. A missing fee decision blocks confirmation. Numerical fee amounts are not inferred from presentation strings. Modern rider order IDs are separate from transport job IDs: native `JobProviderRAO` and `JobProviderTrip` establish that the transport job ID is the backwards-compatible trip ID for cancellation.

Cancellation evidence: modern JobProvider constructor `ev_eb427d0e01ff212e6223699713f4ed4efffb381851c296a2efa812d6ffa73e85`; legacy constructor `ev_d0b5ed589a0100f71e2b1d4377e0bb7d6c2aad233dd259a646bbf8f5f405f55c`; legacy Trip UUID getter `ev_ec447ffedc325c6ec6b371e8c540092a76a569f5efd51f5a2719c5ee6594cc65`; fulfillment ID adapter `ev_7438c9f0f7e200b3b11ea0b90381a032b8ad76e9affffb9ab59f3d53946fc789`.

Booking source evidence: native constructor `ev_d0ee6104fcd7be144a699d9f5dbca3bad1ab89d8b295b413e3c92238add88fa2`; pickup writer `ev_4b37f293179f4f41e067e3d2227e83a7d41b0f7a02636d66529b43950c43bfcb`; location conversion `ev_74fc588c30b3080533ecbeb00841dc0f8ac78d875ed5e6c5050e0bef240660f4`; generated trip ID setter `ev_9730ccb3fa39428b9c1c6016e9fdc0f674d5d03c46ab00ddbcf5da01458a3952`. Native assembly supplies null timestamp, transactionId and paymentProfileId, so the CLI omits them. Legacy profile type serializes as `Personal`; modern participant type is `PERSONAL`.

Modern order creation binds a shoppingOrderPlanID, not the legacy signed fare directly. Including real payer/consumer context in read-only modern shopping still returned products without prices for this account. The CLI therefore uses the native legacy pickup request that carries the complete signed upfrontFare. It does not claim an unbound catalog estimate caps modern order creation. Draft-order creation was recovered statically but not submitted; its financial/dispatch semantics were not established sufficiently for a live probe.

End-to-end Linux ARM64 validation: search → resolve → quote → book → cancellation preview → cancel → trip status completed using only HTTP and persisted credentials. Both mutations returned HTTP 200 and were recorded as accepted. All 51 tests passed on macOS and Linux. Docker named-volume locking excluded a simultaneous container and released correctly when its holder was killed. Live mutation acceptance is established for the tested account and quoted trip, not every product, payment challenge or account.
