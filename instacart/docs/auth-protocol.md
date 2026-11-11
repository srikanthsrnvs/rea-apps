# Native authentication

The Android customer app declares a phone or email verification-code flow. The
CLI sends that flow over HTTP; it does not need a browser or an Android device
to execute the protocol. Whether Instacart accepts a new headless login remains
a live verification requirement. A server-requested identity challenge must be
reported as a blocker, never treated as successful authentication.

## Artifact and evidence

Target: `com.instacart.client`, base APK SHA-256
`f6e451263f43a1169aab0319244b17d77c7ace598f5666cb3a61da60d0d50dd1`.
REA used JADX headless MCP 0.7.1. These are static observations; the declarations
alone do not prove an accepted login or persistent session.

| Observation | REA evidence |
| --- | --- |
| Phone code request uses `sendVerificationCode`, returns `expiresAt`, `nextCodeAt` and `verificationSessionToken`; optional configuration and recaptcha metadata originate in the identity configuration | `ev_302c469b232291275b45a1a7343134cf6c7da371073de2b86d8d93d007a8f5d7` |
| Email code request uses the same result shape | `ev_83b0d5fd96dc36e112830798459303e46cfb5b821cd57f67ae114e1228195986` |
| Phone confirmation is `CreateUserSessionFromPhoneNumber`, returning `UsersAuthToken.token` or `SharedError.errorTypes` | `ev_fc6f6c5be1d87af4805d42f4c2dc662389f60abd0eb289d7a4890a24eafb1f8f` |
| Email confirmation is `CreateUserSessionFromVerificationCode`, with explicit identity type and the same union result | `ev_8af1d261dbc8c1f9997c380928b6ad3706cdea78cc049487c972944f7f19ce3f` |
| Request type enum distinguishes `loginRequestInitiated` from `signupRequestInitiated` | `ev_b0493f3207dcfca1328652d0f0f4350e3a995dae24446326db86393d0124c0f2` |
| `IdentityConfig` document includes configuration token, native recaptcha site key, SDK flags and third-party profiling configuration | `ev_196d7094935eeffe05ca55c44cc83b819d1ee3616d3daf46db9b677b1a243cef` |
| Native configuration maps recaptcha to `recaptchaTypeEnterpriseV3` | `ev_b8faf2452d8147f30408dc6fb8d9aad1723d4de153eeae02160d56a3c55bce0f` |
| Generated phone response adapter requires both timestamps but permits `verificationSessionToken` to be null | `ev_9bdc26f83f0a1d802840cede3b783ab5c54016de6524150c499b84b419746195` |
| The timestamp scalar is `ISO8601DateTime`, mapped to `org.threeten.bp.Instant` | `ev_2fff3407976ca0e9fc80f5013ff58a24e68a66cc3c412f7f8f9e980a8005fee0` |

The exact native Apollo documents are retained in `src/auth.mjs`. Their
SHA-256 hashes match the generated native operation IDs:

| Operation | Persisted query SHA-256 |
| --- | --- |
| `IdentityConfig` | `afbbbcd65b0905f94d1fac92bf242524806de58e1094fbb0163963fe9dd76d84` |
| `SendPhoneNumberVerificationCode` | `ff9da2c87fc18e78363834b0a2ff147336aff46cec877f85e6210c043b4650c5` |
| `CreateUserSessionFromPhoneNumber` | `96396576c9b696042007e0630119392c42ee278d7fcd8f421536683e5f304b58` |
| `CreateUserSessionFromVerificationCode` | `f0b1cd16d4431b6e31b53c5970aff4c2a68bb4a46099a64c57badb20f735516e` |

Generated-ID evidence: `ev_2af7bf9c2e70e1d98a8ead9c52cfee2d3d5396b427f1dc90e0661517afc99667`,
`ev_547647e1544e4046b2ae4cd8758a2306a5c74a4a593c434dcf022f694c124c12`,
`ev_e2d63d0ed27903c64d6530fc4f5fde50c66fa9302079806bddb080e7c7881147`.

## CLI state transitions

1. Request `IdentityConfig`, then send one code request with
   `requestType: loginRequestInitiated`. Account linking is disabled.
2. Save the private verification session, destination, expiry and resend
   cooldown. The verification session token may be null; omit it from the
   confirmation variables in that case. Return only a masked destination and
   timing information. Preserve incomplete responses privately before reporting
   parsing errors, since the server may already have sent a code.
3. Repeated login calls reuse an unexpired pending session. Resending is
   explicit and respects `nextCodeAt`. Transport failures do not trigger an
   automatic resend.
4. Confirm the user-supplied code using the matching native mutation and the
   saved configuration/verification-session tokens.
5. Keep the returned candidate token private and run a read-only account query
   with it. Promote it only after validation succeeds. A previous saved session
   survives a failed replacement; validation may be retried without consuming
   the same code twice.
6. Local logout removes the saved token and pending login. It makes no claim
   to revoke sessions on other devices.

State persistence and mutual exclusion belong to the CLI caller. Do not print
the state object or raw authentication responses. A live SMS/email request,
code acceptance, read-only validation and persistence across a fresh process
must all be verified before claiming a working independent login.

## Live verification

On October 29, 2026, native SMS login was verified using direct HTTP. The first
integration exposed the nullable verification-session token handling described
above; the code was accepted and the returned customer session validated.
After correcting that parser, a separate clean state directory on the headless
Linux ARM64 Orin completed the normal `login --phone` and
`auth complete --code` commands. A fresh process then validated the account and
used that independently obtained session for priced search, pagination,
addresses and order history. No browser, emulator or Android session extraction
was used for this login. Pending login fields were removed after successful
validation; credentials remain in owner-only private files.

Email OTP is implemented from the native documents but has not been live
verified.

## Remaining unknowns

- Different accounts or networks may receive additional recaptcha/device-
  profiling checks; their completion is not established by this successful
  phone-code test.
- Session expiry, refresh and server-side invalidation behavior. No refresh
  protocol has been established by this bounded investigation.
- A Spotify-style device approval URL. No such flow was established here;
  verification codes are the observed native alternative.
