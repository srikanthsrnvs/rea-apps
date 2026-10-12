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

Key retained evidence IDs:

- Coordinate and pickup semantics: `ev_198b636fc87310483003a393ad586194fb9e3dbaf5f51f3a43c79fec45fb9b82`; scalar writer `ev_e00e3047cd2e2f02167938aa7e7c90e0cdf1971d2762b8a89ada122f67697f9c`.
- Native 401 + Uber-CIT-Sig classification: `ev_4333b4f8ad00be8c9ca37b7551fe3f1ea7890b08be099937ffb885347bfa687d`.
- Exemption request construction: `ev_553a920dd52ed641e9a5f5064410ca2b14c8a05f3bfec39953bcd21e04206ed1`; credential handling `ev_e91c52fa805d1c42febe303e3316c4d5c3413644f3e4a28e9190141de9b645d7`.
- Fare request Gson keys: `ev_be52e3819e2f2d203958041bfe14a1844af244d5dc3b5dcac8fbc4fcbe462237`; Location writer `ev_64dd2030d9636ba1c1747a71d9316857e6c0f4d0b5e9ac155b070f0e6aee76ea`.
- Status API: `ev_9d6a6e2a63bb35577527fc984632daa4a4e0591aa3cfb1dab08da67b1fd7e0e1`; all-null default request `ev_e685f33ed16a722e0f64f5f9d33c4d9900afc6715ea4e2a4507b06c1c68604a5`.
- Text search wrapper: `ev_e77a7ba02841e8090dfffb432608462eb44f71bb567032e23a457d59994018bc`.

Static evidence establishes client behavior and field encoding; live HTTP responses establish backend acceptance for this account at the time tested. Exemption eligibility and future protocol compatibility remain server controlled.

The standard native signing path uses EC AndroidKeyStore certificate attestation. This CLI uses the server's exemption path instead. No private hardware key was exported, no certificates were fabricated and no ride or payment action was performed.

Prices are preserved as decimal strings and display text. Product matching uses numeric legacy vehicle view IDs; all variants and unmatched variants remain available in the summary. An estimated trip time describes the journey and is not a pickup ETA. Unsupported response shapes fail explicitly rather than producing invented quotes.

End-to-end Linux ARM64 validation: search → resolve → quote → trip status completed using only HTTP and persisted credentials. The airport route returned 19 products and 23 fare variants. All 25 tests passed on macOS and Linux. Docker named-volume locking excluded a simultaneous container and released correctly when its holder was killed.
