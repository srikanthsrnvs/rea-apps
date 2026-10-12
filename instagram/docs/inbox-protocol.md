# Inbox protocol evidence

The runtime uses the separately verified [website protocol](web-protocol.md). This document records Android evidence, whose endpoints and pagination are not the runtime contract.

The requested inbox feature lists conversation summaries and recent previews already returned with each inbox page. It does not fetch thread histories or send messages. Pagination follows the server's inbox cursor; it does not promise unlimited results beyond what the account's server response exposes.

The investigation source is the installed Instagram Android `450.0.0.50.77` base APK, SHA-256 `9f9712803a1563da73267832aa402c9d4b37a5192cf99639a1a81c9c31394435`. REA/JADX observations below describe Android request construction and parsing. The CLI's approved website cookie session uses the website's observed transport; an Android endpoint alone does not establish website compatibility.

## Native inbox request

`X.C0dmi.invokeSuspend` contains a GET request to `direct_v2/inbox/`, relative to the mobile `/api/v1/` base. Its recovered smali selects the GET enum and inserts:

| Parameter | Observed value |
| --- | --- |
| `limit` | `20` |
| `thread_message_limit` | `5` |
| `visual_message_return_type` | `unseen` |
| `cursor` | Saved pagination cursor, or null on the initial request |
| One additional field | Key resolved by `C0E7E.A00(161)`; unresolved in this pass |

The `thread_message_limit` and `visual_message_return_type` keys are recovered through the central DEX string decoder: cases4690 and1217 respectively. A limit of five is an observed app request setting, not a guarantee that every conversation contains five preview items.

This coroutine is one inbox consumer and should not be treated as complete coverage of all account types or folders. `X.C0C1L.HO2` separately sets a `direct_v2/%s/` path: selector0 maps to `inbox`, selector2 to `spam_inbox`, and other branches select additional folders. Only the ordinary inbox is in the requested implementation scope.

## Native inbox page schema

`X.C0C4k.unsafeParseFromJson` parses the `DirectInboxPagedResult` model with these fields:

| Field | Observed parser type/behavior |
| --- | --- |
| `threads` | Array of thread summary models; defaults to an empty collection when absent |
| `pinned_threads` | Separate array of thread summary models; defaults to an empty collection when absent |
| `has_older` | Boolean; the native parser rejects a missing value |
| `oldest_cursor` | Nullable string |
| `prev_cursor` | Cursor object parsed by `C01uO` |
| `prev_cursor_v2` | Cursor object parsed by `C01uQ` |
| `prev_cursor_type` | Enum; unknown/absent values receive an unrecognized-value default |
| `old_mrs_exist` | Boolean; defaults to false |

The precise native cursor-object schemas and thread summary submodel were not fully reconstructed in this scoped pass. Do not fabricate participant identities, unread counts, or missing message previews. Normalize fields actually returned by the chosen website transport, preserve opaque identifiers as strings, and keep cursors opaque.

For a cursor-based CLI, return the page and its continuation separately. Request the next page only when the caller asks to continue or enables continuous iteration. Stop when the server says there are no older pages, omits a usable continuation, or repeats a cursor. Pagination errors and rate limits should be reported rather than hidden by repeated requests.

## Website transport and verification boundary

The main implementation investigation established a valid approved website session through HTTP homepage bootstrap. That session did not successfully use the legacy mobile REST paths in initial probes, so website GraphQL requests are being recovered from the user's own browser. The mobile facts above are supporting evidence; they must not be advertised as a working website inbox implementation without an authenticated server response.

Only summaries and previews included in an inbox response belong to this feature. Opening a separate thread, changing read state, and contacting anyone are outside this scope. The private investigation did not perform those actions. Any encrypted or unavailable preview content should remain unavailable rather than be represented as successfully decrypted or complete history.

## Evidence ledger

| Observation | REA evidence |
| --- | --- |
| Inbox GET request and request settings; complete smali fallback | `ev_d1201eb2b917dc51949452b13c31a579ebcf93c3bcf25f1eef00376844e14e7a` |
| Inbox folder path selector | `ev_81f26ff1a47adacb75c5cceb24bb46b6db175df874c2a31f15d7da7f958e6f94` |
| Inbox page JSON parser | `ev_1e45f48126426c44247a5310b9c1df979c647f3b5847c9e6f86876f2063a7d8b` |
| Shared HTTP enum labels, establishing GET | `ev_a6a26f8129236c8f207a85326214c2facc1dc34aa1fcf4e50c0140270fe67694` |

Full evidence, raw APK bytes, decoder offsets, and any account data are stored privately outside the public repository. JADX warnings and unresolved fields remain part of the evidence limitations; static recovery does not establish execution or future compatibility.
