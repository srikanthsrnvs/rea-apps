# Android authentication investigation

Normal CLI login uses the separately verified [device authorization flow](device-auth.md).
This document records the Android protocol and why its browser fallback is not
the production login path.

The CLI implements the Android account protocol using HTTP, PKCE and ordinary
P-256 signing. `src/auth-protocol.mjs` builds requests and checks responses;
`src/native-crypto.mjs` signs DPoP proofs. Neither module launches a browser or
Android runtime. A response page and an authorization code are intermediate
states, not evidence of a valid saved account session.

## Evidence boundary

The protocol was inspected with REA/JADX against `com.openai.chatgpt` version
`1.2026.286` (build `2628614`). The base APK SHA-256 is
`29d0c948857cc56034cf9172f1c1a1263779796611e6e3a3e3cc58342b175e25`.
The original APK and complete evidence stay outside the repository. Static
inspection establishes what this shipped client constructs; it does not prove
that an arbitrary computer will pass the service's verification requirements.

The first HTTP-only authorization probe on the Orin received a Cloudflare
challenge. This was a challenge response, not an accepted login. The app itself
recognizes this condition and can fall back to browser authentication. A
lightweight replacement must complete genuine verification or use another
accepted authorization path; it must not treat a challenge page as success.

A subsequent browser link returned `preauth_cookie_missing`. Inspecting the
browser-specific path showed that it supplies a preauthorization outcome and
uses different parameters from the native JSON path. The CLI now constructs
that browser variant, versioned as `android-browser-preauth-fallback-v1`.
Source equivalence does not establish that the service accepts this fallback
from a standalone computer; live login validation remains necessary.

The live browser test on October 19, 2026 rejected that fallback with
`preauth_cookie_device_check_failed`. The CLI's missing Android integrity
provider is therefore a real authentication blocker for this route. Do not
present it as a working login or synthesize a successful device check. The
official Codex device authorization endpoint also rejected the Android client
ID with `invalid_client`; a device flow for the Codex client is a separate grant,
whose ChatGPT permissions were then independently verified: account reads,
listing/reading conversations, and one new message with a saved reply succeeded.

## Authorization and continuation

The public Android client ID is `app_xwBKzt04752TTSfXnki17hmB`. Its native return
URI is:

```text
com.openai.chatgpt://auth.openai.com/android/com.openai.chatgpt/callback
```

The client generates an independent verifier, state and nonce for each attempt.
It uses S256 PKCE and requests these scopes:

```text
openid email profile offline_access model.request model.read organization.read organization.write
```

`createAuthAttempt` returns a browser authorization request. The user opens it
on their own computer; the headless host runs no browser. The Android browser
path calls its PKCE builder with the native flag disabled, ensures `openid`,
and omits the native-only `issuer`, `ccaps`, `screen_hint`, and `hydra_flow`
parameters. Its normal path first requests a preauthorization cookie using
Android Play Integrity, then appends `preauth_cookie` to the URL. When that
request fails, the app instead appends `preauth_cookie_failed` and still opens
the browser. The failure mapper uses `other` for an unclassified failure.

This CLI has no Android integrity provider, so its browser request truthfully
uses `preauth_cookie_failed=other`. It does not fabricate an integrity token
or preauthorization cookie. `buildBrowserAuthorizeRequest` also supports a
genuine provider cookie as a separate input, mutually exclusive with a failure
category. The browser path leaves the account identifier for the user to enter.
Old pending requests are distinguishable by the flow version; an already
started token exchange must not be replaced or retried automatically.

The initial native email flow sends a GET request to
`https://auth.openai.com/api/accounts/authorize`, with `Accept: application/json`.
Its query includes `client_id`, `redirect_uri`, `response_type=code`,
`audience=https://api.openai.com/v1`, `scope`, `state`, `nonce`,
`code_challenge`, `code_challenge_method=S256`, `android_device_id`, and
`requester_metadata_app_version`. Native initialization adds
`issuer=https://auth.openai.com`, `screen_hint=login_or_signup`,
`hydra_flow=condense`, and supported `ccaps` values. Capabilities observed in
the app include `email_otp_deeplink`, `default_otp_v2`, and `login_methods`.

Responses use a `page` object with a `type`, optional `payload`, and errors.
Subsequent requests go to
`https://auth.openai.com/api/first_party_authorize/next` and preserve the login's
cookies and proof key. The body supplies the server's current page as
`origin_page_type` and the corresponding `data` object. For example:

```json
{
  "origin_page_type": "login_or_signup_start",
  "data": { "username": { "kind": "email", "value": "user@example.test" } }
}
```

Email verification has `origin_page_type=email_otp_verification` and
`data={"code":"012345","intent":"validate"}`. Its explicit resend intent is
`resend`. Leading zeroes are significant. Other possible pages include password,
passkey, multifactor verification, external URLs, token exchange and errors.
The CLI must preserve unfamiliar pages and surface a supported next action,
rather than inventing an answer or automatically creating an account.

The separate POST endpoint `api/accounts/authorize/native` is a Google identity
token entry point. Its body contains `subject_token` and
`subject_token_type=http://auth0.com/oauth/token-type/google-id-token`. It is not
an email-code endpoint.

## Token exchange and persistence

