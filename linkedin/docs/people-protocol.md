# LinkedIn people search and profiles

Scope: people search, pagination, profile details and optional contact information. No feed or post requests. The request builders were recovered statically from LinkedIn Android 4.1.1261, version code 216900, APK SHA-256 `60e4a43691c6440c641707edd3e3201e0dd46eeba9e0363fe99945c84fe4ba4c` using REA/JADX. Static contracts do not establish that a particular signed-in account can access these endpoints. Live verification is a separate step.

## Request contracts

All requests below use the parent transport's `client.graphql({queryId, queryName, variables, field})`. Native query names are `SearchClusterCollection`, `FullProfileWithEntitiesV2`, `FullProfileByMemberIdentity`, and `ProfileContactInfoById` respectively. This module does not select a hostname, cookies, tokens, headers, or implement authentication.

| Read | Query ID | Variables | Response field |
| --- | --- | --- | --- |
| People search | `voyagerSearchDashClusters.c2c5d4b012c05a6a94396191208d45f6` | `query`, `count`, `start`, optional `origin`, `paginationToken` | `searchDashClustersByAll` |
| Full profile by URN | `voyagerIdentityDashProfiles.069e83ac4609b7ab20a7240204e1ce8c` | `profileUrn` | `identityDashProfilesById` |
| Full profile by identifier | `voyagerIdentityDashProfiles.1adcc390339f2f37e7c8904f6f52a164` | `memberIdentity` | `identityDashProfilesByMemberIdentity` |
| Profile contact information | `voyagerIdentityDashProfiles.8aa5843dfcd1e81a06db3a87fb2e0c20` | `profileUrn` | `identityDashProfilesById` |

Search query input includes `flagshipSearchIntent: SEARCH_SRP`, keywords, spell correction and `queryParameters`. Internally the native search framework uses a filter map selecting `resultType: [PEOPLE]`. The live GraphQL schema requires this map as entries: `queryParameters: [{key: "resultType", value: ["PEOPLE"]}, ...]`. The CLI converts the filter map at the request boundary. Filter values are lists of strings. Recognized native filter names include `network`, `geoUrn`, `currentCompany`, `pastCompany`, `schoolFilter`, `industry`, `profileLanguage`, `firstName`, `lastName`, `company`, `title`, `connectionOf`, `followerOf`, `talksAbout`, `serviceCategory`, `schoolFreetext`, `eventAttending`, `contactInterest`, and `activelyHiringForJobTitles`. Network values remain native values; this module does not claim an unverified mapping from friendly connection degrees.

The native framework retains `metadata.paginationToken`, `searchId`, `primaryResultType`, and `bserpPaginationContext`. Subsequent requests pass the token, put searchId/primaryResultType in queryParameters, and retain the context's clusterPosition/itemPosition. The CLI cursor binds these values to the original keywords, filters and page size. Reusing a cursor with a different search fails before making a request.

## Response projection

The search collection contains SearchClusterViewModel records, with items/results containing SearchItem union values. EntityResultViewModel carries title, primarySubtitle, secondarySubtitle, summary, navigationUrl, entityUrn and target. A target's profile union identifies the actual Profile. Normalized responses can refer to `included` records through `*field` references. The decoder follows explicit references from the requested collection; it does not scan all included profiles as search results.

Results preserve the returned profile URN, public identifier and search-result URN as separate fields. A search-result URN is not a messaging recipient. The messaging module receives only the returned profile identity and must resolve any required messaging-specific identifier using its own contract. No identity is invented by extracting a base64-like suffix from a search-result URN.

Profile normalization returns identity, name, headline, summary, location and available profile section collections. Contact details require an explicit `contactInfo` request and remain subject to LinkedIn's visibility rules. Unrelated included profiles, tracking fields and viewer state are excluded. Unsupported response shapes fail explicitly.

A usable primary profile can arrive with a nested `DataFetchingException` for an optional field such as `profileRingStatusCollection`. Profile reads allow the transport's narrowly checked partial-data policy and report sanitized `warnings`/`unavailableSections`; they do not discard the usable profile or expose server error messages. Validation, authentication, top-level failures and missing primary profiles remain errors.

## Live wire correction

On October 15, 2026, authenticated native HTTP search rejected the original map encoding with a GraphQL ValidationError: `resultType` was not a field of `dash_search_SearchQueryQueryParametersInput`. A paired read with the same search and entry-list encoding returned HTTP 200 with five actual people, total 250, and paging count 5. The retained private wire records are `live/search-wire.json` and `live/search-list-input-raw.json`. Offline replay of the latter through this module returns all five results.

