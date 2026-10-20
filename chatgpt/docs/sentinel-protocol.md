# Chat requirements and device verification

The native client requests `POST /backend-api/sentinel/chat-requirements` with
an empty JSON object. Its response contains an opaque `token`.
`src/sentinel-protocol.mjs` provides a request builder and checks this response
without making network requests.

The observed Valdi integration attaches that token as
`OpenAI-Sentinel-Chat-Requirements-Token`. It also supplies an
`X-Sentinel-Payload` produced by genuine device verification. In the inspected
integration, this contains a Play Integrity token and the chat-requirements
token. That integration explicitly requires the official internal Android app
and a valid device-verification cookie. It is evidence of the protocol, not a
portable way to generate Android attestation on Linux.

Other native request paths also attach `X-Sentinel-Payload` from their integrity
provider. If that provider fails, they can report an
`oai-android-play-integrity-token-failed` header. A header describing failure
does not establish that the backend will permit the requested operation.

The protocol helper does not synthesize Play Integrity, challenge responses or
device cookies. It stops when a returned requirement explicitly asks for
additional verification. An optional `integrityPayload` must come from a genuine
verification provider. Passing a requirements token alone does not prove that
the service will accept a chat write; acceptance requires a live authenticated
request and independent conversation reconciliation.

Relevant static REA evidence:

- `ev_71282ba895bd21775cf3f54622177c8d323deb056af2a021c157331308888b6e`:
  `tw2.invokeSuspend`, case 6 constructs the native request.
- `ev_9dc3fe71d3b30b9c1836f661061163dc76aae9076696c002f722771ad4acb2e1`:
  `com.openai.valdi.integrity.b.a` reads and validates `token`.
- `ev_28cb2937b108fdc30b04d3d60bc82a524414ffdc15ddfed912c7f260b657adf3`:
  `w72.invoke` returns the requirements and integrity headers.
- `ev_a3896cc1b5b70922bc287ec58d745a06fa4717017f0c92435635b82169d24049`:
  the Valdi flow requires its Android app, verification cookie and Play Integrity.
- `ev_474d03b8df5f91324417e8c07bd3638194383a4a951e1b1de858f9fb24e242b9`:
  `pvb.g` attaches a provider-produced integrity payload or reports failure.

All observations use the APK identity recorded in `auth-protocol.md`.
