# Claude Android chat protocol

This implementation reconstructs the read contracts shipped in Claude Android
1.261016.51 (`com.anthropic.claude`, APK SHA-256
`9031d8c700315ada64e41ffdd4a81fad881e0670b03b1f6de3a3ebbec1fda080`).
The contracts below come from static REA/JADX evidence. Live authentication and
account-access results must be recorded separately; decompilation does not prove
that an endpoint currently accepts a particular session.

## Request context

The production environment selects `https://claude.ai`; its ordinary REST client
appends `/api/`. The native header provider supplies:

| Header | Native value |
| --- | --- |
| User-Agent | `Claude com.anthropic.claude/1.261016.51 (Android 36) Claude/1.261016.51` on API 36 |
| Anthropic-Client-Platform | `android` |
| Anthropic-Client-App | `com.anthropic.claude` |
| Anthropic-Client-Version | `1.261016.51` |
| Anthropic-Client-Build | `26101651` |
| Anthropic-Client-OS-Version | Android SDK integer, not release name |
| Anthropic-Device-ID | Device-provider string |
| Accept-Language | Native language provider |
| X-Client-Request-Id | A request identifier, restricted to the configured origin |

The CLI can generate its own device and request identifiers. These ordinary
headers do not constitute Android device attestation. Returning the compatibility
headers runs no browser or Android runtime.

Evidence: production environment `ev_5036dbb9ccd51a46f8c3585ec1b2adff6b4505cf9d568789c335b295c7a0322a`;
REST prefix `ev_37f948c435876b6ee4a365fffcf82f5806323c47624c80febe70a4bd737ae161`;
header map `ev_7c0a7b0b7826b17466d6b65f02e8db1ac05f49c5910a828c0f55c66ea10e4cae`;
native package/SDK inputs `ev_68d6ed1444e5f35adb1619fac57dabd7c3504cacaf462f2ce73cf428902be8b6`.

## Account and organization selection

`GET /api/account` returns the account with `uuid`, `email_address`, `full_name`,
`display_name`, `memberships`, settings and verification metadata. Each membership
contains an `organization` object and `role`. An organization has its own `uuid`,
`name`, `capabilities`, plan and billing metadata. A CLI must select an actual
membership before using organization-scoped chat routes; it must not fabricate
an organization ID or silently choose between unrelated memberships.

Evidence: request `ev_92b3f71766ffeb5b96610fe1c722010e5bb07f5aa9754119f86b5bd57b508e43`;
account serializer `ev_b68e05a96c68420eaa16c23c65b7b86ad3d1c4737542ca5acf053f0f0dff4e54`;
membership schema `ev_7be9aeffeab25012a356383f72767297f9ff012839ece4c10d57776d8e74d380`;
organization schema `ev_ab75632df1faa7be3002cf0891f457bbe918c3064b86255ac92f1215674284ca`.

## List and paginate

`GET /api/organizations/{organization_uuid}/recents` accepts `limit`, `section`,
`cursor`, repeated `surfaces` and repeated `include` parameters. The native
wrapper requests the first page with `limit=100`, without `section` or `cursor`.
It requests subsequent recent-history pages with `limit=30`, `section=recents`,
and the opaque cursor returned by the server.

Response structure:

```json
{
  "sections": [
    { "id": "recents", "title": "Recent", "data": [], "next_cursor": null }
  ],
  "degraded_surfaces": [],
  "incomplete_surfaces": []
}
```

The source accepts surfaces `chat`, `project`, `cowork`, `code`, `cowork_chat`,
`artifact`, and `routine`. The last two inclusion-only kinds `cowork_chat` and
`routine` are sent as `include`; the other selected kinds are `surfaces`.
The CLI defaults to chat history. Native chat rows have `type=chat` and embed
the conversation fields directly. Other row kinds remain separate structured
data. Starred and recent sections can contain the same chat; display deduplicates
those IDs while retaining section provenance.

Listing all chats requires traversing returned cursors, detecting repeated
cursors, and preserving `degraded_surfaces` / `incomplete_surfaces`. A successful
HTTP response or an empty page alone does not prove a complete history. No
guessed page numbers or timestamp cursors are used.

