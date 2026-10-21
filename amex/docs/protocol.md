# Amex protocol investigation

## Artifact and evidence

REA inspected `com.americanexpress.android.acctsvcs.us` 7.34.1 (162662), pulled
from the user's Android device. Base APK SHA-256:
`4c5d7e757e9588e538abdf040ce8c3705c46d143863c7a7a704199b7c8a73765`.
REA evidence records, exact source slices, APK splits, supplemental DEX annotation
disassembly and response captures are stored outside the repository. Supplemental
Baksmali/resource facts are labeled separately from REA-generated evidence.

Selected REA records:

| Finding | Source | REA Evidence ID |
| --- | --- | --- |
| Production environment host | `qm1.<clinit>` | `ev_434c9675f268f7cac9dd2ce2eee39cd6a957a83afe8eec22c6f58572b6c4e030` |
| Generic endpoint construction | `km1.b` | `ev_a3a1eebd3d2c64bbeb75a0fff1989b2714ffffeb85c49caf9617f71f176c7eac` |
| Common native headers | `n73.intercept` | `ev_fb2b54a45dd14f4d9e9aa940b40b5573c44e21045ac1dd3969d565a11b003ce1` |
| Independent AMAT/Gatekeeper headers | `g9h.a` | `ev_5791de7b460b39cae1d27e811f0ea4fc30627e0b726e4580a3e27b9f0a067cf8` |
| Password fields | `UserIdLoginJsonAdapter.toJson` | `ev_bd5d3a6b0b68d53df03bb03cab4e7346aa4b4ed222dcbc6f8a94f94466815247` |
| Streaming request wrapper | `LoginSummaryTimeline_PostRequestJsonAdapter.toJson` | `ev_74dc61bdc5be44d32ee862a63ec383b131b9cb8e51577a0c5d48e8042ece42dc` |
| Login response classification | `LoginRepository.A0` | `ev_bc0b05984cc9e59cbcaedbd7404cfc1d983b8d23020328bec59b6e70b5ceb23f` |
| LOGIN is a direct response, not a nested wrapper | `LoginTimelineStreamingResponseAdapter.a` | `ev_fbb5898d45d05fd69e5c10db78f9654a617d2dbb655e2e9b39f5cca68269d1b0` |

## Transport

The packaged generic production base is
`https://mobileone.americanexpress.com/mobileone/msl/`. The historical
`/myca/moblclient/us/` client and PCI-DSS client are distinct bindings, not fallback
hosts to try after a financial error. Only source-bound service routes are used.
The client pins origin/path, rejects redirects, bounds response size/time, and
never retries a request automatically.

On 2026-10-21, anonymous initialization from the Orin returned HTTP 500 when the
`x-axp-os` value was Linux. Repeating the same public initialization request with
only that value changed to the app's literal `Android` returned HTTP 200 and the
native initialization configuration. It acts as a protocol selector. The CLI
keeps a truthful Node/Linux User-Agent, host/kernel metadata and its own generated
installation ID; it neither runs Android nor claims an integrity check succeeded.
That test establishes anonymous protocol routing only, not login acceptance.

Native session authorization is `AMAT <raw JWT>`, not Bearer. Genuine Gatekeeper,
cupcake and additional headers are applied independently when returned. Tokens
are never synthesized. `x-axp-business-layer-status: FAIL` is a failure even with
HTTP 200. The native session interceptor converts exact
`x-axp-session-expired: true` or `x-axp-jwt-expired: true` into HTTP 401 and discards
the body; the CLI applies the same rule before parsing apparent success.
No universal HMAC/request signature was observed in the bounded common
interceptor analysis; this does not establish that feature-specific risk checks
are absent.

## Login

The current app posts `{login, timeline}` to
`services/accountservicing/streaming/v1/loginsummarytimeline`. The CLI uses an
incremental bounded SSE decoder, selects the first `LOGIN` event, and closes the
stream without waiting for `TIMELINE`. Malformed/closed streams never authenticate
and never reconnect or repeat the password request.

Login contains `loginCredentials.userIdLogin` with userId/password and
`rememberMeFlag:false`. The CLI does not enroll a trusted device. Timeline uses
the real local time/timezone and reports unsupported biometrics as `NotCapable`.
Optional Agent/Wallet/device proofs are not invented.

A JWT in a partial MFA result is insufficient. The migrated native step-up
requests v3 challenge options using action `MFAOI01` and journey
`aexp.global:create:session`. Only an offered SMS/email/voice OTP is implemented;
encrypted destination fields remain private and unchanged. Each genuine returned
JWT replaces the previous partial token. Pending further checks remain
`action_required`. A successful full login or MFA completion must also pass an
independent authenticated account-summary read before replacing the saved session.

Session transfer consumes an existing transfer code in the app. No fresh official
browser-login issuer was established, so the CLI does not advertise an approval
link or phone-number-only login. Risk/integrity requirements, server-offered MFA
branch and session expiry behavior still require account integration testing.

## Validation boundary

The test suite uses synthetic responses and injected offline transports for
protocol, pagination, login state transitions and financial journals. It does not
submit a password, request a real OTP or move funds. Anonymous initialization was
verified on the headless Orin. Live account login, balances, transactions, payment
inquiry, final payment and cancellation have not yet been established. A payment
request accepted by a native endpoint would still not prove settlement.
