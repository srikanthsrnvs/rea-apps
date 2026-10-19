# Claude account authentication

Recovered from the installed Android application `com.anthropic.claude`, version
`1.261016.51`, APK SHA-256
`9031d8c700315ada64e41ffdd4a81fad881e0670b03b1f6de3a3ebbec1fda080`.
These are private application interfaces and can change. Source recovery alone
does not establish that a headless login will be accepted by the server.

## Email sign-in

The native client posts JSON to `https://claude.ai/api/auth/send_magic_link`:

```json
{
  "email_address": "person@example.com",
  "recaptcha_token": "xxx",
  "recaptcha_site_key": "xxx",
  "utc_offset": 0,
  "source": "claude",
  "client": "android",
  "attestation_issued_at": 1792340000,
  "attestation_nonce": "fresh-own-nonce"
}
```

The two `xxx` values are the literal defaults in the native request constructor.
`utc_offset` is measured in minutes east of UTC, including daylight saving time. The native caller is `-new Date().getTimezoneOffset()`; the web caller separately uses minutes west of UTC. An explicit `login_intent: "magic_link"` is
used by one native UI path; another leaves it absent. The request optionally
contains `client_attestation`, enabled by the
`claudeai_send_email_attestation` feature flag. Its integrity request hash is
the hexadecimal SHA-256 digest of
`send_magic_link/v1:{issued_at}:{nonce}:{email_address}`. That public digest is
an input binding, not an attestation or secret signature.

The response contains `sent`, optional `sso_url`,
`magic_link_intent_available`, and `fallback_code_configuration`. The latter
contains optional `charset`, `length`, and `show_input_after_delay`; no expiry
field was recovered. A confirmed email send is not an authenticated session.
The existing account identity must be used; successful verification can also
return `created: true`, so account creation must not be silently inferred safe.

Native code verification posts to `/api/auth/verify_magic_link`:

```json
{
  "credentials": {
    "method": "code",
    "code": "001234",
    "email_address": "person@example.com"
  },
  "recaptcha_token": "xxx",
  "recaptcha_site_key": "xxx",
  "source": "claude",
  "play_integrity_token": null
}
```

The native app obtains a Play Integrity result before verification. It can
also proceed after SDK failure: its source converts the result to
`client_attestation` containing either a real `play_integrity_token` or a
`play_integrity_mint_error`. The builder accepts genuine supplied proof and
otherwise sends a null token. It does not generate or pretend to possess an
Android integrity proof or fabricate an SDK failure. Server acceptance of the
proof-free request must be checked independently.

The official Android email link is
`https://claude.ai/magic-link/android#nonce:encoded_email_address`.
Its alternative credentials are
`{"method":"nonce","nonce":"...","encoded_email_address":"..."}`.
No arbitrary HTTPS callback, device-pairing poll, or Spotify-style approval
handoff was recovered in these native email contracts. Opening an ordinary
Claude login page in a separate browser does not itself transfer its session
to the CLI.

## Validated headless flow

The CLI uses the native email initiation above, then the official web
verification contract for the copied email-button URL or code. A real hCaptcha
widget runs in the user's browser with public login sitekey
`a8086506-2036-46f4-ae50-00d8be805efa`. Its genuine token is submitted as
`client_attestation: {hcaptcha_token: token}`. This verification request omits
native recaptcha placeholders and outer Play Integrity fields and declares
`web_claude_ai`. Subsequent account/chat reads use the recovered native profile
and the resulting scoped cookie jar. No Android attestation is fabricated.

Live Orin verification returned HTTP 200 and session cookies. A separate account
read and chat history request validated the saved login. The first membership
was API-only; selecting the unique membership with `chat` capability resolved
its history permission error. Missing Android attestation had been rejected;
Claude Code's public OAuth client also rejected the account-chat scopes, so
neither rejected path is used as a login fallback.

