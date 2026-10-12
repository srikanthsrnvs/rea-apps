# Authentication from a separate client

The intended deployment has the CLI and agent on a headless Linux host and the
user's browser on another computer or phone. The browser must hand an approved
session back to the host. Opening Instagram's normal login URL does not do this:
the resulting Instagram cookies belong to the user's browser.

The current CLI supports a local Chrome helper and explicit session import. Its
plain `login` command prints instructions; it does **not** create an automatically
completing approval request. Read commands use HTTP and need neither Chrome nor
Android after a session has been installed.

## Investigated first-party pairing flow

Static inspection of Instagram Android 450.0.0.50.77, version code 385611438,
found these Instagram-schema persisted operations:

| Operation | Client document ID |
| --- | --- |
| IGLoginGenerateCodeMutation | 82937153511246572586758342999 |
| IGLoginListenValidationQuery | 405700813613588275400723846443 |
| IGLoginExchangeTokenMutation | 31317417613715977361635932745 |

The QR login view model sends a PEM RSA public key in the generate operation's
`input.public_key`. Its input also includes nullable `device_id` and `request_id`.
The app creates a 2048-bit RSA key in AndroidKeyStore under `ig_rsa_key`, with
OAEP padding. The successful response's `ig_login_generate_code.code` is rendered
as a QR payload without a URL prefix added by the inspected rendering method.

The view model polls `ig_login_listen_validation` with `input.code` and nullable
`request_id` every five seconds, for up to ten minutes. The response schema has
`encrypted_first_nonce_code` and `encrypted_second_nonce_code`. Finding the
exchange operation in the shipped registry does not establish a working exchange
contract or prove that approval is available in a normal web browser.

On 2026-10-12, an anonymous HTTP request to the app's observed
`https://i.instagram.com/graphql/query` transport using the shipped generate
document ID returned HTTP 200 and:

```json
{"data":{"ig_login_generate_code":null},"status":"ok"}
```

Providing a fresh device ID and request ID also returned a null root. These
responses establish that the tested requests produced no pairing code; they do
not establish why, or that every account or client is ineligible.

## Investigated website pairing flow

The website ships `CAAFetaIGLoginHomepageQuery` with document ID
`27649441548091928`. Its logged-out homepage result has a
`qr_code_login_data` field. An anonymous request with the website bootstrap tokens
returned homepage data, but `qr_code_login_data` was null.

The shared website QR refresh operation also returned
`request_qr_code_login_props: null`. Shared Meta login components alone do not
prove that an Instagram approval link is available for this deployment.

## What remains unverified

There is no verified Spotify-style Instagram link-to-session flow in this CLI.
Do not advertise one until a fresh Linux request is approved in a separate client
browser, credentials arrive on Linux without a manual export, and the account,
search, Explore continuation, and inbox reads succeed using that new session.

An alternative is a clearly labeled login page served by the Linux host, which
relays user-entered authentication to Instagram. That is a different flow from
logging in solely on instagram.com. It would need secure client access, explicit
handling of verification and challenges, and a live end-to-end test before it
could replace the existing helper.

APK bytes, decompiled source, raw responses, generated RSA private keys, and user
sessions are kept outside the repository. No account credentials are required to
read this protocol record.
