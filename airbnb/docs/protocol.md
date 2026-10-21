# Protocol evidence

Investigated artifact: `com.airbnb.android` version **26.42**, build **28026652**, base APK SHA-256 `cc74899171c8e84a2c4b6d5e0f307ccbbfbb5d61911fb3113250ca17217d07ad`. REA's JADX provider inspected the shipped artifact; no endpoint contract below was inferred from a browser session.

| Contract | Shipped method | REA evidence |
| --- | --- | --- |
| Production API host | `k04` constructor | `ev_683c811397516fa4a9e64d208aadf82fe645b204604ad1b8e7051d3e239b76f8` |
| Public application `client_id`, locale and currency query fields | `fe6.mo4109` | `ev_884870d9533e532b147a98c26e489e8ddb2506bac6b47cafb22fe8da2a536890` |
| Account OAuth token request header | `de6.mo4109` | `ev_d25cea6f7f81917be6d2cf06887b6d4f028d90941836c1f0dc4c4ef45088117a` |
| `/v3` GraphQL base | `re6.m49918` | `ev_a835fbade8faf247756db08312670f6042eab5d9690ed8d13acd60a6db3bce84` |
| GET variables and persisted-query extension | `jpc0.m31226` | `ev_1bd33b2c7770572e9d82c4cc2da970a48f83236dd417cb5f62d2489302d12b29` |
| Apollo operation headers | `jpc0.m31227` | `ev_6c42383e382b2a5286b0eb27136a682532ef91e5bce8769bae4e4cdcd6210a55` |
| POST fallback for long queries and mutations | `jpc0.m31228` | `ev_bdd8a6d4f68111b70dad262e6ebfa617c35089e577e04a9a219cb320e0bc5876` |
| Native flexible auth requests | `tl7.m54139` | `ev_eff9741b1ea5f488ccb717a98a3f8ee75c3c80b5cbd52f345322f65b6cf58620` |
| Account bootstrap operation name | `ofq0.name` | `ev_97000585190525693f40a93c2b02d64d71afe3ff1bc904dc299a589af40c927c` |
| Account bootstrap persisted hash | `w40` | `ev_31d7481517865ad93457d9811e88d38e4a7747b646b8754ef59dd32daf9c120f` |

Native GraphQL operation names, hashes and variable DTOs are recorded in `search-protocol.mjs` and `account-protocol.mjs`. They are versioned protocol constants, not user secrets. The CLI identifies itself as `rea-airbnb` and reports its actual Node/OS runtime. It does not synthesize Android integrity proofs.

Live Linux ARM64 checks on 2026-10-20 and 2026-10-21: destination search, two distinct pages of dated stay search, listing details and availability calendars; genuine browser verification, SMS receipt and native code verification; independent account validation and persistence across CLI processes; saved lists, trips, inbox and inbox search. Authenticated `stayCheckout` also returned a draft with an exact total, taxes, payment options and terms. Draft initialization did not place a reservation. Final booking and cancellation are source-backed and tested offline, with live final submission still unverified.

The source manifest was only partially returned by the parser. Negative conclusions about missing callbacks are limited to inspected handlers. The Apple callback is not a general-purpose browser-to-CLI OAuth redirect. No portable device-code flow or Airbnb refresh-token grant was established.

Raw REA records and captures live in the private investigation directory and are not distributed. Tests use synthetic data only.

## Search read summaries and source preservation

Search, listing, and calendar normalizers expose an additive `summary` for compact agent output. Existing `items`, `result`, `data`, `calendar`, and `raw` fields retain their original contracts; summaries do not mutate the native response. `sourceIndex` on a stay or destination summary points to its original item. Unknown native fields remain available in the source views. The CLI may display `summary` while retaining source views through `--raw`.

| Read | Summary fields and meaning |
| --- | --- |
| Destination suggestions | Display name, subtitle, opaque item ID, and the original `explore_search_params`. An item's opaque ID is not assumed to be a reusable `place_id`. |
| Stay search | Decimal listing ID decoded only from `StayListing`/`DemandStayListing` global IDs, title/name, location, localized rating, display-price text, and native card details. Property IDs are not substituted for listing IDs. `count` is the returned page size, not a result total. |
| Listing details | Native presentation title, capacity/overview, rating, preview amenities, rules, server cancellation text, selected-date price, and explicit `isAvailable`/`canInstantBook` flags. Missing values remain `null`; legacy section-only responses remain available with a partial summary. |
| Calendar | Month/day dates, explicit availability/check-in/check-out/bookable flags, min/max nights, and condition ranges. Unknown flags remain `null`, distinct from `false`. Adjacent condition ranges are combined only when all their conditions match; future condition fields are retained. |

Prices remain Airbnb's localized display strings. The CLI does not parse a total into a nightly amount, infer a currency from a symbol, calculate a refund, or infer that a full stay can be booked from individual available days. Listing pricing and availability describe the response's selected dates and context; they are not a checkout commitment.

The native result topology is corroborated by `xuo1`/`wuo1`/`vuo1`/`gvo1`/`muo1` adapters (REA `ev_9ae8df07900b5bd5a78101f3d75b21c97569ad0d3949bd22d81e436fc6b2c539`, `ev_bc6fda506fb3ab5b3a969e1ced709e6054f6e3a287f8cb0423d9aab41f6597cb`, `ev_1986d4efb9ba3b37d8be7a91883e6f09fda315ecadf3f59eab88f36fe4bc08ba`, `ev_1befa62d5e66a15e5b9b54d26057ad4cb3839633bb084abba78d88d29eea5cfa`, `ev_e28a364cd8d650b0b701b34af05652b5027681bf327545d098183d2a6f7f50ac`). Modern detail roots are in `ilo1`/`noo1` (`ev_301032882b43566678d6fdcce5c141a3ac7783141f400eeb5482c29c8e48a5da`, `ev_bef9eaa543589f0909b29e182d811f5640f907d2727bc091d870c08f3a9d61bf`); calendar `pdpAvailabilityCalendar` is in `j411` (`ev_0000d9f8a126ddd615869d5bfd6a16c464d17352d7108ddf19ea293c5057282b`). Field extraction was checked offline against retained anonymous search/page-two/detail/calendar responses from the verified HTTP operations. These captures remain private and are not test fixtures in the repository.

### Continuations and validation

`normalizeStaysSearch` preserves native opaque cursors. The stateful `searchStays` wrapper replaces them with opaque `rea-airbnb:` continuation tokens that retain the original query, dates, guests, and filters for one hour. Use the returned `nextCursor`/`previousCursor` or the same fields in `summary` to continue. `sourceCursors` and the native pagination fields preserve the backend tokens for inspection; they are not standalone CLI continuation tokens.

Equivalent numeric input forms, repeated effective defaults, and filter-object key order do not change a continuation. A changed effective filter, expired/incomplete saved context, or unreadable token fails before a request. The saved context is snapshotted before the request, so later caller mutation cannot change its meaning.

Known values copied through `filters`/`rawParams` receive the same date, guest, price, currency, count, and coordinate checks as explicit options. Unknown server-defined filters are preserved. Explicit options take precedence, and the effective currency is also supplied to transport. Unsupported response shapes and GraphQL errors retain the original payload on the thrown error rather than returning invented empty success.
