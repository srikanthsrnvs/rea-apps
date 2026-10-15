# LinkedIn inbox protocol

This module uses contracts recovered from the installed **LinkedIn Android 4.1.1261 (216900)** APK, SHA-256 `60e4a43691c6440c641707edd3e3201e0dd46eeba9e0363fe99945c84fe4ba4c`. REA/JADX inspected the binary without executing it. Passing local tests establishes request construction and failure handling; it does **not** establish that a newly authenticated account can execute these requests against LinkedIn. No live message was sent during development.

## Read contracts

Every persisted query supplies its exact native `queryName` in addition to `queryId` and variables: `FindConversationsByCategory`, `GetMessagesByConversation`, `GetConversationsByIds`, `FindConversationsByRecipients`, or `FindConversationsBySearchCriteria`. These are the operation names passed to the native Query constructor; omitting them can select the wrong server contract.

`listConversations(client, options)` calls the persisted GraphQL finder `voyagerMessagingDashMessengerConversations.7dc50d3efc3953190125aca9c05f0af6`. Variables: `mailboxUrn`, `category`, optional `count`, `lastUpdatedBefore`, `nextCursor`. Response field: `messengerConversationsByCategory`, with `elements`, `metadata.nextCursor`, and Rest.li `paging`.

`listMessages` uses `voyagerMessagingDashMessengerMessages.7cde5843a127bbecc3de900d3894a74a`, variables `conversationUrn`, `count`, optional `nextCursor` or `prevCursor`; field `messengerMessagesByConversation`. Its metadata has separate `nextCursor` and `prevCursor`. Opaque cursors are retained exactly, and reading does not issue a read-receipt mutation.

`getConversation` uses the native batch getter `voyagerMessagingDashMessengerConversations.a9b5f88bcf8f56404a2893bac1803784` with `conversationIds: [urn]`. `messengerConversationsByIds` is an array, not an `elements` collection. `findConversationsByRecipients` uses `...Conversations.676f7f56a71a6d38fac941d85d9fe7b1` with `mailboxUrn`, `recipients`; field `messengerConversationsByRecipients` is a collection. The recipient finder can locate the conversation after an uncertain new-conversation send without creating another message.

`searchConversations` uses `...Conversations.0eab60c1f1f1e3a6d31aadd99819e2c3`, field `messengerConversationsBySearchCriteria`, variables `mailboxUrn`, `count`, optional `categories`, `keywords`, `nextCursor`, `read`, `firstDegreeConnections`, `authorUrns`, `hasLastMessage`. This supports unread filtering and searching the inbox independently of people search.

The personal mailbox is the authenticated `MiniProfile.dashEntityUrn`, usually `urn:li:fsd_profile:...`. The native `VoyagerMailboxConfigProviderImpl.getViewerUrn` reads that field directly. A public profile slug or a legacy MiniProfile URN is not substituted for it. Profile URNs passed to new-message operations must already have been resolved from account/profile data.

Entities remain structured, including participants, group metadata, text attributes, and returned attachment/render-content metadata. Full envelopes, nested `data.data`, and LinkedIn `included` reference envelopes are handled. Missing or unresolved collections fail explicitly instead of becoming an apparently empty inbox.

## Send and reply

The native `MessageWriteNetworkStoreImpl$createMessage$2.invokeSuspend` constructs:

```text
POST /voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage
{
  mailboxUrn,
  message: {body: {text, attributes: []}, originToken, ...},
  trackingId,
  dedupeByClientGeneratedToken: true,
  hostRecipientUrns?: [...],
  conversationTitle?: ...
}
```

For a reply, native delivery preparation puts both `message.conversationUrn` and `message.conversation.entityUrn` in the request. For a new conversation it omits those fields and supplies `hostRecipientUrns`. Client-created message entity URNs and sender objects are cleared before sending. The module implements plain text only; attachments returned by reads are preserved, but an upload workflow, rich mentions, recalls, reactions, InMail purchase, and group participant editing are not implemented by this module.

`originToken` follows `MessageUUIDUtils.createOriginToken`: a UUID v4 string. The native sync tracking utility converts a UUID's 16 big-endian bytes to unsigned character values through `BytesUtil.bytesToString`, equivalent to a Latin-1 byte string, **not base64**. `trackingId` follows this representation. `Message.body` is the native `com.linkedin.pemberly.text.AttributedText` model, with JSON keys `text` and `attributes`.

