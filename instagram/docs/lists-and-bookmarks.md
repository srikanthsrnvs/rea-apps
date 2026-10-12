# Relationship lists and saved-post collections

These tools run as ordinary Node HTTP requests on the headless host, using the session issued by Instagram's TV approval flow. They do not require an Android device at runtime. They only read account relationships, saved collections, and saved media.

## Followers and following

GET `/api/v1/friendships/{userId}/followers/` or `/following/` sends `count` and, on continuation, `max_id`. The response supplies `users` and `next_max_id`. The website's `polarisFollowListReducer` corroborates these fields, target account IDs, user deduplication, and restriction flags. Installed Android code contains the same endpoint templates. Advancing live pages worked without sending the response's `follow_ranking_token`; the CLI does not promise snapshot consistency while a relationship list changes.

The CLI projects users and reports `limited` from `should_limit_list_of_followers` or `should_limit_list_of_followings`. Following also projects `hidden_following_account_count` when supplied. Missing flags are `null`, not an assertion that the list is unrestricted. A `has_more=true` response without a usable cursor fails explicitly.

The default target is the signed-in account. `--username` uses the existing account-suggestion search and requires an exact match, ignoring case. It does not select a fuzzy result. A continuation carries the resolved user ID and username, so the next request does not repeat search. Cursors are bound to the signed-in account, list kind, and target; malformed IDs cannot become request paths.

## Bookmark hierarchy and pagination

The website's `PolarisProfileSavedTabContentQuery_connection` document `27959320833754327` reads `viewer.collections_unified_with_auto_collections`. Its observed variables are `after`, `first`, and `collection_types`. The CLI requests `ALL_MEDIA_AUTO_COLLECTION` and `MEDIA`, projecting collection IDs, names, media counts, and returned covers. The descriptor selects the shared saved-collection interface; it does not establish a concrete typename for every named collection, so the reader validates selected fields rather than assuming one typename.

The All posts collection has the stable client sentinel `ALL_MEDIA_AUTO_COLLECTION`. Member reads use GET `/api/v1/feed/saved/` for that sentinel and `/api/v1/feed/collection/{id}/` for a named collection. The recovered Android factory `X.C0IYC.A01` supplies those paths, optional `count`, and `include_feed_only=false`. Pagination helper `X.C0CCl.A04` adds `max_id` when present. Live saved responses contain `items` wrapped as `{media}`, `more_available`, and, when more results exist, `next_max_id`.

The web user agent returned HTTP 400 with `useragent mismatch` for saved media. Using the exact TV user agent already observed during pairing succeeded with the same website cookies, HTTPS origin, and other headers. The CLI overrides only that request's user agent; it does not replace the session's web profile. There is no native bearer token or phone runtime involved. Other operations retain their existing web transport.

`bookmarks` assembles a bounded page of this structure:

```json
{
  "type": "bookmarks",
  "children": [
    {
      "id": "ALL_MEDIA_AUTO_COLLECTION",
      "name": "All posts",
      "type": "all_saved",
      "mediaCount": 1,
      "cover": null,
      "coverItems": [],
      "loaded": true,
      "items": [{ "id": "EXAMPLE_MEDIA_ID", "carousel": [] }],
      "hasMore": false,
      "nextCursor": null
    }
  ],
  "hasMore": false,
  "nextCursor": null,
  "complete": true
}
```

The example illustrates the shape; actual media include projected author, caption, type, URLs, and other returned metadata. Each collection has an independent media continuation for `bookmarks items`. The root continuation works with `bookmarks` or `bookmarks collections`. A continuation tree page is not an exhaustive tree, so `complete` remains false on such pages. For the initial tree, `complete` is true only when collection listing is exhausted and every collection loaded without further media pages.

A media item may belong to several collections; those memberships remain separate. Carousels contain their own `carousel` children. No evidence established recursively nested saved folders. In particular, a native `collection_parent_id` literal was associated with media and does not justify inventing collection parent relationships. Audio-only, shopping, and playlist collections are excluded from the current saved-post scope.

Tree reads pause one second between collections. A known read error is attached to the affected child and stops further member reads; completed children survive, and remaining children retain `loaded=false`. There are no automatic retries. Individual collection and media commands use normal error output. Missing or repeated pagination cursors fail explicitly instead of silently terminating or looping.

## Verification and evidence

On 2026-10-12 the packaged candidate CLI ran on the Linux ARM64 Orin with `DISPLAY` and `WAYLAND_DISPLAY` unset, without Android or a browser on the host:

- Followers returned 11 users, then 12, with an advancing cursor.
- Following returned 12 users, then 12, with an advancing cursor.
- Exact username lookup resolved to the expected account.
- Collection listing returned one All posts collection; saved-media listing returned one post. The assembled tree matched that media list and reported `complete=true`.
- Saved reads left the session's web user agent unchanged.

The account had no named collections and no further saved-media page. Those cases were not exercised live by changing the account. Synthetic tests cover named membership, shared media, per-collection pagination, carousels, empty and partial trees, cursor binding, stalled or missing cursors, large IDs, restriction flags, safe request paths, and the per-request TV profile. All 37 automated tests pass on macOS and Linux ARM64.

An early manual collection probe hit HTTP 429. It was not automatically retried; a later paced request succeeded after investigation and backoff. Page counts describe observed responses, not guaranteed limits or completeness beyond the returned server state.

Public provenance consists of protocol identifiers and these source references. Captures, APKs, decompiled text, and account data remain outside Git:

| Evidence | Recovered contract |
| --- | --- |
| Website module `PolarisProfileSavedTabContentQuery_connection.graphql`, retained asset `421.js` | Collection interface, variables, connection pagination |
| Website module `polarisFollowListReducer` | Relationship users, cursor, restrictions, target and deduplication |
| Native method `X.C0IYC.A01`, REA evidence `ev_6ecc9083a349499358d74c2333d43a62725f9f72fc07e3607774e82b15068264` | Saved and named-collection GET paths, count, feed flag |
| Native helper `X.C0CCl.A04`, REA evidence `ev_b4b4274e77cb6bbcb4ae7bdc4afbc28175d962bf66d3e0ea5910ab685f0593ca` | Conditional `max_id` request parameter |

These are private versioned service protocols and may change. Incompatible responses require a CLI update, not a hidden browser or phone fallback.
