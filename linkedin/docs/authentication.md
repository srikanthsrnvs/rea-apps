# Authentication protocol and current limits

The CLI stores the user's session locally and uses LinkedIn HTTP endpoints for later commands. Credentials and session cookies must stay out of command arguments, logs, and repository files. A native sign-in response is not treated as authenticated until an authenticated profile query succeeds.

The installed Android app provides these contracts:

1. Initialize login cookies with `GET /uas/authenticate`.
2. Submit `POST /uas/authenticate` as `application/x-www-form-urlencoded`, including `session_key`, `session_password`, `rememberMeOptIn`, and the applicable LinkedIn cookies. A successful `login_result: PASS` is followed by account validation. A rejected request may instead return HTTP 401 with `login_result: CHALLENGE` and `challenge_url`.
3. The Android app handles that challenge in its own WebView. When verification completes, the app passes its WebView cookie string to `POST /uas/issueLoginCookie`, using the form field `cookies`. This is an internal session handoff. Opening the challenge URL on a separate computer does not by itself authenticate the CLI.

`src/auth-protocol.mjs` implements these exchanges and reports `verification_required` or `validation_required`. It does not invent an approval polling endpoint. A browser session transfer, if used, is a separate step and must be described as such.

The APK also handles passwordless email links containing an existing `midToken` and `otpToken`. It checks them with `POST /checkpoint/lg/passwordless-email-check-eligibility` and JSON `{bscookie, midToken, otpToken}`. If eligible, the app opens `/ssr-login/passwordless-email-login` with the token pair and a `session_redirect` pointing to LinkedIn `/nhome`. The module can validate the link shape and check eligibility. No email/SMS initiation endpoint or autonomous completion is established by this evidence, so eligibility never reports an authenticated session.

The smooth cross-device approval flow used by some other apps has not been verified for LinkedIn. The inspected official login response exposes password, Google, Apple, and passkey authentication. Signing in to the Android app alone does not authenticate the CLI; the verified native session import is a separate step.

## Evidence

Target: `com.linkedin.android` version `4.1.1261`, version code `216900`, APK SHA-256 `60e4a43691c6440c641707edd3e3201e0dd46eeba9e0363fe99945c84fe4ba4c`. REA JADX 0.7.1. These are static observations; server acceptance and end-to-end account access require separate live verification.

| Contract | APK selector | REA Evidence ID |
| --- | --- | --- |
| CSRF bootstrap | `NetworkUtils.performRequestWithCSRFToken` | `ev_69d5aad7c421ca8da913cb2f1fd7ab4ff5cab9bdc36dbbc568e4164f1e2e0c75` |
| Password authentication and challenge response | `LiAuthImpl.authenticate`, overload 1 | `ev_c3723add8ccf1a10df05fcadc4c95f8c504738028f817a67e4912368ca0673be` |
| WebView completion handoff | `LiAuthImpl.authenticateWithWebActivity` | `ev_3a4124d35640c889f0ac4b591e8a3192893253f911152ce5cb8b0a94c81a5752` |
| Login cookie exchange | `LiAuthImpl.getLoginCookies` | `ev_ca7590600893e514269a379d64a29bb500f977d585c6bbca548dad9c3e3bb28f` |
| Existing email token eligibility | `Radiography$$ExternalSyntheticLambda0.run$com$linkedin$android$liauthlib$LiAuthImpl$$ExternalSyntheticLambda31` | `ev_ecfa2ad985dab4e8f3a52c889d4b9a39aa2f580ca4d00cf067719b55a016b98c` |
| Existing email link completion URL | `FormsFeatureImpl$$ExternalSyntheticLambda1.onChanged`, smali fallback | `ev_a728efcd2eaff8f68564c5a2c063f5fc463cddf7e58a596134eb09ed5702a400` |

Full APK, raw responses, and retained evidence stay in the private investigation directory outside the repository.

## Native Google login investigation

`loginWithGoogleToken(client, {idToken})` implements the APK's alternative credential exchange: bootstrap the authentication cookies, then submit `googleIdToken` to `/uas/authenticate`. It does not combine that token with a password or claim success before the authenticated profile query.

The native APK's optimized `GoogleAuthUtil.getToken(Context, email)` uses scope `audience:server:client_id:789113911969.apps.googleusercontent.com`. It sends the requesting Android package identity to Google Play Services. A separate companion app therefore needs Google to accept its actual package and signing certificate; possessing the public audience string alone does not establish that acceptance. This native companion experiment has not yet established a working login.

The APK's R8 optimization removed recovery-intent accessors from its `UserRecoverableAuthException`. Loading that optimized class from the original APK cannot reliably present a Google permission prompt. A companion that needs recovery consent must use the standard, unoptimized Google authentication library and its native recovery-intent API. This does not require launching a browser, but Google may reject an unregistered client or require a different verification step.

The exported `LiSSOService` does not provide a general session export. Its `getTokensForUser` checks the real Binder caller's package signing certificate against an approved set and returns an empty list for other callers. Building a differently signed helper does not satisfy this check. The application also disables Android backup.

Additional REA evidence:

