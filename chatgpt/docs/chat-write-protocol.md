# Native conversation writes and streams

`src/chat-write-protocol.mjs` contains pure request builders, the Android v1
delta decoder, and independent-read reconciliation. It does not open a socket,
save a credential, send a message, or retry a request. Live account acceptance
has not been established by the synthetic tests in this module.

## Start a message

`chatMessageRequest` returns `POST f/conversation`. A new conversation uses
`conversation_id: null`; a reply uses the existing conversation ID. Both use
`action: "next"`, a caller-supplied `parent_message_id`, and one user message
with a caller-supplied unique ID. The text content is
`{"content_type":"text","parts":["..."]}`. The builder also sets `stream: true`
and advertises `supported_encodings: ["v1"]`.

The caller must select a model identifier available to the account and persist
the message and parent IDs before sending. The builder does not guess a model
or generate new IDs during a retry. Timezone and creation-time fields are
optional inputs from the caller. Attachment, audio, editing, variant, sharing,
automation, and tool-execution request features are outside this initial
text-message builder.

Evidence from the analyzed Android APK:

- `o52.invoke`, case 20, constructs `f/conversation`, serializes the request
  through the shared snake_case JSON configuration, and adds `stream: true`:
  `ev_279e9333f726e4c4b147072f681b135138ba883a8a5596d1c7910467a65acb58`.
- `r8r.<clinit>` declares the request's 54 fields:
  `ev_93dfaec2c7550ee8adf5acb8b608562177d887b7e0f5b2649d3b1b623779c779`.
- `r8r.serialize` identifies the corresponding `t8r` values:
  `ev_3b712a9204a8262887a8b772e11470a114a8077745598d676491afedb0ee86e1`.
- `b9r.b` builds the native request, including optional `v1` encoding and local
  timezone information:
  `ev_93bcefb405ba2004ea0e97adf027ad9dca64d669261195fe04bd3fc4001a6519`.
- `b0.invoke`, case 19, maps the action enum to `next`, `variant`, and `continue`:
  `ev_3e4ef3f7c1b4121417a562e709bc8afbbde3e2ad08d0d39f05b78f20b6dd4859`.
- `tt3.<clinit>` defines message ID, author, content, and optional message fields:
  `ev_418c2b0639556277075219de804e88211e9184f47d616e6d7654ad4721a782df`.
- `e35` and its serializer define a text content object with `parts` and
  `content_type`:
  `ev_4cb43ad3ab30b6ac17de2dd03597ae570b230201f9c6c7838c805879571f05df`
  and `ev_989b6ec45cdedf601d40a8c4e85e974895fba0a6f174cf9524db8f204e969530`.

## Stop an active generation

`chatStopRequest(id)` returns `POST stop_conversation` with
`{"conversation_id":"..."}`. It needs a known server conversation ID. A
successful HTTP acknowledgement establishes that the request was accepted;
it does not independently prove that generation has stopped.

The route is constructed by `fvc.invokeSuspend`, case 3
(`ev_77b576de3cb6c022208c61c948f2666e25b56ed545199521a437554ed6607be2`).
`at.invoke`, case 14, supplies the `kav0` body
(`ev_8b1351293a20ec32426eba2106bd20049dea765c2d4b0f1ffc02fba55cd30822`);
`iav0.<clinit>` declares its `conversation_id` field
(`ev_1b88fdd7e4c0cf0f0bee77e526ff4f3e656fbb6cbf51c7c5652daf8ad14320f0`).

## SSE decoding

Use the byte-level parser in `sse.mjs` to create complete SSE frames, then pass
each frame through `reduceConversationStream` with the previous state.

The native stream first negotiates `event: delta_encoding` with value `v1`.
Later `event: delta` frames contain compact JSON operations. Long and short
field names are supported:

| Long field | Short field | Meaning |
| --- | --- | --- |
| `op` | `o` | Operation |
| `path` | `p` | JSON path |
| `value` | `v` | New value or patch content |
| `from` | `f` | Preserved source field |
| `channel` | `c` | Separate document channel |

Omitted fields inherit the previous frame's operation fields. An explicit JSON
null value remains distinct from an omitted value. Each channel maintains its
own accumulated JSON document. Supported operations are `add`, `remove`,
`replace`, `append`, `truncate`, and nested `patch`.

