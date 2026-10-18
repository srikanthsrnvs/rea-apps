# Account authorization

Fresh native HTTP login was verified twice on the headless Orin on October 17, 2026: first with a private probe, then through the installed CLI. The flow uses Expedia’s email code, a genuine Arkose completion in the user’s Safari, and a small source-ported Linux Trust collector. Both attempts independently refreshed the resulting session and checked the account. No browser, Android runtime, extension or remote screen ran on the Orin.

See [CLI login instructions](../README.md#login), the [current protocol audit](protocol-audit.md) and [Trust protocol](trust-protocol.md). Rejected Android/remote-screen implementation files were archived outside this repository; they are not installed or shipped.

## Historical investigation

The notes below describe earlier observations and rejected approaches. Statements that fresh login was unavailable describe that earlier stage, not the current CLI.

## Established

- Anonymous flight search, fare selection and checkout preparation work through HTTP on Linux ARM64.
- The native form requires Trust and Arkose inputs. Earlier work had not yet recovered a portable Trust implementation or the official browser-widget completion handoff.
- A genuine Android 17 guest on the Orin completed Expedia's normal email/SMS sign-in inside a 1.9 GB container limit with host swap disabled. Native account membership and a session token were observed. Independent HTTP validation and repeated CLI session refreshes then succeeded with Android stopped. A separate clean factory install also booted and installed Expedia under a 1.85 GB container cap. See the [bounded runtime results](native-login-requirements.md#native-login-result-2026-10-15).
- The Android Naver flow uses PKCE and `/user/oidc/authenticate`; this is not evidence of a general Expedia consumer authorization endpoint.
- Ordinary sign-in at https://www.expedia.com/login authenticates that browser. No automatic CLI handoff has been established.
- Expedia's [published white-label OAuth documentation](https://developers.expediagroup.com/white-label-travel-platform/SSO/oauth-2) describes Expedia consuming a partner's identity-provider authorization, with preconfigured clients and redirects. It does not establish a public consumer-account grant for this CLI.

## Official account service

Expedia Group publishes [OpenID Connect metadata](https://accounts.expediagroup.com/.well-known/openid-configuration) and [OAuth authorization-server metadata](https://accounts.expediagroup.com/.well-known/oauth-authorization-server). Both were retrieved successfully on 2026-10-15. They advertise authorization-code grants, S256 PKCE, refresh tokens and public-client token authentication, with `/oidc/authorize` and `/oidc/token` endpoints.

Neither response advertises a registration endpoint or device-authorization endpoint; client-ID metadata documents are explicitly unsupported. A project client registration, approved callback and authorization usable by the flight API have not been established. The presence of public-client support alone does not authorize an arbitrary application or return URL.

The [native requirement audit](native-login-requirements.md) distinguishes Android runtime dependencies from an unproven physical-device requirement.

The native `OpenIdConnectInput` types were traced to social sign-in code exchange, including Naver. They do not establish an Expedia access-token-to-booking-session exchange.

## Historical runtime behavior (disabled)

The earlier runtime experiment provisioned a pinned Android guest and returned a link displaying its app screen. It is not exposed by the current CLI. The current installation uses Node HTTP and a short-lived verification tunnel, with no Python dispatcher or Android runtime. Fresh login is now implemented; the earlier runtime dispatcher has been removed.

The HTTP adapter retains the original app's device ID and records the actual guest origin, while its User-Agent explicitly identifies the Node CLI. A public app/version compatibility prefix is required by the observed endpoint. Both account IDs are serialized as strings, matching the shipped GraphQL scalar contract. HTTP 429 is surfaced without automatic retries; previous validated credentials remain intact if a new handoff fails.

This is a temporary original-app runtime, not a discovered browser OAuth/device grant. Runtime and remaining memory limits are documented separately.

## Open questions

Static tracing narrowed the additional candidates:

- MatchUserToken runs after the app checks that the user is authenticated, and validates an itinerary link against that account. Its validity response does not issue a session.
- Sign-in deep links pass login ingress/navigation metadata and a post-login URL. That is not evidence of an authorization code being sent to a separate host.
- OidcConsentForm takes an existing loginReferenceId. A producer usable by this CLI, a polling/token exchange and an external callback registration have not been established.

The checked device-code strings belonged to the bundled Facebook SDK; they did not establish an Expedia device-approval service.

Class or endpoint names alone are insufficient evidence of a working device authorization protocol. Those bounded negative findings did not prove that a portable flow was impossible. The implemented native email-code flow now supplies the required genuine verification inputs without a host browser.
