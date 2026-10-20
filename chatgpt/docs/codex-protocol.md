# Codex Android protocol

The ChatGPT Android app contains two Codex connection paths. Its **Cloud** entry
connects directly to a hosted app server. Connecting to a user's computer uses a
separate remote-control enrollment and transport. The CLI targets Cloud; it does
not require a computer, Android runtime, WebView, or graphical session.

These contracts were recovered with REA/JADX from ChatGPT Android **1.2026.286**
(version code **2628614**). The base APK SHA-256 is
`29d0c948857cc56034cf9172f1c1a1263779796611e6e3a3e3cc58342b175e25`.
The contracts below combine static protocol evidence with the read-only live
checks recorded at the end. Request construction tests do not establish that a
task was created or completed; no live Codex mutation was performed.

## Cloud connection

The native Cloud host is `cloud:account`, named `Cloud`. The app opens:

```text
wss://codex-cloud-backend.chatgpt.com/
Sec-WebSocket-Protocol: codex-app-server
```

There is no task-specific path or query in the inspected Cloud connection. It
uses the app's authenticated HTTP client. The WebSocket transport must therefore
carry the signed-in account's authentication; knowing the endpoint alone is not
authentication. The Cloud branch does not run remote computer enrollment.

When its normal authentication pipeline can create a DPoP proof, it signs the
HTTP upgrade URL: `wss:` becomes `https:` and `ws:` becomes `http:` before signing.
For Cloud that is `https://codex-cloud-backend.chatgpt.com/`, method `GET`. A
successful proof uses `Authorization: DPoP <access token>` plus the `DPoP`
header. The inspected pipeline can fall back to Bearer authentication when a
signing key/proof is unavailable; server acceptance is a separate live check.
Evidence: `xqd.invokeSuspend`
`ev_c201484fd4d1138a19d521bc5c30ec0dd9b45cc0e6a2735349055954777f67d8`,
`m3z0.<clinit>`
`ev_18fb8665474d891263f25a8fa643c188602356a15780065ca238ae5f295a2e01`,
and `zj.a`
`ev_26ed104f9c67386d4c80d9cb1a456e75654cedf8650b76279e8262a5f0696ad0`.

REA evidence: `p0l.a`
`ev_d036ffaa58f4a1fc9e9ca88b2fcd6da147a114b89bdd977b2c6cdeb2eceddf0a`;
`sgo.<clinit>`
`ev_145d0b41e6eaf0556c30bbed46f61d2cc169046a1f8eb1c4ad46862f4e63c52a`;
`ggd0.c`
`ev_11de3ff54232a10fd4abb485929754620bc42f17861a1cfaa6e26ce9c445c930`;
`u9c0.invokeSuspend`
`ev_11aca252a4f501f94307373ef0afa20d305c2da668de86b4b4151b6276156ff5`;
`go10.invoke`
`ev_2d3c150be062c0901718f088ef72ca1e715c614f2065ce8b185e763549bbb7de`.

## Requests and responses

Requests have `jsonrpc: "2.0"`, a monotonically assigned integer `id`, a
`method`, and structured `params`. Responses must be correlated by ID. Events
with a method and no matching ID are not completion acknowledgments. Keep
native results and unrecognized event fields; a summary must not discard rich
items or branches.

`initialize` identifies the native client as
`{name: "codex_chatgpt_android_remote", version: "dev"}` and advertises
`experimentalApi`, `mcpServerOpenaiFormElicitation`, and `requestAttestation`.
The latter is false when the transport has no attestation provider. Advertising
support does not create valid attestation proof.
After the initialization reply, the app sends an `initialized` notification
with an empty parameter object (`kxi.invokeSuspend`,
`ev_ea22b1198c136758578f450c714d2919696ed1086fea1945cc525f1e5693b970`).

The lightweight transport uses `ws` with Node's HTTPS upgrade client. It
requests the `codex-app-server` subprotocol and disables compression negotiation.
The HTTPS upgrade succeeded with the same account headers for which Node's
Fetch-based WebSocket received an edge challenge. The requests differ in
handshake headers; the specific cause of that edge decision was not isolated.
Redirects are disabled, so account headers cannot be forwarded to
another endpoint. `CodexClient` performs one initialization, correlates concurrent
responses by integer request ID, and retains a bounded set of notifications and
server requests. It never automatically retries a sent operation, reconnects,
or approves a server request. A timeout/disconnection after sending reports
`deliveryUnknown: true`; callers must reconcile server state before trying
again. Test coverage uses an actual local HTTP upgrade and WebSocket frames,
including authentication headers, out-of-order replies, timeouts, disconnects,
and unapproved server requests.