The native semantics differ from RFC 6902 in several details: `add` replaces an
array slot, writes can grow arrays with null slots, `append` concatenates text
or arrays and merges objects, and paths accept the Android parser's optional
leading slash. Escapes `~1` and `~0` represent slash and tilde. An empty path or
`/` selects the root. The decoder includes local depth and growth bounds.

Evidence:

- `zx50.b` negotiates v1 and decodes delta frames:
  `ev_f21f23e0f3b8f1f5301a904c9b15547f111ca0741e0df7b541e669a4745161c6`.
- `ddi0.deserialize` declares long and compact field aliases:
  `ev_8d904f49bb72b8d17222ca5229e9614c5b6ab6b3bace83df9a3c675ea2b49464`.
- `n951.b` inherits fields and retains per-channel documents:
  `ev_c1a5eb86b58c8568ce6096a7ac6bafe56b15cccf9d8321b81006aeb3352bd001`.
- `yw61.d`, `g`, `m`, and `o` implement operations, lookup, removal, and writes:
  `ev_ae8a79825d7b68c371abf9a3da899f89eb7fd751f3ebd0842834f53400e8c95b`,
  `ev_677f2ea230e3114686f72168fa0a20129f5730d868a1b9c52fe2b5f058b74369`,
  `ev_b45d0ad979cc66bce77b292ffbe9f382d42655ace3537d8644ab64d378cca849`,
  `ev_af12ceae0d7790fa9e9ae8abc6f56a5cc4bc3f544d5d3f268a47815bb5d7a1bb`.
- `bx50.<init>` parses paths:
  `ev_6bf851cf3eb538bfddf647cf9cb8fd1b67496c42f4da53a2eab1dcb60d1a7de4`.

Several decompiled methods carry JADX control-flow warnings. The pure tests
exercise representative operations, frame inheritance, channel isolation,
malformed paths, bounds, and prototype-like JSON keys; they do not replace
future validation against an authenticated live stream.

## Completion and independent verification

The stream parser preserves complete message objects and tracks the server's
conversation ID. It recognizes `message_stream_complete` and
`main_stream_complete` separately. The latter also carries
`turn_exchange_id` and `alternate_response_expected`. Unknown event payloads
remain available as `last_event`. Stream state may contain private account data
and resume tokens; do not print the entire internal state in routine CLI output.

Transport EOF, a `[DONE]` marker, and a main-stream event are not enough to
confirm that a user message was saved. After sending, independently fetch the
conversation through the read protocol. `reconcileConversationTurn` checks the
original user-message ID, role, text, conversation ID, and current branch. For
mapping responses, it follows the explicit graph. For native flat pages, it
requires the submitted message and current node on the page, an explicit
`has_next_page: false`, and the final assistant reply at the current node. It
checks `metadata.parent_id` links when available and rejects contradictory
links or an intervening user turn. When optional parent IDs are absent, its
reported evidence is the server's native active-page order; it does not
construct a synthetic graph. Older history can remain paginated while the
complete latest turn is independently verified.

Completed success requires `end_turn: true` and
`status: "finished_successfully"`. Analysis-channel and hidden messages are
excluded from the reconciliation result's `assistant_messages`; their content
is not used to determine the visible reply.

`finished_partial_completion` is reported as terminal but incomplete. Missing
messages, a different selected branch, and pending assistant messages remain
explicit unresolved outcomes. These are local reconciliation results, not
invented server status endpoints. Never automatically replay a write after an
uncertain response.

The conversation stream serializer selection is `h7r.a`
(`ev_2b7de71e201d41fe3c49cc614420155b1bbd792c4a9ed0f92daf08a9c0880010`).
Message updates carry `conversation_id` and `message` through `l8r`
(`ev_ce5a5076563e7bc13f78a8ac5c5c0f8567005ba21ca6a4fb290a1391c7dbc15a`).
Completion fields are defined by `sfq` and `jbq`
(`ev_912e0d56874688cc08fe820dc5633f91361fb292ebe2616f45aebbb3f986f464`,
`ev_48ec237954d5f973cab9ea022e61c67137f13cce1ba674caafad40a201fab989`).
Status string values come from `qb.invoke`, case 17
(`ev_1b019b894833322b4eaa6495c091d62877eaea910d6ee0a659a38776e176269a`).