Official web source also exposes `POST /api/auth/exchange_nonce_for_code` with
`{nonce, encoded_email_address, source: "claude"}` and no proof in that caller.
It is a code handoff, not an authenticated session. Normal web email initiation
omits `client`, uses null `login_intent`/`return_to` and a separate hCaptcha key
`f1b21a9c-9100-4022-a928-8d5c29de2e6a`; it is not the CLI's current native email
bootstrap. Proofs must not be reused between requests.

REA web caller summary `ev_d96414d324e43b7374bec815a2cecc70d02db0a2c47e19c7c8b12b2f10d731c6`,
retained parent `ev_53fce3fc9594ab67a5dc06b3763bc89c8cecb2e64523025087c05f5878e09a78`.
Native timezone evidence `ev_25eca9f84b3c27b8b41807652d7794660f8db257f3375ca84ab722446815a7a5`
and `ev_79adb640747bb002ed7240e527849dbd60da744567a5e5b3ca8e07bda3a37f51`.

## Google sign-in

The native app uses Android Credential Manager/Google authorization, with the
production server audience
`1062961139910-l2m55cb9h51u5cuc9c56eb3fevouidh9.apps.googleusercontent.com`.
An obtained genuine identity token is posted to
`/api/auth/verify_google_mobile` as `token`, with optional `join_token` and
`login_token`, native recaptcha defaults, source and integrity fields.
The alternate `/api/auth/verify_google` accepts a Google authorization `code`
and `redirect_uri`. This identifies exchange contracts; it does not establish
a new arbitrary callback URL registration or a portable browser authorization
flow.

## Session and validation

Verification returns `success`, `account`, `secret`, `sso_url`, `state`, and
`created`. Authentication state can explicitly require further verification.
The native HTTP cookie jar persists a `sessionKey` cookie received over HTTP.
Do not interpret `secret` as a proven bearer token. Independently validate the
new candidate cookie jar with `GET https://claude.ai/api/account` and compare
its account UUID/email to the expected identity before replacing saved state.
No bearer refresh endpoint was established in this investigation. Renewed
cookies should be captured normally; the APK also contains separate trusted
device reattestation paths, which are not an established requirement for basic
chat reads.

## REA evidence

| Observation | Evidence ID |
| --- | --- |
| Send endpoint and request serializer | `ev_255f06aab0ca80d3465d2e7ca05bd3c2cfb327fa4b0cbe9b2af62338409d3789` |
| Send request field declarations | `ev_6de150fb1c32f9c8d3b8cd95e63187aa4d41d90845712693c5ba31ff52bb9589` |
| Send timestamp/nonce and flag-gated integrity | `ev_173e933a61a2d76b9f47757c09ab5e4b1e6b73d3fd69890d6c0bfba04f48a57f` |
| Input-binding digest format | `ev_293f5b473ab43f4808ab63085f862a7e39caa1c2dfc7a6b1190f7cdceb0ae2ff` |
| Verify endpoint and response serializer | `ev_6240a8ecaf5a7c740be4be28738113b5570701b3aa24feb606ca77a9b3a087c9` |
| Code credential discriminator/fields | `ev_3d02b4de82e2eef58be6c32ee5af55d34c38005f87bc383120ebaf5d11a9aed8` |
| Nonce credential discriminator/fields | `ev_ed58aea6a7ceb7fbafa49f2ae4ef901ffe0246413d207e34aec573f91116bf25` |
| Integrity success/failure conversion | `ev_b20772bb045d8b54ecd5369800579fb408c259a3e65a487a9b766e2bda8a2783` |
| Official Android magic-link parsing | `ev_f1c5b346717a845a5cb7c0ed8a3e1a8748660d4ddc927a0645b713ff7fbdcf3d` |
| Google token/code exchange routes | `ev_dfb880ce184cf08d77f9a0a87c7c005f199c0abffd4bcbc3c545572a180fb3ea` |
| Production origin | `ev_5036dbb9ccd51a46f8c3585ec1b2adff6b4505cf9d568789c335b295c7a0322a` |
| Account read validation | `ev_92b3f71766ffeb5b96610fe1c722010e5bb07f5aa9754119f86b5bd57b508e43` |

Raw evidence and account-bearing artifacts remain outside the repository.