| Method | Purpose | Relevant parameters |
| --- | --- | --- |
| `thread/list` | List account tasks | `cursor`, `limit`, `modelProviders`, `sortKey`, `sortDirection`, `sectionId` |
| `thread/search` | Search on the server | `searchTerm`, `cursor`, `limit`, `sortKey`, `sortDirection` |
| `thread/read` | Read task metadata | `threadId`, `includeTurns: false` |
| `thread/turns/list` | Page through turns | Thread, cursor, limit, direction and item view |
| `thread/items/list` | Page through turn items | Thread, turn, cursor, limit and direction |
| `environment/config/list` | Select a cloud environment configuration | `scope`, `cursor`, `limit` |
| `project/list` | Static Android capability; unavailable on the tested Cloud server | Not exposed by the CLI |
| `model/list` | List available models | Native model cursor/filter |
| `thread/start` | Create a new cloud task | `serviceName`, `environmentConfigId`, `environments`, model, permissions and configuration |
| `turn/start` | Send a prompt to a task | `threadId`, `input`, optional model/effort/configuration and `clientUserMessageId` |
| `turn/interrupt` | Stop the selected turn | `threadId`, `turnId` |

The thread list and search response containers have `data`, `nextCursor`, and
`backwardsCursor`. Cursors are opaque strings and must be passed back unchanged.
Thread data includes `id`, `name`, `preview`, `cwd`, `environments`, timestamps,
`status`, `threadSource`, `originator`, `historyMode`, `turns`, and `projectId`.
Unknown fields remain in the returned `raw` value.

The tested Cloud server rejects `thread/read` with `includeTurns: true`.
`codex get` fetches metadata followed by `thread/turns/list` with
`itemsView: "full"`. It returns three turns by default, preserves structured
items, and reports continuation state in `pagination`. Use `--cursor` to read
another page, `--limit` to change page size, or `--all` to follow every page.
The default stays bounded because one turn can contain many tool items. Empty
task-list pages can still carry a cursor and must not be treated as the end.

Optional `sectionId` and environment `scope`/`cursor` are omitted when unset.
Sending them as explicit null is not compatible with the tested Cloud server.

Selecting an environment configuration is different from attaching an existing
runtime environment. The inspected native new-task path places the selected
configuration in top-level `environmentConfigId` and supplies a managed
workspace entry with `environmentId: "managed"`, `cwd: "/workspace"`, empty
`runtimeWorkspaceRoots`, and a null entry-level `environmentConfigId`.

Sending `turn/start` or receiving its acknowledgment is not proof of successful
completion. Retain the server turn ID, consume the subsequent notifications, and
verify final state. Do not automatically resend a creation or prompt after an
ambiguous disconnect: the server may already have accepted it.

REA request evidence: `xwi.n/B/O/a0/c0/e0/o/W/V`; wire descriptors in
`ivj.<clinit>`, `cll.<clinit>`, `ftl.<clinit>`, `jvl.<clinit>`,
`f3m.<clinit>`, `tmk.<clinit>`, `mmk.<clinit>`, `itl.<clinit>`, and
`vll.<clinit>`. Representative evidence IDs:

- JSON-RPC envelope:
  `ev_985645f2567854d2b8ece94b0cda4d29b8418574301886b5ea07ce057fa3edf8`
- List fields:
  `ev_4676dc940b9d212065e4214cfd0eeff2bfd6c00921b06ee78c54d59aed5be66f`
- Search fields:
  `ev_436354ee95b7dc19eb738b3f41a6d913c16d78443aa7093f8b0310e985e206ce`
- New-task fields:
  `ev_e9448cd64ed178775a99e36c4cc6829a0bbc3f9b93e6d1c837de483c31166303`
- Turn-start fields:
  `ev_0196432a4d439339093898e6de8c706f63774e6b4ad60edd6bbdcc24575c2b2a`
- Runtime environment fields:
  `ev_109f46655379ed6272225f0287569152483308aadf51b0c8d9a2841c50ffe0d6`
- Task response fields:
  `ev_98dcfb2872eb3533307deaaa4720875fdb092067c31d896d0ef84526e9f31ab5`
- Paginated list fields:
  `ev_4debef57d32f55541b149fe9708598d61c1bb4b22392ed4c533bbdf8ecf3afe7`

## Separate remote computer path

The app also builds `codex/remote/control` URLs against its configured backend.
Remote computer enrollment can require a step-up sign-in with scope
`codex.remote_control.enroll`, `allowed_workspace_id`, `current_workspace_id`,
`originator=codex_chatgpt_android_remote`, and `reauth=remote_control`. It uses
device-key enrollment and additional challenges. This is not the Cloud task
bootstrap and is outside the CLI's initial scope.

Evidence: `vxk.a`
`ev_1f45a87029604139e914e4d760af58ea66eb5f7edfbef492488b6d1d0adc1c76`;
`izn0.<init>`
`ev_5467403bd6c0f13e7b869e05bf1bfd75348dac7fe04ca5f31bc24e709836c912`.

## Read-only live verification

On 2026-10-19, the headless Linux installation used the user's independently
approved device-login session to initialize the Cloud connection, list all
three account tasks, list seven models, list two ready environment
configurations, read task metadata, and retrieve full structured turn items.
No browser or Android process was involved in those runtime requests.

The Cloud server explicitly reported `project/list` as unsupported, so that
operation is not advertised as a CLI tool. New task, follow-up, and interrupt
builders have static evidence and local tests but have not been exercised as
live mutations. Tests cover one request per operation, timeouts and disconnects
without automatic replay, and surfacing server approval requests without
automatically answering them.
