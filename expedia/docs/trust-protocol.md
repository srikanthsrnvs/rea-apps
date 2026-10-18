# Linux Trust payload

`src/trust.mjs` collects local Linux measurements and encodes the Trust input
used by Expedia's native authentication protocol. It uses Node's built-in
modules, makes no network calls, and starts no browser, Android runtime,
emulator, or background process.

On October 17, 2026, the Linux implementation participated in a successful
email-code login on ARM64 Linux. The user completed Expedia's official Arkose
flow in their own browser, and a separate `identityRefresh` request validated
the resulting account session. That result covers this combination of login
state, user verification, challenge completion, and local telemetry; encoding
a payload alone does not authenticate an account.

## Artifact and source attribution

The protocol was traced with REA against the installed Android package
`com.expedia.bookings`, version `2026.41.0`, APK SHA-256
`dfd7bbfdf10976740cbf7b4a74e359358871479766d0705d1e9b5ff633a7700f`.
Relevant source locations recovered from that artifact are:

| Behavior | Recovered class or method |
|---|---|
| Outer JSON/Base64 encoding | `TrustWidgetService.serializeAndEncodeData` |
| Payload composition and completion status | `TrustWidgetService.buildTrustPayload`, `getDeviceData`, `getIovationData` |
| Device and execution context | `DeviceInfoFetcher.collectDeviceInfo`, `collectExecContext` |
| Vendor configuration | `IovationFetcher.getData`, `FraudForceConfiguration.Builder` |
| Blackbox measurement aggregation | `FraudForceManager.getBlackbox`, `ox5.f.a` |
| Blackbox framing and compression | `rx5.b.a`, `rx5.b.b`, `rx5.b.c` |
| Blackbox reversible obfuscation | `rx5.c.a`, `rx5.c.b`, `rx5.c.<clinit>` |
| Conditional vendor network collection | `px5.t.a`, `px5.t.c` |

The outer payload is pretty-printed Gson JSON, encoded as UTF-8 and Base64
without line breaks. Object members with null values are omitted. The port
also preserves Gson's HTML escaping and null array elements.

The inner blackbox uses the recovered `0740` format: a map count followed by
UTF-8 key/value byte lengths and values, raw DEFLATE, reversible obfuscation
with four fresh random bytes, and Base64. The static obfuscation bytes are
public artifact constants, not a private signing or attestation key. Both
encoding layers have bounded input and decompression sizes.

The tests include synthetic fixtures produced by an independent Java
translation of the recovered instructions. Java and Node outputs were also
cross-decoded. DEFLATE output can differ between runtime versions, so tests
check framing and exact decoded fields rather than requiring one compressor's
byte sequence.

## Measurements and unavailable fields

The collector supports Linux. The codec functions are portable Node code;
attempting host collection on another operating system returns
`UNSUPPORTED_PLATFORM`.

The collector reads the executing host's OS, kernel release, hostname,
uptime, CPU information, physical memory, and V8 heap measurements. The
blackbox explicitly identifies Linux and the REA CLI implementation. Physical
memory uses the native field's MiB conversion. Runtime heap measurements
describe V8 rather than Java Runtime.

Android IDs, APK signing information, Android build fingerprints, mobile
hardware, location, root-detection results, and vendor phone-home results
are omitted. Their absence is recorded in the blackbox's `EXCPT` field and
returned provenance. No measurements are copied from another device.
`PHEN=0` records that no vendor phone-home request was made.

The inspected native entry point enables vendor networking but supplies no
subscriber key. Its network collector requires both a nonblank subscriber
key and enabled networking before starting a request. This is distinct from
claiming that every Expedia environment or future version uses the same
configuration.

## Exact DTO and state semantics

The envelope contains `configuredDependencies`, `deviceInfo`, `diagnostics`,
`executionContext`, `payloadSchemaVersion`, and `status`. A dependency has
`name`, `payload`, and `status`. This implementation uses schema version `1`
and dependency name `iovationname`.

`executionContext.placementPage` is an integer whose native constructor
default is **1**. `DeviceInfoFetcher` sets `placement` to **DEFAULT**. Although
the authentication adapter constructs a `ClientConfig` containing `LOGIN`,
the shipped API overload used by its resolver discards that configuration
before invoking the service. The port retains `DEFAULT` and reports its
actual `CLI,Linux,REA` execution context.

The native status enum contains `REQUESTED`, `INITIALIZATION`, `ACTIVE`,
`COMPLETE`, and `ERROR`. The port follows the recovered local predicates:

- A nonempty blackbox completes its dependency; an empty result remains
  `REQUESTED`.
- Individual vendor collector failures can be recorded inside `EXCPT` while
  the nonempty blackbox remains `COMPLETE`.
- The outer status is `ERROR` when device collection records actual errors,
  otherwise `COMPLETE`. Nested dependency diagnostics do not determine it.

`COMPLETE` describes local collection and encoding. Authentication remains
dependent on Expedia's response and the genuine verification and challenge
steps requested for that login.

## Module interface

`collectLinuxTrust()` returns `{ payload, encoded, provenance }`. The login
provider uses `encoded` as the Trust input. The remaining fields support
local diagnostics and contain host information; they should not be printed
as routine tool output or committed with account captures.

The module also exports `serializeTrustPayload`, `decodeTrustPayload`,
`serializeBlackboxFields`, `encodeBlackbox`, and `decodeBlackbox` for protocol
validation. Supplying a deterministic mask to `encodeBlackbox` is intended
for synthetic fixtures; normal collection generates fresh random bytes.