The token endpoint is `https://auth.openai.com/oauth/token`. The Android client
sets a `DPoP` proof header and `oai-uit: True`. An authorization-code exchange
uses `client_id`, `code`, `code_verifier`, `redirect_uri`, and
`grant_type=authorization_code`. Refresh uses `client_id`, `refresh_token`, and
`grant_type=refresh_token`.

A native `token_exchange` page can instead provide an intermediate identity
token. Its exchange uses `client_id`, `scope`, `subject_token`,
`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, and
`subject_token_type=urn:authapi:id-token`. A native `token_response` page may
already contain the account's tokens. Tokens must be validated against account
access before replacing a previously saved session. The Android client checks
the identity token's nonce against the login attempt.

Kotlin serializer descriptors use camelCase names for several fields. The
app's JSON configuration uses its snake-case naming strategy; descriptor names
alone must not be copied verbatim as HTTP field names. Generic HTTP converter
configuration and live service acceptance remain separate validation concerns.

Each DPoP proof is ES256 with a public EC JWK in its header and a new UUID `jti`.
`htu` includes the lowercased scheme and host, a non-default port when present,
and the pathname, excluding query and fragment. `htm` is the HTTP method;
`iat` is the current Unix time in seconds. Authenticated resource requests also
include `ath`, the base64url SHA-256 of the access token. The signature is the
64-byte JOSE `r || s` representation, not ASN.1 DER. Keep the private proof key
with the session because proof-bound tokens depend on that key.

## Selected REA evidence

| Observation | Evidence |
| --- | --- |
| Native callback construction (`m27.invoke`) | `ev_c2a0bdaec38e5413ef1db4951dfea8695189ee5e6c5013303295b4725c22331e` |
| Default scopes and authorization URL (`q67.<clinit>`) | `ev_31211e8a36697844f46478b874d21022866a25d03bff80db3bc3e8da8af0272c` |
| PKCE and native query (`pne0.b`) | `ev_c0971c8d0aab2bd61a57861b6d6fe6cd1b3e6d44f62165815f826d0c6be5a4b7` |
| Browser PKCE variant and parameter merge (`m2q0.invokeSuspend`) | `ev_2bc78c1ade382e6faa397c2bbf1336cc7aeafaa56c5ae5622c648fb7a44660cc` |
| Preauthorization outcome merged into browser parameters (`j931.j`) | `ev_805a990d434fe326d51de645e1b346f2009fd951a5819a9402cccc549ae2fbb9` |
| Cookie or failure query parameter (`j931.e`) | `ev_a3767f769d4a3848a7b31069b95c3ab70f454c4eb5c67206c4250c5e20c6c547` |
| Browser URL assembly (`q731.a`) | `ev_a739f13ed68fb318095704015dbdd9d496464c4b717f1f2d3fd65f0d2bcffe44` |
| Native preauthorization request: relative POST `preauth_playintegrity` (`jof0.invokeSuspend`, case 6) | `ev_78bb06f00d212282e898964dead77829750db9794d59a802f6a6f5895c200791` |
| Native request construction (`ql5.invokeSuspend`, case 2) | `ev_6265613b4ae307c45dd48fd8bf7477632cf4ed366ea499f814a914439b7a1cdb` |
| Capabilities (`imd0.invokeSuspend`) | `ev_6ee0129424f965da8a901e9a962a6304988c427f9f32663fab5e46090ee944ae` |
| Continuation and challenge handling | `ev_4086f3beb9526b415414e2da65e8b496fee607c527b4b514def82f59ae3c9725` |
| Continuation envelope | `ev_ff1304b974b321477c84a99973db899c1ba8c4ff89418f5db7099d70f2e4485a` |
| Page discriminator | `ev_183ca6c54c0650645e30fdca3644903a46a539b7f4e15dad3f0eda9eda533661` |
| Email verification request fields and intents | `ev_2d00d5db044f1a6fa5dea2905908ba0c2c8bec452216ecd88b4f127dd9203a62`, `ev_bdda1a0ac43bd7d2eeebc11a34a38bf80f1ac1b20768d0f45ede95cb87283ea5` |
| Token request and headers | `ev_d117b7da64854ed55b10c7005f59c1df102f465f70f8ed6987fe5c636d3f3abb` |
| Refresh grant descriptor | `ev_9d656bf8fb5d0d17810a2ed55adcbc4fd36217c1e7a38158ea36a9cec40ae9b6` |
| DPoP signing and URI normalization | `ev_5ecd280b75d0d740a25c0f8b8716999cb61a2cfc691c5e835b14a42d9746c3d5` |
| Native token handling and nonce check | `ev_14d58a34e74a790406535852abea8becbd07289de821120c095c89a4feadce2b` |
| JSON configuration and naming strategy | `ev_e949ac6f8bfa3dbb047dc72ae4876d7c461c7847e82b95306457b64963915db5`, `ev_f5ae8037ea549c02afa668209a1abe0fbf3e60b8586059ad6ee6fe64d276246e`, `ev_503142da625e220d18ac13a5a379792ec0f297ad3f0f1ccc8da192de950abd94` |

Some methods required REA's complete smali fallback. Others have imperfect
decompilation; conclusions above combine method dataflow, serializer descriptors
and related methods rather than interpreting missing Java expressions as
intentional omissions.
