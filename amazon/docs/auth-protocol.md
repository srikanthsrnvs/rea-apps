# Native Amazon authentication protocol

The CLI uses Amazon's device code linking and native JSON token endpoints. Login runs over HTTP on Linux; the user approves a code on Amazon's website in their own browser. No Android runtime or server browser is needed by this protocol implementation. Successful code issuance alone is not proof of an authenticated shopping session.

A live test on the headless Orin completed this flow through the installed CLI: user approval on Amazon’s website, native device registration, five initial shopping cookies and independent native bearer refresh with truthful Linux metadata. A separate native cookie refresh also succeeded and returned seven shopping cookies, adding `session-token` and `session-id-time`. This verifies the tested account and current service behavior; it is not a guarantee for every account, region or future app version.

## Contract

`POST https://api.amazon.com/auth/create/codepair` supplies `code_data` with domain `Device`, application name/version, device type, independent device serial, model and OS. The response supplies `public_code`, `private_code`, `expires_in`, `polling_interval_in_seconds` and an optional `secureSessionToken`. The private code stays on the CLI host. The user enters the public code at [Amazon's device approval page](https://www.amazon.com/code).

After user approval, `POST /auth/register` supplies both codes under `auth_data.code_pair`, string `use_global_authentication: "true"`, registration domain `DeviceLegacy`, and the same device identity. It requests bearer, mac_dms, store authentication cookie and website cookies. Cookie domain is `.amazon.com`; extensions are device/customer info. A genuine secure session token is sent in `x-amzn-identity-secure-session-token` when Amazon issued one. The other identity header is `x-amzn-identity-auth-domain: api.amazon.com`.

A valid success is `response.success`, containing `customer_id`, `tokens.bearer` with access/refresh/expiry, optional `tokens.mac_dms`, native `tokens.website_cookies` and customer/device extensions. The CLI normalizes only first party Amazon cookies. It treats `response.error` and `response.challenge` as failures requiring further handling; an HTTP 401 does not imply a pending approval. Do not retry a successful or uncertain registration blindly.

Independent token validation/refresh uses `POST /auth/token`: `source_token_type: "refresh_token"`, the new refresh token, `requested_token_type: "access_token"`, app name, MAP software version and device metadata. The response requires bearer token type, new access token and expiry; optional refresh-token and secure-session-token rotations replace saved values only after validation.

Website-cookie renewal is a separate native form exchange. `refreshCookiesRequest` builds `/auth/token` with `encoding: "form"`, `requested_token_type: "auth_cookies"`, app name/MAP version, `di.sdk.version: "20260904N"`, domain and the refresh token. The transport must use form encoding rather than JSON and may supply its existing first party cookies. `parseCookiesRefreshResponse` reads `response.tokens.cookies` as a domain-to-cookie-array mapping, the optional service TTL, and a genuine root `secureSessionToken` rotation when present. The observed HTTP 200 format has root `secureSessionToken`, `response` and `request_id`; `response` contains `age_classification` and `tokens` with `ttl` and `cookies`. Native form cookie renewal has been live verified on the Orin. The parser returns credentials only to the private state lifecycle; public CLI output must omit them.

## Public constants and truthful device signals

The inspected app is `com.amazon.mShop.android.shopping`, version `32.18.0.100`, versionCode `1243240206`. Generic third party MAP device type is `A1MPSLFC7L5AFK`. MAP software version is `130050002`, distinct from the Shopping app version. These are public shipped client constants, not secrets.

The Android source supplies genuine Android build signals. The Linux implementation uses its own persistent random serial (32 hexadecimal characters, with UUID hyphens removed) and actual Linux model/OS, with `device_os_family: "linux"` during refresh. It does not copy a phone fingerprint or manufacture Android attestation. Acceptance of that platform must be established through live verification, not inferred from source reconstruction.

The native serial validator requires 1 to 51 alphanumeric characters. A hyphenated UUID is accepted by code issuance but rejected during device registration; never change the identity of an already issued pairing request.

## Evidence and limitations

Target base APK SHA256: `4dedce3983286cd19e990de172d3db1155f7d5eeba4c8b2746bf12c1bb1c0089`. REA/JADX observations:

| Contract | Evidence |
| --- | --- |
| Native code-pair create call | `ev_31cb9d14dabacdd5756e0e99947d3bd2b3383e0bccc26ecba34d709aa3fd298b` |
| Code data and response fields | `ev_1894ee774e7d59fb222eacd2a87f49dcd0a3070606177b8fc7534ce97e785c5b`, `ev_090f940212f272af7343c967e0efbd61db54893fd22cf5e6b3d91de8e568a89f` |
| Panda headers | `ev_1359d2f13939edd2b9ce05c86d92cd81fe52de7e0501e9be8bb12f4b85ab81fa` |
| Native serial validation / UUID fallback | `ev_d2958a4406427b13941f92ef260ef4109569cf9734a31c1ef5142f686a5e739f`, `ev_a70d8fd563bef78f0381e73a69c23c01706598f5ca6465e6ce63e8b8b69bef2c` |
| Generic device type | `ev_b13edc4abd3bc69dc13eb8fac3f1567b2d35872da5575e1151e3dbab4f72928b` |
| WITH_LINK_CODE registration dispatch | `ev_41cb5b514e379cb7c79afdad48f4173a859c8b4036bd53d440e47196ff22b070` |
| Registration transport/defaults | `ev_a7abd4e7f2057e4bbcb6893ad5eb507e948effabc2dd289eab2dde1b71ffb114` |
| Success envelope and tokens | `ev_ad5d0a4865c895f7912c45a83a9b99f3d08fac7151b4ca3c4460a15508684e4e`, `ev_d171957be14dc31f9220cd9d81a0a1d1d2db526e9775ac7d4704dca57321d8b0` |
| Cookie renewal fields | `ev_a720c8ececed17204d3e5a186e14caaedaf2f8bb389afcc410501977141e7bc3`, `ev_24fc1e90f1086f1842e62456325f3108e75bccf41352b7ed2cfb097ff430a8dd` |
| Native cookie mapping | `ev_283b52f5a43ea6f2910b6ded4f6c0fa9090be1109060815ddd2a971f23c0bd6c` |
| Refresh request/metadata/response | `ev_fe425c3eeee3e2d751fc5e0f14e62a51e30267ac84fab8b943db91590a0a7050`, `ev_d4b094fb47c547f90d0ffc7dbf3b7a3b954e34404ee1671453f154dbc1cc955d`, `ev_c421555db433e307cad1eb4c86e44dc34c700030a74ee9355f82a7a6adb73314` |

Cookie form field encoding was recovered directly in `wq.a` (`ev_e4e6a16866fc6091481431ff2635c3e8eca85a8a2fe6820f6e24c144d2c8818b`). The caller’s large overloaded method required supplemental DEX/smali inspection for Content-Type and the final query body.

JADX's fallback for `kcpsdk.auth.c.a` combines same-name overloads and REA correctly refused exact-method attribution. Supplemental offline DEX disassembly of exact descriptor `c.b()Lcom/amazon/identity/auth/device/fr;` established the registration JSON. DEX field values and constructor instructions established `.amazon.com` and software build `130050002`; REA's `h7` constructor view incorrectly lacked a body. Private raw artifacts and account data are excluded from the repository.

Amazon's code-page purpose is independently corroborated by [Amazon staff guidance](https://www.amazonforum.com/s/question/0D56Q0000DsjiX5SQI/where-do-i-enter-my-activation-code-to-register-my-device?language=en_US). Third party Login with Amazon `/auth/o2/create/codepair` is a different profile-scoped flow and is not substituted for native Shopping authorization.
