# Expedia protocol audit, October 17, 2026

Fresh CLI login succeeded twice on the Orin, including through the installed
CLI. Native protocol calls use Node HTTP and a source-ported Linux Trust
collector. The user completes official Arkose verification in their own Safari
and supplies Expedia's email code. A temporary callback tunnel runs only during
verification; no Chrome, WebView, Android runtime or remote screen runs on the
Orin. `expedia capabilities` distinguishes verified login from unverified paid
booking support.

The target is Android `com.expedia.bookings` 2026.41.0, base APK SHA-256
`dfd7bbfdf10976740cbf7b4a74e359358871479766d0705d1e9b5ff633a7700f`.
REA confirmed the connected Pixel's installed version again:
`ev_9daa5edd1447c249087ecdf9404559420651be0b841bd08ca6101d59084eb526`.
Package inspection does not verify the installed signature or byte-for-byte
identity with the retained APK.

## Fresh runtime observations

| Question | Observation | Coverage |
| --- | --- | --- |
| Does the saved Orin session work? | `auth refresh` succeeded over HTTP with no Expedia container running. One command took 0.86 seconds and about 94.5 MiB peak child RSS. | Answered for this saved session, not fresh login. |
| Can HTTP start login? | A new anonymous `IdentityLayoutQuery` returned email Continue with CSRF only. | Form retrieval and one email submission observed. |
| What follows email submission? | `EMAIL_OTP` migration, then a six-digit email-code form. One explicit resend returned a success response and reference ID. | A form load alone does not prove email delivery. |
| Is a code sufficient? | Its Continue action requires CSRF, Trust and Arkose results together. The corrected flow supplied all three and the email code. | Fresh session and independent account refresh verified twice. |
| Is password different? | Loading its form works; password verification requires the same three providers. | No password supplied. |
| Is passkey login usable? | Challenge/completion contracts recovered; tested challenge requests returned `PasskeyAuthChallengeNoActionResponse`. | Partial; no assertion or registration submitted. |
| Does newer `initialAuthForm` help? | It returned a downstream collection-predicate exception, including with `INITIAL_AUTH` and explicit capability fields. | Negative for these inputs, not universal absence. |
| Must flights wait for login? | Anonymous search, selection, price summary, checkout preparation and session validation succeeded. | See [flight audit](flight-audit.md); no payment or purchase. |

Raw payloads, cookies, SDK assets and account details remain in private evidence
outside Git. Public GraphQL documents are shipped constants with provenance.

## Email and password

The observed native sequence is:

```text
IdentityLayoutQuery
  → identityFormSubmit(email + server CSRF)
  → EMAIL_OTP migration
  → identityAuthenticateByOTPForm
  → identityVerifyOTPAuthenticationSubmit(code + CSRF + Trust + Arkose)
```

The standalone client completed this sequence. Email submission alone contains
neither an authenticated profile nor a session. The verified flow additionally
uses the native resend action to obtain an acknowledged delivery and reference,
then carries that reference into verification. Resend's CSRF-only requirement
does not waive verification's other providers. Password verification has the
same gate and has not been exercised with a password.

The password form document is retained at
`src/graphql/auth/identityAuthenticateByPasswordForm.graphql`, hash
`7347dc3c937fe1261f31c03c275b5e2ff650f1323802b610611c0181045f6f82`.
It was decoded from `t10.k$a.a`; REA class/companion inventories:
`ev_ed87d4962e12945b8cb8a450d8c1ce2b4d144a79f2b2443568b3477cb2b30df6`,
`ev_eb7447d6a32478a1053637cf96501c8b6478bb3f8b2e6b78c160115a8915c1b4`.
The exact REA document body is retained in
`ev_9bf147586b8dc6e22aec70d8de289660f67094251d597dd028c8067a23fc55f0`.

Packaged `ArkoseLabsAPI.html` uses a JavaScript enforcement API, completion/error
callbacks, an Android bridge and client data requests. The older
`arkose/protect.html` also renders enforcement through JavaScript. A native
wrapper does not establish a browser-free provider. The earlier
[dependency audit](native-login-requirements.md) distinguishes Android API
dependencies from an unproven physical-hardware requirement.

Subsequent private experiments captured a genuine `challenge-suppressed`
completion from Arkose's official hosted iframe in the user's Safari. A small
Node relay received that completion; no browser ran on the Orin. A blank widget
with a completed callback is distinct from an authenticated Expedia session.

The native Trust envelope and inner vendor codec were also recovered and
cross-decoded against an independent Java implementation. A private Node port
collects actual Linux measurements and identifies itself as a Linux CLI;
unavailable Android measurements are not invented. Codec correctness does not
establish that Expedia accepts those measurements. An attempt combining this
payload, genuine browser verification and a supplied email code returned a
generic failure. Code freshness and request differences prevent attributing
that response specifically to Trust or Arkose.

An exact OTP lifecycle trace found that legacy `EMAIL_OTP` entry loads the code
form directly, without a separate send mutation. Initial `referenceId` may be
absent. Explicit send/resend success can supply it. Native `ConfirmEmailVM.Y5`
omits `authenticationFlowVariant` even when the action contains it; the HTTP
builder now follows that behavior. Source evidence:
`ev_e1b0277703f3bb6201de9bdab59b851bca4ebec42228f8fe2cecfa3432807d52`,
`ev_477c9b9bc2bdfabac392d4dc74fab738697b530f835ee38dc19cb994c2889144`.
Fresh verification with the explicit resend receipt succeeded, both in the
private prototype and through `expedia login` / `expedia auth code`. Each new
session passed a separate `identityRefresh` and account-email comparison before
being saved. The successful flow includes both the wire correction and the
resend reference; these combined tests do not isolate which change explains the
earlier generic failures.

