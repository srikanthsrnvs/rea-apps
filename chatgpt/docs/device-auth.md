# Headless device authorization

The default login uses OpenAI's Codex device authorization flow. The CLI
requests a code, shows OpenAI's verification URL, and waits while the user
approves in their own browser. The Linux host runs HTTP requests only. It does
not launch a browser, Android runtime, or remote desktop.

This is a new session explicitly authorized by the user. The CLI does not read
the credentials of an existing Codex installation or the agent running it.

## Wire protocol

The public client ID is `app_EMoamEEZ73f0CkXaXp7hrann`. The request sequence is:

1. POST JSON `{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann"}` to
   `https://auth.openai.com/api/accounts/deviceauth/usercode`.
2. Keep `device_auth_id` private. Show the returned `user_code` and
   `https://auth.openai.com/codex/device` to the user.
3. POST JSON containing `device_auth_id` and `user_code` to
   `https://auth.openai.com/api/accounts/deviceauth/token`. HTTP 403 and 404
   mean approval is still pending in this polling flow. They are not a reason
   to create another device code or to repeat other requests rapidly.
4. A successful poll returns `authorization_code`, `code_verifier`, and
   `code_challenge`. Check that the challenge is the base64url SHA-256 of the
   verifier before using the code.
5. POST form-encoded `grant_type=authorization_code`, `client_id`, `code`,
   `code_verifier`, and
   `redirect_uri=https://auth.openai.com/deviceauth/callback` to
   `https://auth.openai.com/oauth/token`.

The app accepts the response spellings `user_code` and `usercode`; conflicting
values are rejected. Polling intervals may be integer strings or numbers. The
implementation waits at least five seconds between polls and limits a pending
attempt to fifteen minutes. Negative, fractional, or excessive intervals are
rejected. Other unsuccessful HTTP statuses need an explicit error rather than
an automatic retry loop.

This flow does not use Android preauthorization cookies or DPoP proofs. Its
tokens are presented as bearer tokens. An authorization code is single use:
after an uncertain exchange, preserve that uncertainty rather than repeating
the POST. Validate the identity and account access before replacing an existing
saved session. Preserve the old session when a new login fails or expires.

## Implementation boundaries

`src/device-auth-protocol.mjs` contains only request builders, configuration,
and response validation. It makes no HTTP calls, writes no credentials, and
does no polling itself. Runtime code enforces the polling schedule and expiry,
handles token persistence, and checks account access.

The public `userCode` removes the display hyphen for the nine-character entry
field. The private poll request retains the exact code issued by the service.
The user may need to enable device code sign-in in ChatGPT Security settings.

The module exports:

- `DEVICE_AUTH_CONFIG`
- `deviceCodeRequest()`
- `parseDeviceCodeResponse(payload)` →
  `{ deviceAuthId, userCode, intervalMs, verificationUrl }`
- `deviceTokenPollRequest({ deviceAuthId, userCode })`
- `parseDeviceTokenPollResponse(payload)` → `{ code, verifier, challenge }`
- `deviceCodeGrant({ code, verifier })` → form fields for token exchange

Tests cover both code spellings, interval bounds, missing fields, input
validation, and the published RFC 7636 S256 test vector. Synthetic fixtures
contain no account credentials or live device codes.

## Sources and observed capability

The protocol follows OpenAI's published
[device authorization implementation](https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs)
and its
[authorization-code exchange](https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs).
The source supplies the two JSON endpoints, polling status handling, fifteen
minute timeout, verification URL, and callback URI. The CLI adds a five-second
minimum polling interval and verifies the returned PKCE pair locally.

A fresh user-approved session was separately tested against the Android and
web account endpoints; both returned the expected account, and the chat list
returned actual conversations. Searching/reading conversations and creating a
new chat also succeeded; an independent read confirmed both the submitted
message and ChatGPT's final reply. Other operations and future service changes
still require their own verification; successful device login alone does not
prove every ChatGPT capability is available.
