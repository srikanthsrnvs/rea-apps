# Instacart catalog protocol

Investigated the installed customer app `com.instacart.client`, version 9.39.2. The base APK SHA-256 is `f6e451263f43a1169aab0319244b17d77c7ace598f5666cb3a61da60d0d50dd1`. APKs and complete REA records stay outside the repository.

## Observed contracts

The native app embeds Apollo GraphQL documents. The server accepts their registered SHA-256 APQ hashes; the client must preserve the entire document exactly, including whitespace and fragments. The runtime sends the operation name, variables and persisted-query extension. It does not submit a shortened query or run an Android app.

| Operation | Variables used by this CLI | Result |
| --- | --- | --- |
| `UserAddresses` | None | Saved addresses, coordinates and zone IDs |
| `ShopCollectionUnscoped` | Postal code, latitude/longitude, optional address ID | Serviceable shops with distinct shop, retailer and location IDs |
| `ShopCollectionScoped` | Same location context plus retailer IDs | Shops for selected retailers |
| `Shop` | Shop ID | Store metadata and service type |
| `SearchItems` | Shop ID, postal code, query, search source and include-ads option | Ranked item IDs and first 20 hydrated items |
| `Items` | Item IDs, optional shop; optional complete shop/zone/postal price context | Hydrated product records |
| `ItemDetail` | Shop ID and item ID | Product detail sections and share URL |
| `ItemPrices` | Shop ID, zone ID, postal code, item IDs | Current price descriptions and promotions |
| `SearchFacets` | Shop ID, postal code, query, existing filters | Available filter choices |

Store search and service filtering happen locally over the returned serviceable shop collection. Pickup and delivery remain separate shop IDs. Do not reuse an item or price from another shop merely because the retailer name matches.

### Pagination

`SearchItems` does not expose an `after` argument. Its result contains the ranked `itemIds` list and initially hydrates 20 items. The CLI takes successive slices of that list and hydrates later pages with the native `Items` operation. Its opaque cursor contains the ID snapshot and a search-context fingerprint, expires after 30 minutes, and must be reused with the same shop, query, postal code, zone and ads setting. Missing or newly unavailable item IDs are reported instead of being silently replaced. This preserves one search's ranking; refresh the search to get updated ranking.

## Evidence ledger

| Finding | Evidence | Type and remaining limits |
| --- | --- | --- |
| Native search document and fields | `ev_183cd4f022dfef6637ecdeebbc0d00f0b1caabdf1cc36264d10ca02ce033cfe7`, `tj2.p.document()` | Static REA method decompilation; does not establish account access |
| Native search variable serialization | `ev_4ba0851993843893b7a1a3512db6c04937598883f66fd9c3f447159d085c54c7`, `tj2.p.serializeVariables()` | Static REA method; `SearchSearchOptions` includes ads and excluded product IDs |
| Search data source invokes that operation | `ev_1da542a982157c650b4a5c601826dd3d91fab18298d986986d90bfdde241ceab`, `ICSearchItemDataSourceImpl.config()` | Static REA call site |
| Store collection document | `ev_a986f73dda488e4ffbc95261cc4c813fc2f9590f153fc39500dae0de7bfe66da`, `yk2.v0.document()` | Static REA method; corroborated with successful live request |
| Product detail document | `ev_b2f057b0c2656b45981c266cab4838094f730f171bb32451af70affb8f8a4534`, `xe1.p1.document()` | Static REA method |
| Later-page item hydration document | `ev_39c71a3fed4b95a1628472f3dce0f2535b6c2c15c7a57ddfd58e4d7f53723cd8`, `xe1.r2.document()` | Static REA method |
| Serviceable store discovery | Live HTTP, October 29, 2026: `ShopCollectionUnscoped`, postal code 90291 and Venice coordinates returned HTTP 200 and local stores | Direct HTTP, anonymous; does not prove authenticated shopping |
| Authentication required for native item search | Same live probe: `SearchItems` returned HTTP 401 `Not Authenticated` | Direct HTTP, anonymous; an authenticated session remains necessary |
| Authenticated catalog access | Live HTTP, October 29, 2026 after native phone-code login: saved addresses, search, item hydration, item details and current prices all returned HTTP 200 | Direct HTTP with the CLI's session; no Android or browser involved in these requests |
| Native pagination beyond the initial hydrated set | Coffee search at the Ralphs delivery shop in 90291 returned 300 ranked item IDs. The CLI returned two consecutive pages of 20 products with zero overlap, no missing IDs and prices for all 20 products on the later page | Live direct HTTP; verifies the `Items` hydration path beyond the first native page |
| Search facets | Authenticated `SearchFacets` returned HTTP 200 and an empty array for the coffee query | Live direct HTTP; filter choices depend on the search and are not guaranteed |

Unit tests cover exact document identities, pagination order and missing items, mismatched/expired cursors, store service separation and complete price context. Authenticated catalog reads were independently verified live. These checks do not establish successful checkout or ordering.
