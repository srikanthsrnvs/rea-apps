# Live website protocol

The runtime uses authenticated website reads plus the saved-media GET contract verified with the approved TV session. Android's request factories provide supporting evidence; compatibility is established by live requests rather than assuming native endpoints or bearer tokens are interchangeable with website cookies.

## Authentication and transport

`GET https://www.instagram.com/` returns JSON bootstrap modules embedded in HTML. `PolarisViewer.data.id` must match the `ds_user_id` cookie before a session is saved. `PolarisViewer.data.fbid` supplies the web GraphQL actor. `DTSGInitialData` and `LSD` provide fresh request tokens, retained only in memory. `CurrentUserInitialData.USER_ID` is not used as the Instagram account ID.

Reads send Instagram-scoped cookies and the session's web user agent, except saved-media GETs, which use the observed TV user agent for that request only. Default login uses the [verified TV pairing flow](auth-handoff.md), then validates its issued cookies against the website. The GraphQL transport uses the website app ID `936619743392459`, observed ASBD ID `359341`, CSRF token, Origin, Referer, and same-origin fetch headers. Its form includes the current actor, fresh DTSG/LSD, derived `jazoest`, query variables, friendly name and document ID. No captured request body or account token is embedded in source.

Credentials never follow redirects. Responses are bounded to 20 MiB and unsafe integer identifiers decode to strings. Cookies rotate through server responses. There are no automatic retries after challenges, rate limits or protocol failures.

## Implemented operations

| Capability | Read operation | Continuation |
| --- | --- | --- |
| Account | Homepage bootstrap | None |
| Explore | GET `/api/v1/discover/web/explore_grid/` | Response **`max_id`**, sent as `max_id`; `more_available` controls continuation |
| Account suggestions | GraphQL `PolarisSearchBoxRefetchableQuery`, document `27706427925724183` | Website suggestions do not expose a supported continuation |
| Content search | GraphQL `PolarisKeywordSearchExplorePageRelayQuery`, document `37324993597144881` | Connection `page_info.end_cursor` |
| Content continuation | GraphQL `PolarisKeywordSearchExplorePageRelayPaginationQuery`, document `28656899673911396` | `after`, `first=24`, same query and search/serp session IDs |
| Inbox summaries | GraphQL `PolarisDirectInboxQuery`, document `27909866362025854` | Mailbox ID and `threads_by_folder.page_info.end_cursor` |
| Inbox continuation | GraphQL `IGDThreadListOffMsysPaginationQuery`, document `28774058922187457` | `id`, `cursor`, `count=15`, `folder=INBOX`; returns `fetch__SlideMailbox` |
| Followers / following | GET `/api/v1/friendships/{userId}/{followers\|following}/` | `next_max_id`, sent as `max_id`, with requested `count` |
| Saved-post collections | GraphQL `PolarisProfileSavedTabContentQuery_connection`, document `27959320833754327` | `after`, `first`, `collection_types=[ALL_MEDIA_AUTO_COLLECTION, MEDIA]` |
| All saved posts | GET `/api/v1/feed/saved/` | `more_available` and `next_max_id`, sent as `max_id`; `count`, `include_feed_only=false` |
| Named collection posts | GET `/api/v1/feed/collection/{collectionId}/` | Same saved-media pagination contract |

The Explore website's opaque `max_id` differs from the native app's `next_max_id`. The CLI flattens mixed tile and clips wrappers, retaining media IDs and removing duplicates within each page. It does not treat a clips collection ID as a media ID.

Content search projects `XDTTopSerpMediaGridUnit.items`. Other search units can be headers or account groups and are omitted from the media list. Inbox projects `as_ig_direct_thread` conversation metadata and one latest snippet; raw message collections are not exposed. It sends neither individual-thread requests nor read/seen mutations. The read-only GraphQL allowlist excludes mutation operations.

Document IDs are observed public client protocol identifiers, not API keys. They may rotate; an incompatible response produces an explicit error and requires a CLI update.

## Live evidence

On 2026-10-12, ordinary Node HTTP requests with Chrome closed returned:

- Explore: 20 items followed by 18, with advancing cursors.
- Content search: 24 items followed by 24, retaining the original search session.
- Inbox: 15 summaries followed by 9; the second page reached the end.
- Account search: five account suggestions.

These counts describe one live account and request sequence, not guaranteed page sizes. Private responses and browser captures remain outside Git. Automated tests use synthetic fixtures. The same operations and continuation pages passed on the native Linux ARM64 host with DISPLAY and WAYLAND_DISPLAY unset and no npm dependencies installed, including a fresh session issued through TV pairing. All 37 automated tests passed on both macOS and Linux ARM64. Follow and bookmark reads are detailed in [their protocol and verification record](lists-and-bookmarks.md).