| Contract | APK selector | REA Evidence ID |
| --- | --- | --- |
| Google token login | `GoogleLoginFeature.loginWithGoogle` | `ev_7ee478fd3cf7c2715ec2e052387a84b7b0eb48816efa9e6c7f7df283adf6c6af` |
| Google audience and requester package | `GoogleAuthUtil.getToken` | `ev_446a8fad80df8b738cfc782732e9d9679c1e37e4ace3fbe498f76f9f1c7091e4` |
| Google recovery response | `com.google.android.gms.auth.zzl.zzg` | `ev_ef324fbdee2d98500c286168c05832cd783573d74a057bdaa34364ee833d5fb5` |
| Optimized recovery exception members | `UserRecoverableAuthException` | `ev_14b5af9004a5a62a895579c9cc53bb15c007e47a3c40725e47e53c6aa201c442` |
| Native SSO caller verification | `LiSSOService.verifyCallerSignature` | `ev_c35bb7f9fb25b3b3c23884e5bf11682de23c32fa5fd64e887f2aad0ee3b6d215` |
| Native SSO cookie access guard | `LiSSOService.AnonymousClass1.getTokensForUser` | `ev_0d4cba7ff1c3d4aaf73cdee6f00b30768ceb52e04080eb91587e7dab29bcdbc5` |

## Recovery investigation

The observed email-code sequence was account recovery: an email code, approval in an already signed-in LinkedIn app, then a new-password form. It did not establish an authenticated cookie before the password step. The investigation stopped there; no password was added or changed. This flow is not exposed by the CLI. Research-only replay code was retained privately outside the shipped package.

## Native session persistence

The original application stores its native network cookies in the Android shared preference file `CookiePreferences.xml`. On a standard user-0 installation this is `/data/user/0/com.linkedin.android/shared_prefs/CookiePreferences.xml`. Access to this private application file requires an appropriate inspection environment; ordinary ADB access to a release app does not provide it.

Each preference key is a URI. Its string value is a flat sequence of URL-encoded UTF-8 fields separated by commas, with ten fields per cookie:

| Index | Value |
| --- | --- |
| 0 | Name |
| 1 | Value |
| 2 | Absolute expiry, Unix seconds |
| 3 | Domain |
| 4 | Path |
| 5 | Secure flag |
| 6 | Cookie version |
| 7 | Comment |
| 8 | Comment URL |
| 9 | Port list |

The encoder skips expired and ephemeral cookies. The final port-list field can be empty, so a terminal comma must not be mistaken for an extra field. Live captures use a canonical `http://www.linkedin.com` preference key even for secure cookies; this key is an on-disk namespace, and CLI network requests always use HTTPS. The decoder uses Java URL decoding, including `+` as a space. This persistence codec does not encrypt the cookie values. Captures must remain private and must not enter logs, test fixtures, or the repository.

The inspected unauthorized-response handler retains the session when `li_at` is still present and treats a missing `li_at` as a reason to return to login or log out. This evidence does not establish an autonomous Google refresh-token exchange. The CLI must retain server cookie updates and validate the authenticated account separately.

Persistence evidence: `PersistentCookieStore.initIfNeeded`, `ev_a80e5f614c1a180f3da391ae7e7d9cb848c98571150f50c74879d76db2bf5233`; `CookiePersistenceEncoder.decode`, `ev_eb60543efea5650eb1a71d61223d1406cfab16000e752f62c813e6e47f52b928`; `UnauthorizedStatusCodeHandler.handleStatusCode`, `ev_b299871c9d2e7af4552180d17999c1ee62ae5626c04a016f1bf164d989f66a20`.

The current Credential Manager path uses the same `default_web_client_id` resource as the older token path: `789113911969.apps.googleusercontent.com`. This was checked against resource ID `0x7f140813`, not inferred solely from a loose string match. The inspected current method is `CredentialManagerLoginFeature.buildGetCredentialRequest`, REA `ev_1ff448c133042a3ee25566af0b7f7af98ac05456be513bf183b7de7726fe22dd`. Independent companion-app experiments did not obtain a Google token. Their failure does not imply the user's Google account requires a LinkedIn password.


## Verified Google bootstrap

The original signed APK was installed unchanged in an isolated Android 15 Google APIs emulator. The user completed its normal Google sign-in. `auth import-android` read only LinkedIn's native cookie store, decoded it, and successfully validated the authenticated profile over HTTP. No Google credentials were exported. After stopping the emulator, production CLI commands validated search, pagination, profiles, inbox, messages and unread filtering on macOS and on the Linux ARM64 Orin with no display. The temporary emulator account data was then removed.

A new headless installation still requires this native bootstrap or an existing private LinkedIn session export. The current evidence does not establish self-contained Google-only login on the Linux host, a public approval URL, or autonomous refresh after revocation. Cookie rotation is persisted, and expired/revoked credentials produce authentication errors.

Later exported test sessions encountered authentication failures. A subsequent bootstrap completed the native Google confirmation, stopped the test LinkedIn app before reading its cookie store, and imported directly into the Orin without using a second HTTP client with that cookie copy. Repeated Orin profile reads then succeeded with the native app stopped. This isolates concurrent app/client use as a variable; it does not establish the cause of earlier failures or long-term session reliability. Keep the session on one CLI host during validation and retain server cookie updates there.
