# Account conversation protocol

The read protocol is recovered from the installed Android APK, rather than the
developer Conversations API. The functions in `src/chat-read-protocol.mjs` are
pure request builders and response parsers. They perform no authentication,
network requests, writes, or automatic retries.

## Evidence and verification status

The analyzed base APK has SHA-256
`29d0c948857cc56034cf9172f1c1a1263779796611e6e3a3e3cc58342b175e25`.
REA's JADX provider supplies the method evidence below. These observations prove
what the shipped client constructs and parses. A subsequent authenticated live
read confirmed account access and returned the native paged conversation shape
described below. The protocol module tests use fictional data; live validation
of each command is separate.

The shared JSON instance is initialized by `xv50.<clinit>`
(`ev_e949ac6f8bfa3dbb047dc72ae4876d7c461c7847e82b95306457b64963915db5`).
Its `dz1.invoke` case 12 installs a naming strategy
(`ev_f5ae8037ea549c02afa668209a1abe0fbf3e60b8586059ad6ee6fe64d276246e`);
`ll.a` converts names with an underscore separator
(`ev_503142da625e220d18ac13a5a379792ec0f297ad3f0f1ccc8da192de950abd94`).
Serializer descriptor names such as `currentNode` therefore become
`current_node`. The list request explicitly serializes through that instance.

## Requests

Paths are relative to the Android backend's `/backend-api/` root. The transport
adds the account's authentication and standard client headers.

| Builder | Method and path | Parameters |
| --- | --- | --- |
| `accountRequest()` | `GET me` | None |
| `chatsListRequest(options)` | `GET conversations` | Query: `offset`, `limit`, `order`, `expand`, `is_archived` |
| `chatRequest(id, options)` | `GET conversations/{id}` | Query: `num_turns`, optional `include_message_id` |
| `chatMessagesRequest(id, options)` | `GET conversations/{id}/messages` | Query: `num_turns`, optional `before` |
| `chatsSearchRequest(query, options)` | `POST global/search` | JSON: `query`, `limit`, optional `cursor`, `query_id` |

The two conversation detail builders accept `projectId` and `ownerId`, sent as
`Chatgpt-Project-ID` and `Chatgpt-Conv-Owner-ID`. They never place those values in
the URL. The local defaults are 20 list/search results and 50 conversation
turns; list ordering defaults to `updated`. The native order enum also accepts
`created`.

Bounds of 1–1000 for page sizes and turn counts are CLI input limits, not a
claim about the server's maximum. IDs must be simple path identifiers. Cursors
are opaque strings and must not be decoded or reconstructed.

Request evidence:

- List route and serialized query: `ue2.invokeSuspend`, case 4,
  `ev_1a229367a702144b5f8477726044d46ddd75192b85903ff05ae98148b4bcbe48`.
- List fields: `vaq.<clinit>` and `serialize`,
  `ev_a7e19ad90266e83687094beb41faa0c199602606177c95962362abc2e945fc22`
  and `ev_c291b9d1c935ac6a928cf76351f0b01468a68b6c4167682dcad724a297a3030f`.
- Order values: `qy.invoke`, case 18,
  `ev_1571a1f88ad27658fc60001dee4f7b3a323095e9336deb1a6fe98dc811e018fa`.
- Detail route: `kil.invokeSuspend` and `gjr.invoke`,
  `ev_22f30d5dcac3f2167f116058728b3c37b546007d72e984de2fdcc17e347a2b45`
  and `ev_edb786790091691f81888457a14660fd07a73d097b800a60bf5f8d3b60bb1044`.
- Older turns: `hjr.invokeSuspend` and `ka6.invoke`,
  `ev_4c15e52fbb3bae22a9076a0f188c3f93193122db9b1f67693327519b5cd15634`
  and `ev_cb86bb08f42db1203a2861eee0cc12e6719eb6219e3b7fc5c09ebabd46e626c1`.
- Search route: `zat.invokeSuspend`, case 7,
  `ev_32468ad2b0ab631cc808c51d6fff805ee6487f92a542cc27b0ae8735347edfe2`.
- Search fields: `pm10.<clinit>` and `serialize`,
  `ev_7b8c778591e448bfa8962f8962f45736531d811fb97c02fb39d9c0e260c69afc`
  and `ev_ba38331c35863e1f339cafed50dc2b88b5d2f3d985190413c90dce8657cbe41c`.
