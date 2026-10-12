# Search, Explore, and Reels protocol investigation

The runtime uses the separately verified [website protocol](web-protocol.md). This document records Android evidence, whose endpoints and pagination are not the runtime contract.

These findings are static observations from the installed Android app, version
450.0.0.50.77. They establish what this APK builds and parses; they do not establish
that a browser-derived session can call every native endpoint. Live checks belong
in the CLI validation record. Raw decompiled code and account data remain in the
private investigation directory, outside this repository.

Artifact SHA-256: `9f9712803a1563da73267832aa402c9d4b37a5192cf99639a1a81c9c31394435`.
Package identity evidence:
`ev_90bab39efb908fe4ab3ee53d61ca53d8654a29bcba4b73203e3e7fc564201495`.

## Explore grid

`X.C0CW4.A0A` and `X.C0E8X.A03` select `discover/topical_explore/`
and pass the route into `X.C044D.A00`. The latter selects GET. The shared request
builder uses relative native API paths; the native prefix is `/api/v1/`.

Evidence:
`ev_ca1539823f30b3b7517ba38245a3e7ed70594ca05b2d8345dda07653ff84be51`,
`ev_ee1e385fa86e867d90d0ea8c711dabbc4a8896a1ac55d956543b3bed824bd84f`,
`ev_c2a7a4f9da0d111ad1d29a713972a23c9597860eb41fb2bacdccc8cec310f8d2`.
The integer HTTP-method mapping is corroborated by `X.C03tb.A00`:
`ev_a6a26f8129236c8f207a85326214c2facc1dc34aa1fcf4e50c0140270fe67694`.

Explicit builder parameters:

| Parameter | APK behavior |
| --- | --- |
| `max_id` | Added when a continuation ID exists; helper `X.C0CCl.A04`. |
| `session_paging_token` | Opaque session continuation string supplied by the caller. |
| `paging_token` | Caller-supplied position context; the grid caller constructs JSON containing `total_num_items` and, when available, `last_non_organic_item`. |
| `module` | Caller-supplied surface identifier. |
| `reels_configuration` | Literal `hide_hero`. |
| `timezone_offset` | Client timezone offset. |
| `is_prefetch` | Literal string `true` or `false`, depending on request mode. |
| `is_ptr` | Pull-to-refresh flag. |
| `is_auto_refresh` | Auto-refresh flag. |
| `is_nonpersonalized_explore` | Optional boolean for selected feed variant. |
| `enable_adaptive_grid` | Optional boolean. |
| `cluster_id` | Optional topic cluster; omitted for the fresh request variant. |
| `thread_id` | Optional alternate reshare-suggestion context. |
| `lat`, `lng` | Added only when the app has a recent eligible location. |

The app also adds feature-dependent maps, integrity/location metadata, and one
obfuscated parameter key. These are not proof that every field is server-required.
The documented minimal request must be live-tested before being described as
supported. Do not fabricate device, location, or integrity state.

Max-ID helper evidence:
`ev_8c50c3993a647715ff3063ae8329f33f3b55e7bfbf7e38bc0e25d4e00fb5a4c7`.

`X.C018T.unsafeParseFromJson` parses the top-level grid as:

- `sectional_items`: array of sections.
- `next_max_id`: continuation string.
- `more_available`: boolean.
- `session_paging_token`: continuation session state.
- `auto_load_more_enabled`: UI hint.
- Additional clusters, interests, and overlay information.

Evidence: `ev_d2c31dccf81a54b38444fb252ae378841f20160b81cd7feca8076ea2d49abc8a`.

A CLI cursor should preserve both the server continuation ID and the session
paging token, bind them to this account/surface, and return a terminal state when
the server says no more content is available. A server cursor does not guarantee
an infinite supply of unique content. Repeated IDs should be deduplicated; repeated
cursors and empty pages must not result in an unbounded request loop.

## Flattening the mixed grid

`X.C09CT.unsafeParseFromJson` parses each section's `layout_type`,
`layout_content`, and `explore_item_info`.
Evidence: `ev_3658e6670dc62a4ac4961f57f30a2d570379341a810221926910c02b37d67548`.

`X.C09Cl.unsafeParseFromJson` accepts media wrappers in all of these layout slots:

- Arrays: `medias`, `fill_items`, `one_by_two_items`.
- Single items: `full_item`, `one_by_two_item`, `two_by_two_item`,
  `two_by_three_item`, `three_by_four_item`, `tray_item`, `contextual_item`,
  `two_by_two_ad_item`.
- Nested sections: `nested_sections` and `fallback_section`.

It also parses `ad_item`, tabs, and an obfuscated collection field. Preserve layout
and sponsorship metadata while turning media-bearing entries into a list; an
unknown layout should remain visible in raw output rather than silently becoming
an invented media item.
Evidence: `ev_73810f7cbc937270d02e24a045eaaec147aabc0d9bf32f9bb4cd3a3105e251ca`.

