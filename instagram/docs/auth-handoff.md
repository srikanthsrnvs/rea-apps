# Authentication from a separate client

`instagram login` generates an approval link on the headless host. The user opens it in their own browser, signs in **only on instagram.com**, and confirms the code. `instagram auth wait` receives the approval, exchanges it for a session, validates the account, and saves the session privately on the host. No browser, display, Android runtime, developer API key, extension, remote browser, custom password form, or manual cookie transfer is required.

## Verified first-party TV pairing

The working protocol comes from the official [Instagram for TV app](https://play.google.com/store/apps/details?id=com.instagram.airwave), package `com.instagram.airwave`, version `39.0.0.7.108`, build `304000944`. The APK was inspected statically and was not installed or run. APK SHA-256:

```
199d9bf94b7333b315771aff243a6452a07b770704050eae5d74b20f6ad91f62
```

Google's APK signature verifier confirmed its v2 and v3 signatures. Signer certificate SHA-256:

```
efbba5eeb93079cb0202cae84821fceb19a41944a43d376e5e4a76bba9032f86
```

REA package inventory evidence: `ev_c354db02e978c10f334b8ae31f8fbb6a94e8a4dd9ac9c5d27a43eca9f076120f`. Its Hermes v98 bundle was decoded using the official Hermes `static_h` instruction schema at commit `f9c10db85a47f5bc98d50182c329a4217cde8466`. Persisted operation descriptors, their consumers, and native cryptography provided the contract below. Static findings were then tested against a real user approval and live authenticated reads.

| Stage | Operation | Document ID | Top-level variables |
| --- | --- | --- | --- |
| Generate | useAirwaveGenerateLoginCodeMutation | 24426392696979234 | device_id, public_key |
| Poll | useAirwaveLoginListenValidationQuery | 30706232158975150 | code |
| Exchange | useAirwaveLoginExchangeTokenQuery | 24248585958071086 | first_nonce_code, registration_code, second_nonce_code |

The transport is `POST https://i.instagram.com/graphql_www/`, with URL-encoded `doc_id`, `variables` (JSON), and `queryName`. TV headers include application ID `1281876400241826`, the version/build, a generated device UUID, and the operation's friendly name. Generate, poll, and exchange require no existing account cookies.

Generate submits a newly created 2048-bit RSA public key in SPKI PEM format. The private key stays on the host. The returned code has ten letters. The app's URL constructor formats them as three, three, and four letters:

```
https://www.instagram.com/activate?code=ABC-DEF-GHIJ&flow=login&login_session_id=UUID&source=qr
```

`login_session_id` is a client-generated telemetry UUID. Approval and exchange are bound to the registration code and RSA key, not that UUID. A link visit alone does not approve: the user must confirm the code and complete Continue. Instagram may redirect to Home after login; reopening the same link presents confirmation.

Polling returns `encrypted_first_nonce_code` and `encrypted_second_nonce_code`. A pending response has null nonces. In the live successful flow **only the first nonce was present; the second was null**. The first nonce is decrypted with RSA-OAEP using SHA-256, MGF1 SHA-256, and an empty label. When present, the second uses the same algorithm. Exchange includes `second_nonce_code: null` for the normal one-nonce flow.

Exchange returns `access_token`, `user_id`, and `analytics_claim`. The observed token begins `Bearer IGT:2:`; its Base64 payload contains server-issued `ds_user_id` and `sessionid`. The CLI validates these fields, converts the issued credentials into Instagram-scoped cookies, then independently checks the web bootstrap identity before saving them as the active session. It retains updated response cookies and the analytics claim. These are private account credentials; they are never included in command output or this repository.

## State and recovery

Pending state contains the code and RSA private key in a mode-0600 file inside a mode-0700 directory. Polling is serialized and limited to one request per five seconds. Waiting releases the state lock between polls.

Acquired credentials are saved before validation. If account validation fails, `auth poll` can retry validation without redeeming the nonce again. RSA keys are discarded before exchange; login state is removed after successful validation, cancellation, or expiry processing. Pending or failed requests never replace an existing session. If the exchange response is lost or the process crashes during exchange, the next poll reports `EXCHANGE_UNCERTAIN`; use `login --replace` for a fresh approval. The CLI does not automatically replay that exchange.

The local default deadline is ten minutes. Instagram controls server-side code and session lifetimes. Account restrictions, extra security challenges, or protocol changes can still require another approval or an implementation update. The live test establishes this flow for the tested account, not universal eligibility or support for every possible security challenge.

## Live verification: 2026-10-12

A new RSA key and code were generated using ordinary Node HTTP on the Linux ARM64 Orin, with DISPLAY and WAYLAND_DISPLAY unset. The user approved in Chrome on a separate Mac; the page displayed **“Success! You can now enjoy Instagram on your TV.”** The host received the first nonce, decrypted it with SHA-256, exchanged with a null second nonce, and obtained a fresh account session.

That session passed account validation, account search, content search (24 items), Explore (20 items), Explore continuation (18 items), and inbox summaries. The packaged CLI's recovery path then installed the freshly issued credentials and checked the same reads, including continuation pages for content search (24 items), Explore (18 items), and inbox (9 summaries). A separate empty state directory tested actual CLI code generation, pending polling, link reuse, and cancellation. The complete generation-to-exchange sequence was live-tested by protocol probes; the single user approval was reused for packaged CLI recovery and read checks rather than asking for another approval. Protocol and failure tests use synthetic cryptographic fixtures; all 27 automated tests passed on macOS and Linux ARM64.

## Earlier bounded leads

The phone app's `IGLoginGenerateCodeMutation` at `https://i.instagram.com/graphql/query` returned a null result in the tested anonymous requests. Website homepage QR metadata and shared QR refresh also returned null. Those observations describe those requests only. The independently recovered TV protocol above supersedes the earlier conclusion that a browser approval handoff had not been verified.

APKs, decompiled bytecode, complete analysis evidence, raw responses, keys, nonces, account data, and session files remain outside the public checkout.