- Account route: `jvz0.invokeSuspend`, case 0,
  `ev_482c472b88294eb4729a42914b3bc67dae5b1306b42b2c90d17aede17369c9e9`.

## Pagination and complete content

`parseChatsList` retains unknown server fields, valid conversation entries,
and any malformed entries under `unparsed_items`. Its `pagination.next_offset`
counts every received row, including those the Android parser would skip. An
empty page with a larger reported total is marked `stalled`; it must not cause
an infinite retry loop.

The list response contains `items`, `total`, and an optional `cursor`. This
particular list request uses `offset`; a returned cursor is retained for
inspection but is not invented as an unobserved request parameter. The search
request and response do use a cursor. `partial_results` and `source_statuses`
remain available to the caller. Search may include several account content
types; the parser preserves them instead of assuming every item is a chat.

`parseConversation` supports two response shapes and retains every message's
structured content, attachments, citations, and unknown fields:

- A `mapping` response is a graph keyed by node ID. Its
  `current_branch.source` is `mapping`; the selected branch is obtained only by
  following `current_node` through each node's `parent`. Missing parents,
  missing current nodes, invalid parent types, and cycles are explicit
  incomplete outcomes.
- The native paged response has `conversation_id`, `messages`, `current_node`,
  and `page_info`. Its `current_branch.source` is `native_page`; the original
  message array is available as `current_branch.messages`. Message IDs and
  explicit `metadata.parent_id` relationships are exposed separately as
  `message_ids` and `parent_links`. Array order never becomes an invented
  parent chain or synthetic mapping. `last_user_message` provides the last
  user message on that returned page.

The native page retains `start_cursor`, `end_cursor`, `has_previous_page`, and
`has_next_page`. A page is marked complete only when both pagination flags are
explicitly false and the current node is present. A page that does not reach
the current node is labeled `page_before_current_node`; missing pagination
flags remain unknown. A successful first page does not prove that all history
was fetched. `chatMessagesRequest` exposes the older-turn route; callers must
retain page boundaries and explicit relationships when combining results.

Response evidence:

- `abq.deserialize`, list `items`/`total`/`cursor` and per-row error tolerance:
  `ev_3de6a8698ed0bb911fbdf346e5b649475e0373f6a828a85b3b4335ddbc5810e1`.
- `bbq.<clinit>`, conversation fields including `mapping`, `current_node`,
  `is_archived`, `is_starred`, and `pinned_time`:
  `ev_8b629afd3a19b3bc8d7f92b51051dfaf54f9656a78fa1a77d1e87498d30b8732`.
- `cuq.deserialize`, node ID, parent, children, and rich message:
  `ev_c94e940766ebd57b691476ff0c1d2ecbd3e77035a84f1a90622856ea732ee569`.
- `o54.<clinit>`, search pagination and source status fields:
  `ev_7b0dad070bfe2816cdcc2e0434b56c01a35e96a81f712e0421150ea350e92a20`.
- `zzz0.<clinit>`, account identity fields:
  `ev_81d8c2a8a57e3538e5552501725dc415ae0cba41dcd093ea953347e8f67838b3`.

## Authentication boundary

The native transport normally obtains an access token and builds an
`Authorization` header. It can use DPoP when a key and the enabled capability
are present; the shipped method also has a Bearer fallback. That fallback is a
static client behavior, not proof that the server accepts a particular token
without DPoP.

The standard headers include `OAI-Client-Type`, `OAI-Device-Id`,
`OAI-Package-Name`, `User-Agent`, `Accept-Language`, `X-Device-Tier`, and
`X-OpenAI-Target-Path`. Authentication credentials, session cookies, device
proofs, and live account payloads belong outside the repository.

Relevant methods are `zj.a`
(`ev_26ed104f9c67386d4c80d9cb1a456e75654cedf8650b76279e8262a5f0696ad0`),
`emh.intercept`
(`ev_18029589515adc5db9d2ee9496c09cc29c44bed589b67468a0291ac4a09ecd83`),
and `t5v0.intercept`
(`ev_7d5b7d8ae878d17e5b91b11356a18e49af5f9ac8c89c881457e3bc65f71f1ee8`).