## Passkeys

Two recovered shipped documents are now retained with class and hash provenance:

| Operation | SHA-256 |
| --- | --- |
| `passkeyAuthChallenge` | `a12982d551cb552b96deb3c24224ce83a0d1a8b93b03c900d4f2ebe2dfc077b3` |
| `identityCompletePasskeyAuthenticationSubmit` | `cb8235119ead6ec5d8c0d0be80cc39c21105c39030f2a5d6ce07835d2938cab5` |

The challenge takes `context` and optional `identityClientContext`, without
email. Success supplies serialized `publicKey`, `referenceId` and its own
security-widget requirements. Completion requires a genuine
`publicKeyCredential` assertion and `atoInputs`, with optional reference,
referrer and scenario fields. Neither operation proves an approval URL or
exemption from required verification.

Android obtains the assertion through CredentialManager. REA provider and
challenge producer evidence:
`ev_0e02b118595fb32c585b3937cdfe6816072dafa962664042c4780af033f17a3f`,
`ev_3873d4217232e9a625ffcb567e8abce67b2191aaa6b6cb7fc07efa006d7be618`.

Capability negotiation is material. `identityClientContext.clientCapabilities`
is one object with optional `attestation`, `conditionalUiSupport`,
`passkeySupport`, `relatedOriginsSupport`. Native code omits attestation:
Apollo `Optional.Absent` is not the wire enum `"ABSENT"`. An exploratory request
with that invalid enum returned HTTP 400 and is excluded from successful results.
Valid values include `NONE`, `DIRECT`, `INDIRECT`, `ENTERPRISE`.

Native code advertises conditional UI and related origins, and checks Android
API/Google Play Services for passkey support. Those observations do not grant
the Linux CLI those capabilities. Normal native context uses `ANDROID_APP` and
`loginEntryPoint: INITIAL_AUTH`. REA capability/context evidence:
`ev_0008897b81b4e56e3fceff919445b56fd3da7a50578314f1628828456ce34384`,
`ev_c832245bed15361fc7584584071150c818cbbb3beb15aa94d735c1e764461b0c`,
`ev_f12449bfc5e2f43b564ed5b2e3226aae4a35a017ebc0449d422715f43836f08e`,
`ev_e97810467762c95f512d37deb4abe4a4d12e3f5d8f89dc8f62f5422552629101`.

The initial live request omitted capability fields. Corrected protocol probes
requested the passkey branch with attestation omitted and conditional UI/related
origins disabled, including a final query with `loginEntryPoint: INITIAL_AUTH`.
All returned NoAction. No assertion or registration was
submitted. Eligibility and a portable authenticator path remain unresolved;
these responses do not prove that every valid passkey context fails.

## Other routes and remaining work

Legacy `POST api/user/sign-in` takes profile options and existing cookies; it is
not a discovered credential bootstrap. REA:
`ev_f93970d191a5faf8c44eceef14745f8b46dc90c450e3e059eee8faa7969d6f28`.

OIDC consent consumes an existing `loginReferenceId`. This bounded trace did not
establish its producer, pairing lifecycle, CLI token exchange or approved
external callback. REA activity/query evidence:
`ev_f963702f55d6d324e33a59bd4d5faf72abe131d598e51fe91b9e3fc4f75a0c0e`,
`ev_fa8d0e39cacb267d414f7844fc7724c3880c0be054be01452fd20a284bc5e23f`.
Reflection and dynamic routing remain outside this incoming-reference scan.
The previously retrieved OIDC metadata and Naver exchange do not establish a
generic Expedia consumer-account grant for this CLI.

The native email-code flow now works with browser verification on the user's
device and the small Linux collector. A general consumer OAuth callback and
portable passkey flow remain unverified. Paid booking separately needs live
payment and issuer verification; no ticket was purchased.

The HTTP command path preserves saved sessions until a fresh account is
independently validated. Unknown submissions are never replayed. Local request
validation precedes consuming the browser proof; explicit repeated login can
renew expired or consumed proof without resending a code. Historical Android
runtime and relay modules were archived outside the repository. The installer
requires no Python and reuses or installs a checksummed tunnel executable for
the verification callback.

## Final verification

The revised installer and CLI were deployed to the ARM64 Orin. Authentication,
independent validation, receipt handling, codec, callback, cancellation, expiry
and unknown-outcome tests cover the new flow. Normal tools, status and flight
commands do not import a browser, Android runtime or subprocess module. The
verification worker dynamically starts only Node and its owned tunnel child.
The final suite has 103 tests: 102 passed on each host, with the inapplicable
platform-specific Trust test skipped (Linux collection on the Mac; non-Linux
rejection on the Orin).

After deployment, the normal Linux launcher refreshed the saved account in
0.731 seconds, with about 98.8 MiB peak child RSS for that invocation. It then
searched LAX–SFO for November 9, returned 82 offers, selected one, and prepared
a USD 87.11 checkout with two form groups. No payment or booking was submitted.
No Expedia container was running. Prices and offers are observations of that
test, not a held fare.

The final login test used a separate, initially empty CLI state directory. The
installed `login` command returned a verification link and acknowledged code
delivery; `auth code` authenticated and independently validated the account.
Its saved session then refreshed in 0.462 seconds with 97,640 KiB peak child RSS
(about 95.4 MiB). A following LAX–SFO search for November 9 returned 83 offers in
4.458 seconds (100,628 KiB peak child RSS across the measured children). No
payment or booking was submitted. Verification directories and their owned
tunnel/worker were removed after success. These observations establish the
tested fresh login, not universal acceptance of every future risk challenge.