Evidence: request parameters `ev_8d6b9ea2cd90fbc3bd3b925be92c5c1aaf37f37c91104b9767950686e01002fe`;
first page `ev_b76b7695dc8f7ff9f676833a227df258a9ccfbb0656256fd05a438889c408a90`;
next page `ev_5f66f6f4a29ee2222e4e1b709cb9a73c08ab3d09daa11fb7996b1eb55a5ce67b`;
section schema `ev_12bc7b9e01eb26f68a853e0aae4e586d03462922e886f41b3c842d956ff96849`;
row discriminator `ev_756828165a1693dc232a5049e7c6dc62575dbc3bb15f5a9e2b28ec8f6bfa35ec`;
surface inclusion `ev_7e9e773de285293e442a13ab14c914a9af7575b4473f2c59d0a0d4d9f19a7885`.

## Search

`GET /api/organizations/{organization_uuid}/conversation/search/v2?query=...&n=10`
is the source request. Each `data` hit contains `conversation`, `matched_snippet`
and `title_matches`; the response also carries `search_id`, `executed_mode` and
an optional `next_page_token`. Snippets and match ranges remain structured data.

The inspected native method does not send a continuation token, even though its
response DTO includes one. The CLI exposes the returned token and marks native
search continuation unsupported instead of inventing its query parameter.
Complete local search can separately traverse all accessible history.

Evidence: request `ev_fc1dff20964ef2d83dac9a13520039bfffa1978b44a6c1f1857b5729018b47f0`;
response `ev_cb912ce931ea6ec899927394d676899aa37365169fd6a518f404c742820cf001`;
hit parser `ev_be9653d6168d6f79017f1ac19445a6d2ffeda5ca4b53b759d5aca103256bcf25`.

## Open and preserve branches

`GET /api/organizations/{organization}/chat_conversations/{chat}` sends:

```text
rendering_mode=messages
render_all_mobile_tools=true
include_extracted_content=false
```

The native method optionally adds `return_dangling_human_message` and
`max_response_bytes`. The CLI leaves the response-size cap absent by default.
The response contains conversation metadata, `chat_messages` and
`current_leaf_message_uuid`. Every message has `uuid`, `parent_message_uuid`,
`index`, sender, text, rich content blocks, attachments and files. The CLI
preserves unknown content types and every returned branch. It derives the
active branch only by following explicit parent IDs from the current leaf;
it never substitutes the last array item or latest timestamp. Missing ancestry
is reported as incomplete, and cycles/duplicate IDs are rejected.

Evidence: request `ev_c887b547cec7642d50158570fecdea132ad70c69dd75fc1002813d0e5bb693b9`;
conversation DTO `ev_ec8caa870a914f20c7cbc00dd7f690fc2a780259c4c394ca99392092053bff24`;
message schema `ev_1c2f985fc3b29ea182140c1ea557e15957366c53619bb459f9a22536b71ef89a`.

## Send, stream, reconcile and stop

The first prompt can create its conversation atomically through
`POST /api/organizations/ORG/chat_conversations/CHAT/completion`, with
`create_conversation_params`. The native root parent is
`00000000-0000-4000-8000-000000000000`. Later prompts select the active leaf from
a fresh conversation read. The body carries `completion_request_id`,
`parent_message_uuid` and
`turn_message_uuids: {human_message_uuid, assistant_message_uuid}`. Those fields
do not establish server idempotency, and the server can assign canonical IDs.

The organization-specific
`GET /api/bootstrap/ORG/app_start?growthbook_format=sdk&include_system_prompts=false`
provides `org_growthbook`. Its
`claude_ai_clients_completions_use_bard` default value selects `completion2`
instead of `completion`; missing/false selects the legacy endpoint. Hashed
feature keys use standard padded Base64 SHA-256. No global feature merge or
mutation retry is used to select an endpoint.

The native parser treats the owning stream's `message_start.message.uuid` and
`parent_uuid` as authoritative. The CLI journals them and verifies a separate
GET contains the matching assistant, human parent, original branch and prompt
text before reporting completion. A stream interrupted before authoritative
IDs are available remains uncertain; it is not automatically submitted again.
`conversation_ready` is a known zero-field event. EOF alone is not
`message_stop`, and unknown advanced content requires reconciliation.

`POST .../stop_response` carries the completion request ID. Its Unit response
acknowledges the request, not that generation already stopped. The CLI retains
the pending turn until terminal stream or conversation evidence arrives.

Evidence: request serializers
`ev_6ceffb321c47029704343fe4c54dbeb871a7ccfbbcf0af77384e23713f189468`,
`ev_172950e42bba531f3cac2b9dfed871baa6896bb4df124cf4ca3ec3d1692aaa15`;
organization feature application
`ev_b69317df46a30e4f5c567dc4c2bd7d40108088c54c6df506931b59e6cf4d8f86`;
canonical parser output
`ev_79039634966d8da3111b55cb5b55870c329b902990b686b49c2ceb8be883ec6d`.
