# Native transport evidence

Target: `com.linkedin.android` 4.1.1261 (216900), base APK SHA-256 `60e4a43691c6440c641707edd3e3201e0dd46eeba9e0363fe99945c84fe4ba4c`.

`GraphQLQueryRequestBuilder.fillInQueryParams` supplies `queryId`, `queryName`, and Rest.li `DataEncoder` variables (protocol version 3 encoder path). REA evidence `ev_6393212ff99b5b1543b6347f3f47e00cbba9347ca59957643edbc0094745444e`. The CLI escapes scalar values separately from structural map/list punctuation. It preserves the normalized response envelope and its `included` entity table.

`NetworkClientConfigurator.configure` sets `X-RestLi-Protocol-Version: 2.0.0`, REA evidence `ev_4619c9b8941ce399db2849822782fffba1ed90a04d25e28a9485c374df3229d6`. `CsrfCookieHelper` reads or creates `JSESSIONID`; its method inventory is `ev_5ba0af4efd6a4fd815a5b0eca2b5c0d81aad890fc8f9377abb25430cc6124a2a`, corroborated by exact DEX instructions. The CLI sends an unquoted CSRF header while retaining the cookie's original wire value.

Supplemental exact DEX instruction inspection of `BaseGraphQLClient`, `GraphQLQueryRequestBuilder`, the GraphQL route supplier, `FlagshipSharedPreferences`, and `HeaderUtil` established the composed host/route, HTTP GET query encoding, installation identifier header, and cookie logic. These observations are static; no native runtime packet capture is claimed.

`MemberUtilImpl.loadMeFromNetwork` uses persisted query `voyagerIdentityDashProfiles.7186fe864099dc0343c4b65e736363e9`, query name `ProfilesByMe`, field `identityDashProfilesByMe`, and no variables. The CLI requires a returned authenticated `fsd_profile` identity before saving a session. `VoyagerMailboxConfigProviderImpl` uses that profile identity as mailbox owner (see inbox evidence).

HTTP commands restrict credentials to the fixed official HTTPS origin, retain scoped cookie updates, refuse redirects, bound responses/timeouts, and do not retry mutations. They never return raw failed response bodies containing account data or session tokens. Native request construction has local coverage; authenticated server compatibility remains unverified until login succeeds.