This is an observed adaptation to the live GraphQL schema. It is not described as the shipped legacy encoder's behavior: REA traces of `DataEncoder`, `AbstractDataProcessor`, `RawDataProcessorUtil`, `Query.setVariable` and the generated `SearchQueryForInput` show ordinary map serialization. Those static observations alone did not establish a working current request.

The live search returned null target profiles but usable LinkedIn profile URLs. In that case, results preserve `publicIdentifier` and leave `profileUrn`/`recipient` null. A profile finder read resolves the actual identity before messaging. The CLI does not manufacture a profile URN from a tracking member ID or encoded search-result identifier. Missing pagination tokens do not prevent pagination when paging/total establish another page; the cursor retains searchId and primaryResultType.

## Source evidence

The retained evidence and original APK remain outside the repository under the user's private investigation directory.

- `SearchGraphQLClient.searchClusterCollection`: REA `ev_9a27b661ee3d9a1ecd51dab8070d8a2c152fd3b82730058954941f5412c11276`.
- `SearchFrameworkRepositoryImpl.fetchSearchResults`: REA `ev_1995903865510a76ff7bc522fc86cc2d185885e9f7eab40325ddcc4937118fae`.
- `SearchFrameworkUtils.getSearchQuery`: REA `ev_2f1d60b5e8da39a5863242f4b4a871e0f80be4e5e19a8ba4626fa9ab912f92fe`.
- `SearchFrameworkUtils.getQueryParams`: REA `ev_bf37e664a32445fddcf29399349da4aecc7d3dbc314bd6057cfac6a1283a8520`.
- The legacy serialization limitation is grounded in `DataEncoder.startMap` (`ev_3893fa76849ca03b7ed81d81a4954cdb2eddb47db4b1d1362658255481650e6e`), `DataEncoder.processMapKey` (`ev_5f193c6100f64af46341b9dbf251e9fb9f7059b123d74339b2e5d770ba6ffc12`), `RawDataProcessorUtil.processMap` (`ev_b3d3b6639ed5d9591764ef3628b9cc354f5701b40e32355a75bf6fb3b97f40ed`), generated search input accept (`ev_b69e7d34734fddb84ee85e60a7dfba1be0753907134ffc7fcf44100d033be959`), and direct `Query.setVariable` put (`ev_828352fa21acf5c6b71a4604eb1fe7981f979dd8d83f0c737117510eabdac439`).
- `ProfileGraphQLClient.fullProfileWithEntitiesV2`: REA `ev_85ca9e255000453b39ae9e9685ca7c0215555f9073a05f64f3a0eaad934e7d6f`.
- `ProfileRepositoryImpl.AnonymousClass7.getDataManagerRequest`: REA `ev_761dc53939cd44d21f64152a5cf2d2d2780eff9069460bf4c5a48ce35b445716`.
- `SearchUrlMappingImpl.neptuneSearchResultsPeople`: REA `ev_8d4b6738134f08985a9cbcb895d704b65d40667ff008cc84d4812c2b92dcf3d8`, confirming native filter names and the experiment-dependent SDUI navigation branch. Its M1/M2 strings are experiment treatments, not network degree values.
- `SearchItemUnionBuilder.build` and static initializer: REA `ev_a69c87236eaf25e809ca00f6048e7683fa5c326a21177a1c3f19f5a899ad92b0` and `ev_cfb21ac8e37d660b93fb553cc37320dcd8dc35f86c007a2183fbd5d561bf9ed4`, confirming the `entityResult` and `cluster` union wire keys. The initializer was returned as Smali rather than Java.
- `EntityTargetUrnUnionBuilder` static initializer: REA `ev_6b480b9a75e90306d58ee45c2bdc88db7aba8aeb00cec5c2aa6f47a8a418ae5f` maps the target union's wire key `profile` to its native field ordinal. This grounds the result-to-profile identity join.
- `ProfileContactInfoRepository.AnonymousClass1.getDataManagerRequest`: REA `ev_1733ab6da0d826a98beaea329954e51f803b06dbb607ed9dc155675027c281ae` confirms the contact query ID, `ProfileContactInfoById` query name, BATCH_GET operation, `profileUrn` variable, and `identityDashProfilesById` response field. An independent source branch fetches member handles with visibility restrictions; it is not part of this module's contact projection.
- Search/profile/union field inventories: direct DEX field tables, retained `people/model-fields.json` and `people/union-fields.json`. Candidate string extraction is a lead; only REA method bodies above establish call relationships.

Tests use constructed, source-shaped fixtures to verify explicit joins, separation of profile/result identities, cursor continuity, filtering, privacy projection, and invalid input failures. These tests do not prove account authentication, service availability, current query-ID acceptance or messaging eligibility.
