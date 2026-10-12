# Protocol evidence and coverage

This document records the Android investigation. The implemented CLI uses a saved **website cookie session**, homepage bootstrap, website REST, and read-only GraphQL; see [the live web protocol](web-protocol.md). Browser approval is the initial authentication step; Android is an investigation source, not a runtime dependency. Mobile bearer tokens, Android device attestation, and a fully terminal-only first login are not implemented.

The installed Android artifact examined was `com.instagram.android` version `450.0.0.50.77`, base APK SHA-256 `9f9712803a1563da73267832aa402c9d4b37a5192cf99639a1a81c9c31394435`. REA/JADX recovered the request factories below. These are static observations of the shipped Android program, not proof that its endpoints accept a website session. APKs, decompiled code, account cookies, and full investigation evidence are kept outside this public repository.

## Endpoint evidence

Paths in this table are relative to `/api/v1/`.

| Capability | Observed native method/path | Factory and fields | Website-session status |
| --- | --- | --- | --- |
| Current account | GET `accounts/current_user/` | `X.C0MJU.A04`: `edit=true`; helper `X.C022R.A0K` selects GET | An anonymous request returned JSON HTTP401 `require_login`; authenticated validation is a separate step |
| Profile by numeric user ID | GET `users/{id}/info/` | `X.C01Oo.A02`: fills `users/%s/info/` with the user ID and schedules response handling | Native request construction established; authenticated website compatibility requires testing |
| Profile by username | Candidate `users/{username}/usernameinfo/` | String-decoder case2315; candidate callers `com.instagram.repository.user.UserNetworkDataSource.A00/A02`; direct literal also used by raw `LX/01Oo;.A03` | Factory body and website compatibility remain unresolved |
| Search accounts | GET `users/search/` | `X.C0YDj.A02`: `q`, `count`, `search_surface`, optional `lat/lng`, `rank_token`, `page_token`, and `return_unconnected_private=true` | Native construction established; website compatibility and response pagination require testing |
| Media detail | GET `media/{id}/info/` | `X.C0CCl.A00`: URI-encodes the supplied media identifier | Native construction established; website compatibility requires testing |
| Home timeline | **POST** `feed/timeline/` | `X.C02oo.A01`, delegated parameters in `X.C02wt.A01`; details below | Android construction established; a website session may need a different request. Do not substitute GET merely because this reads a feed |
| Profile posts | Unresolved | No `feed/user/%s/` literal was found in the DEX string pool. Computed paths, GraphQL, and native implementations remain possible | Not established by this scan |

The account-search factory also has optional `sponsor_profile_only`, `branded_content_creator_only`, and `audio_cluster_id_for_coauthoring_check` fields. Another optional field key is obtained through `C0C3B.A00(107)` and was not resolved. Response shapes and cursor semantics must be confirmed from server responses before exposing normalized pagination.

## HTTP method mapping

`X.C03tb.A00(Integer)` maps `1` to POST, `2` to PATCH, `3` to GET, `4` to DELETE, and other values to HEAD. The DEX static initializer for raw `LX/0009;` assigns `A01=1` and `A0N=3`.

Profile and media factories select `AnonymousClass0009.A0N`. Search helper `X.AnonymousClass0223.A1W` and current-account helper `X.C022R.A0K` select the same value. The timeline factory selects `A01`.

The generic mobile builder `X.C02Za.A03` was recovered as complete smali because JADX's Java reconstruction produced an anti-decompile stub. Its GET/DELETE branches encode parameters in the URL; its POST branch creates a body. It chooses `/api/v1/` or `/api/v2/` based on request configuration. Its Android header branches are not the website header contract.

## Mobile timeline request fields

`X.C02wt.A01` shows the app inserting these fields into the native timeline request:

- `client_recorded_request_time_ms`: current client time in milliseconds.
- `request_id`: request context value.
- `reason`: native request-reason enum string.
- `is_pull_to_refresh`: string flag derived from that reason.
- `bloks_versioning_id`: the version-specific Bloks hash shipped in this APK.
- `include_attribution_ui_data=true`.
- `timezone_offset`: the device's offset value.
- `has_camera_permission`: native permission-derived string flag.

Two additional fields use decoded keys from `AnonymousClass0259.A05(...)`; their names remain unresolved. Other fields and headers vary with configuration and request state: `pagination_source`, `max_id`, `is_prefetch`, `last_head_load_time_ms`, `feed_view_info`, cached/seen media IDs, hoisted media IDs, feed interaction summaries, ad state, personalization flags, and app timing. `max_id` is inserted only when the request context contains a cursor. Ads-related fields are also added by `X.C02oo.A00`.

These are **observed app-inserted fields**, not a proven minimum required by the server. No successful website-cookie timeline request or minimal POST body has been established by this offline analysis. Some Java reconstruction paths contain JADX warnings, so configuration-dependent branches should be checked against smali or runtime evidence before reproducing them.

## Website authentication and transport

The website session stores Instagram-scoped cookies privately. The HTTP client sends a cookie header, the approved browser's user agent, an Instagram referer, JSON accept header, website application ID, request marker, the current website claim, and CSRF token when available. Response cookies and `x-ig-set-www-claim` are retained for later calls. These website values must be grounded in the browser bootstrap and validated independently of the Android factories.

The CLI reports expired sessions, security challenges, and rate limits explicitly. Security checks are completed through Instagram's normal approval flow. Requests are not automatically replayed after a challenge or a rate-limit response.

## Evidence index

These REA IDs refer to private retained evidence, with source code kept outside the repo. Exact raw DEX method IDs, bounds, and decoder offsets are recorded in the private investigation ledger.

| Finding | REA evidence ID |
| --- | --- |
| Current-account factory | `ev_a46a07e2a5366730121fdacd10483e274aab4bf99d2e8aa57ba7431405ec320b` |
| Current-account GET helper | `ev_b2214db053231af5512a98171fdcc93cca68e4e8b86a5a5dcd5618c62748da04` |
| Numeric profile factory | `ev_da4f32f45382117a89e99862c46ad4a1df95a8ba2bd914521e1a9f5cb31d73e5` |
| Account search | `ev_aff19659c0e6ef2620da57879b81c0156aa80ce4010e06fedec744d5c13ca430` |
| Search GET helper | `ev_346328628bc63e1e88fc885b95b9098ec2b158efc89a6e0a3baa378e216d82fc` |
| Media detail | `ev_291f9c5d92264f84d8527181500060c5841b6f3dccc700328306ea1df7f14357` |
| Timeline factory | `ev_2b563700b7375141c11460fdfca3d795ec905057a90bbf215f148d2fa2b8f6b8` |
| Timeline parameters | `ev_ddc04a0e55468e00488ebe045d86bdb8398d2d5e1797b0d8c0804aafd8b6df5e` |
| Timeline optional ad fields | `ev_6d818e4f1bc638a6f4cf3ef090fda89d70fed137b294f5ce4dc2bb480e8ad68a` |
| HTTP method labels | `ev_a6a26f8129236c8f207a85326214c2facc1dc34aa1fcf4e50c0140270fe67694` |
| Generic mobile HTTP builder, smali fallback | `ev_0e6245792bc9ea8c860e8f239dc0320882729fc2daf521c298b960b3675223ae` |

The table above concerns native Android factories. Website runtime operations were separately verified through live HTTP requests; see the web protocol document. Static evidence alone does not establish runtime compatibility.