A live new-conversation attempt to a second-degree profile returned HTTP 422 with `RECIPIENT_NOT_FIRST_DEGREE_CONNECTION`. The CLI exposes this recognized permission code while withholding raw response bodies. It does not substitute a connection invitation, buy InMail, or retry a rejected standard message. Successful live sending still requires validation with an eligible recipient.

`prepareMessage` creates a frozen, reviewable plan with stable `originToken`, request digest and operation ID; it sends nothing. `sendMessage(..., {confirm: true})` makes exactly one transport call with retries disabled. A returned message entity URN establishes acceptance. A timeout, interrupted connection, or unexpected success response remains `MESSAGE_SEND_UNKNOWN`, preserving the token. `reconcileMessage` searches a selected page for that token; absence on one page is explicitly inconclusive. The CLI must persist an attempted operation **before** calling send and must not automatically resend on a later process invocation. Server deduplication support is observed statically; exactly-once delivery is not claimed.

## Inbox state

The native route builder produces `/voyager/api/voyagerMessagingDashMessengerConversations` and the message path above. Category mutations POST `?action=addCategory` or `?action=removeCategory` with `{conversationUrns, category}`. Native categories are `INBOX`, `ARCHIVE`, `SPAM`, `PRIMARY_INBOX`, `SECONDARY_INBOX`, `INMAIL`, `MESSAGE_REQUEST_PENDING`, `MESSAGE_REQUEST_DECLINED`, `MESSAGE_REQUEST`, `STARRED`, and `JOB`. The module reports the accepted native category operation; automatic removal of another category is not assumed.

Notification changes POST to the URL-encoded conversation resource with `{patch: {$set: {notificationStatus}}}`, where the native enum is `ACTIVE`, `MUTE`, or `ACTIVE_FOR_MENTIONS_ONLY`. Generic native conversation update uses the same resource POST and Pegasus patch generation; `setConversationRead` projects the supported `read` boolean. It does not invent a `lastReadAt` timestamp or send a separate seen-receipt action. A native repository coroutine constructs a Conversation with only its `read` boolean before sending a batch update; its local optimistic copy also updates unread count. The CLI leaves unread-count computation to the server. Read/unread behavior still needs account-backed validation. The inspected native per-call request configuration supplies no explicit `X-RestLi-Method` header for these POSTs; no extra per-call header is fabricated.

## Evidence ledger

Private APKs, raw responses, full decompilations, and instruction dumps remain outside Git. Public evidence identifiers identify the retained private REA records:

| Finding | REA evidence |
| --- | --- |
| Conversation finder and cursor variables | `ev_96f5249aaf96b6469097cbf6eb9362b614f513cc2fb91d02e577c366daee127e` |
| Message finder and two-direction cursors (complete smali fallback) | `ev_54467e066d95bb85d23cd0e246fd918abfe60c275efcc61320d7a40377b5c05d` |
| Conversation batch getter / recipient finder (complete smali fallback) | `ev_fb0ddff6a9047522cc46d7b2bd50e1260c692bc73c4ea44113f12e691468b3fc` |
| Native send action and complete body construction | `ev_3506af1b840935ec1f866a5467b9cc8c6c91ff47d100de073273204211d50f7f` |
| Reply/draft serialization and retained origin token | `ev_96c3b17afe33f5bced9126717667e5e808d5fd642b1bbb65038cd63b95482b03` |
| Conversation/recipient validation before native send | `ev_4364fb6ec9b04d0e3761c92ef9eb03364c4f9e5e3d9d7601905fdbfba921f95e` |
| Category action request shape | `ev_47b310db56e27cd3b51b121ba924fca8b3d8638a37a48f3263995f7d13281b37` |
| Notification patch request and POST configuration | `ev_fb80ccebbd929921df3e8151d8175a93497186ffb01997b3ad1052d59918f551` |
| Generic conversation resource and batch patches (complete smali fallback) | `ev_00088348f58347af2dabf735f93b567c2f435b10b7bb331b4f58aebd0668a9a5` |
| Mailbox identity from own MiniProfile | `ev_880afd83dcb6a5da694caf4ff6c002f8325787761931f819ad7e2b38f0dfc522` |

Independent raw DEX instruction inspection additionally corroborated route prefix construction (`BaseRoute`), model field names, notification/category enums, inbox search variables, UUID tracking serialization, and generic conversation patch generation. Those observations are source-bound static evidence rather than execution traces. Bionic store type names exist in the DEX type index, but their empty provider inventories did not establish active endpoint contracts; this implementation uses the concrete Messenger network stores above.