The shared wrapper parser, `X.C09DP.unsafeParseFromJson`, recognizes `media`,
`media_or_ad`, and `clips`, as well as non-media account recommendations, channels,
shopping, and keyword recommendations. Therefore a recursive search for anything
named `id` would incorrectly include users, ads, and recommendation IDs. Flatten
only known media carriers and retain a stable media `pk`/`id` as a string.
Evidence: `ev_24616e9c19c0725000e08041391a74aa4aa5df8db66eab8e8bddf932d49bb47a`.

`X.C09DS.unsafeParseFromJson` establishes that `clips` contains an `items` array,
`max_id`, `more_available`, `id`, `type`, `content_source`, and optional chaining
information. Its own `id` identifies the clips collection, not an individual media
item. Each entry in `clips.items` is delegated to `X.C01DI`; the exact item wrapper
still requires that decoder or a live response. Never flatten the collection ID
as a post ID. Signed media URLs can expire; media IDs and shortcodes should remain
the durable output references.
Evidence: `ev_0f1cfa2f01800d883641e08a1ac19aba84adc9eb83deb98884cf822bc94c26b3`.

## Search content and keyword Reels

The APK includes `fbsearch/non_profiled_serp/` with the surface `popular_serp`,
selected by `X.C0I3X.invoke`, and `fbsearch/top_serp_stream/` with `top_serp`,
selected by `X.C0TPn`'s constructor. Both pass through the shared search request
builder below. Stream response framing is not established by the constructor.
Evidence:
`ev_3f304f0c9fa67e9faf90961819b397db172975abfeb7e2736444dd615791fc44`,
`ev_81197436bc1929a02b88e233d4fbbb81fdb1303d807a74093e9970913643830f`.

`X.C0ZDa.DdH` builds a tail request to `clips/keyword/`, supplying:

| Parameter | Meaning established by the caller |
| --- | --- |
| `keyword` | Requested search text. |
| `max_id` | Tail continuation cursor. |
| `rank_token` | Optional value from the current search context. |
| `reels_page_index` | Explicit or search-context page-index string. |

`X.C0BRC.A0L` establishes that this request uses POST.
Evidence:
`ev_694b0608ac87595181bb5f88dfa8ecc1e18c30765605bdad46c25bfd6af4cd4a`,
`ev_77b2001e742cd83a49b47ed68e80a6a62bbccc538dc678985bfe568ca678fb4b`.

Search request preparation (`X.C0XLk.A00`) constructs a `X.C0VLh` data object,
and `X.C0I9s.invoke` sends it through `X.C0YCm.A01`. The latter establishes GET
and these exact wire fields:

| Parameter | APK behavior |
| --- | --- |
| `query` | Search text. |
| `count` | Requested count; the preparation function defaults to 30. |
| `search_session_id`, `serp_session_id` | Search and result-session identifiers supplied by the caller. |
| `search_surface` | The selected surface, including `popular_serp` or `top_serp`. |
| `serp_origination`, `session_state`, `keyword_context` | Lowercase representations of the origination context; the builder emits `null` as text if absent. |
| `rank_token` | Optional ranking continuation. |
| `next_max_id`, `page_token` | Both receive the same optional search continuation string. |
| `page_index` | Sent when nonzero. |
| `reels_max_id`, `reels_page_index`, `has_more_reels` | Optional independent Reels continuation state. |
| `paging_token` | Optional paging context. |
| `lat`, `lng` | Optional verified location fields. |
| `nav_chain` | Application navigation context. |

It also includes `enable_metadata`, `disable_ads`, `grid_column_count`, optional
lightweight-query feature flags, displaced organic media IDs, seed/post IDs,
`cdd_ranking_token`, and an obfuscated key. These fields describe the APK's builder;
server-required minimums and session eligibility remain unverified.
Evidence: `ev_447a9bc92ff68eccdbcaf0f194b4f3653cbca638ffa87492cd7acfec64ca8940`.
Evidence:
`ev_9a5d5de9027ba02c72a5bf5c9ccb0092a8a5985cfe4023a3a9b1c4b8a4c3bf6b`,
`ev_dbeb1122307e9f6930b615f3db83e99562643dff7a51fe1a492e96dfeae2761f`.

## Remaining validation

Explore request selection, pagination fields, and mixed-layout carriers are
established statically. Keyword Reels tail request fields and verb, shared search
wire parameters, and clips-collection pagination are established statically.
Clips per-item decoding, stream framing, server eligibility, and browser-cookie
compatibility require the focused continuation or live validation. No home feed, publishing, follow, like, or view-state mutation
is required to build the requested list and pagination interface.
