# API sources and handoff

Uses Quiltt's supported interfaces, checked on 2026-10-21:

- [Connector configuration, OTP, and Exit Redirect](https://www.quiltt.dev/connector)
- [Connector JavaScript API](https://www.quiltt.dev/connector/javascript)
- [Authentication scopes](https://www.quiltt.dev/authentication)
- [GraphQL endpoint and authentication](https://www.quiltt.dev/api/graphql)
- [Account fields](https://www.quiltt.dev/api/accounts)
- [Balance fields and sign convention](https://www.quiltt.dev/api/balances)
- [Transactions, filters and cursor pagination](https://www.quiltt.dev/api/transactions)
- [Current REST OpenAPI schema](https://api.quiltt.io/latest/rest.yaml)

The REST schema identifies `POST https://auth.quiltt.io/v1/introspect/api_key`
and `POST https://auth.quiltt.io/v1/introspect/session_token` as the current
credential checks. The older GET session endpoint is deprecated. GraphQL reads
use `POST https://api.quiltt.io/v1/graphql` with a Profile session Bearer token or
documented `Basic base64(profileId:API_KEY_SECRET)` server authorization.

The Connector SDK's public success callback exposes Profile/Connection metadata;
that metadata is not a secret credential or proof of ownership. This CLI uses
the documented **Exit Redirect with Send Token**, then verifies the genuine token
server-side. It never grants access just because a browser sent a Profile ID.

Official Connector HTML currently supplies `data-connector-id`,
`data-environment-id` and `data-environment-mode` on its root element. The CLI
fetches only the TLS-protected host derived from a validated Connector ID and
accepts SANDBOX mode only. It does not execute that HTML on the Orin. Token
introspection must confirm that same environment, and a separate GraphQL Profile
query must identify the same user. No unsigned JWT decoding grants access.

The private bootstrap link carries a random capability in its fragment. A
same-origin POST exchanges it for a Secure, HttpOnly, SameSite=Lax host cookie;
the browser then navigates to the official Connector. A callback without that
cookie cannot bind the Orin, even if it carries a valid unrelated token. The
cookie and callback are one-use and expire with the pending flow. Responses are
no-store/no-referrer; a successful callback redirects to a clean URL. Request
URLs and token-bearing callback parameters are never logged or journaled.

Quick Tunnels are for initial Sandbox testing. A stable reverse-proxy callback
avoids Dashboard changes when beginning later login flows. Quiltt's configured
redirect is Connector-wide; distributing separate devices will require a stable
shared callback service or separately managed Connector configuration. This has
not been represented as a completed multi-device production deployment.
