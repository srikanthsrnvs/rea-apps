# Android map parity work

Reference: Uber Android 4.651.10003, base APK SHA256
`2a92686a421d1d37bd16d287869ac9dbc5c71f36a6b0793b187f0a2bc1c24a91`.
The current iframe is experimental. A correct live location, public map assets,
or a visually similar screenshot does not establish full Android parity.

| Behavior             | Evidence established                                                                                | Browser state                                                                              | Verification remaining                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Real trip data       | Native tracking API, raw epoch-ms observations; live movement captured                              | Working with explicit trip ID                                                              | Native push transport/cadence                                                     |
| Road routes          | Native driving-route API                                                                            | Uber recommendation lines                                                                  | Actual driver-selected routeline                                                  |
| Route pulse          | Both native branches recovered; native video confirms2.5s and favors legacy linear-alpha fade       | Legacy reveal1s, delay1s, pulse2.5s, material distance curve; migrated profile also tested | Active-trip flag; screen-distance/raster equivalence                              |
| Native route edge    | Quartic native GL edge alpha, divider mask, palette                                                 | MapLibre line rasterization                                                                | Native GL tessellation/AA comparison                                              |
| Vehicle motion       | Future RoutelineAnimation timeline → spherical playback; target heading; marker reused              | Planner, overlap retention, queue, WGS84 projection and frame sampler ported               | Push transport, server prediction/flag selection and active-trip video comparison |
| Remaining route      | Project animated location onto nearest segment, trim to endpoint                                    | Clipped at animated car location each changing frame                                       | Native driver navigation stream and phase binding                                 |
| Car artwork          | Original product-specific sprite atlas, 64 frames, original sizing/zoom math                        | Working                                                                                    | 3D-vs-sprite flags, full bearing behavior                                         |
| Camera               | Native default300ms; legacy follow500ms,16dp padding                                                | Legacy fit500ms,16CSSpx                                                                    | Camera director/state-specific framing and display-density match                  |
| Waypoints            | Captured20dp pickup/16dp dropoff,4dp centers; source8dp callout radius/padding and24dp corner arrow | Reference circle/square and conditional real-ETA callout; official Uber Move Text font     | Active-trip model binding, font scale/size, RTL, transitions                      |
| Native palette/style | Driver default style URL, cached rider override mechanism; original assets/fonts                    | Default stylesheet adapted                                                                 | Active override; theme/density/collision                                          |
| Session lifecycle    | Expiry, exact trip/account binding, reload on viewer key change                                     | Tested                                                                                     | Visual loading/error parity                                                       |

Acceptance requires fixed viewport, density, theme, route and timestamped telemetry;
frame captures of each phase (dispatching, approach, arrival, riding, cancellation);
then direct image/timeline comparisons. Any unavailable source/runtime branch must
remain identified. Do not mark the overall clone complete while a required row
is unresolved. Live booking tests require the user's authorization; recorded
replays must be labeled as replays.

## Source and runtime ledger

The analysis used REA against the APK above. Evidence records and original
captures remain in private investigation storage; no account telemetry, APK,
login material or private video is shipped in this repository.

- `ym9.b.a`, `w72.k.a`, vehicle adapter `c.b`: spherical frame interpolation,
  target heading assignment, pending-path replacement, reuse of a marker,
  freeze when exhausted. REA `ev_5ee89582976bb75ab3f80342f6cd92923b562dcf24e51b3620153e5c0f63fe81`,
  `ev_f570755e7d7f5a1ba86716be9af86f631b3a95087558b3ab7e1025d2227a267a`.
- `hub.g`, `hub.c`, `TripMapVehicleMapLayerInteractor.Eu`: native relative
  movement planning, timing queue and future timestamp creation. Assigned-car
  delay is zero; the separate nearby-car36000ms setting is not applied.
- `DriverLocationRoutelineStream`, `WaypointRoute.g`, `jub.c`: incoming route
  first point is the native observation; overlapping prior prefixes survive
  shrinking routes. REA `ev_299ebd9be8dcdd7d2912b5f6b6225db82c9ff7a7c0c4dffe9e587f10cb9d718a`,
  `ev_41fe3eb6c717cb78dfeb21627b345e2145b85da420ab4fdf068ac71294d8e545`,
  `ev_60c8b91913ef6936256863e9f534f09b1d222745e4d4ea1e6b114668387fcb74`.
- `mj8.b.b` calls Android `Location.distanceBetween` and widens its float32
  result. `native-geodesy.mjs` ports the Android16 WGS84 calculation, with the
  AOSP license header retained. Numerical fixtures cover zero distance, poles,
  antipodes, transcontinental distance and antimeridian crossing. Seven private
  Java comparison fixtures matched float bits; five nonpersonal fixtures ship.
  An additional14µm separation differs by0.8nm and0.00269° between Java and JS
  math runtimes; universal bit identity is not claimed.
- The migrated pulse has divider cubic(0.4,0,0.2,1), color cubic(1,0,1,1),
  alpha178/255; the legacy pulse reveals over1000ms, begins after1000ms,
  repeats2500ms, divider uses the same material curve, alpha fades linearly
  from255. Evidence `ev_21fb69e9fc9724846cb89326711993e7fb4529d70e18f93424aab2dcf9f5f735`,
  `ev_912b2e086dd6d66f7d1e2c5f88204fd02af6e1c10eae6ff186ccf259e48e8ee2`,
  `ev_b3069416aab2ac7757ad8b672d37ce7cf8f2fdcd084e65764db471988540ed6d`.
- A15s native prebooking video, sampled10fps, confirms the pulse period:
  autocorrelation0.999831 at2.5s. Joint fitting at five route-core samples
  favors legacy alpha255 linear fade (RGB RMSE1.45) over migrated178 curve
  (11.15). This selects the browser's provisional default, not a claim that
  the active-trip runtime flag was inspected. The uncompressed bright route
  is exactly#dedede. Native map display was1080×2364,390dpi (2.4375px/dp).

## Browser adapter boundaries

The motion kernels reconstruct the specified native paths. Their browser adapter
uses native driver pushes with status snapshots as fallback. A recommended
route is accepted for motion only if its first point lies within10m of observed
GPS; otherwise the actual GPS point remains authoritative and the native
route-less fallback is used. Native currentRoute observations use the incoming
route's first point. A shrinking route merges overlapping edges before planning;
the driver sprite is retained across polls. Beyond real observations, movement is permitted only from server-supplied prediction points. These facts do not establish that a routing recommendation
is the driver's selected navigation route.

Resource bounds in this adapter are2000incoming route points,4000retained edges,
and32queued groups. They are implementation limits, not inferred Uber defaults.
The shipped native default catch-up flag is false. Prediction input schema and native playback are recovered, and active-trip delivery
was verified. Remote feature overrides still require runtime verification. The sampler consumes at most one
pending target per frame and assigns the target course directly; generic CSS
heading easing has deliberately not been substituted.

A persistent solid line plus an inverse-color pulse is source-backed. The
user's description of a completed-route fill is not yet established as a
separate historical-trail layer: the recovered native helper removes geometry
behind the animated car. Do not create a fabricated traveled path or present
that inference as runtime observation.

MapLibre line-progress is the browser adapter for native divider progress.
Its tile splitting, projected-distance metrics and edge rasterization are not
proven identical to Uber's GL tessellator/quartic shader. Viewport density,
primary marker/ETA geometry, camera phase handling, active rider stylesheet
override and active-trip reference frames are still required for an exact-clone
claim. The CLI remains fully headless; native captures are investigation inputs,
not a runtime Android dependency.

## Annotation reference profile

The native LTR bottom-start callout uses a rounded body with8dp radius,
8dp horizontal text margins,8dp extra vertical space and a24dp corner path
`M0 24L24 16L8 0L0 24Z`. The body starts8dp right of the geographic tip and
ends8dp above it. Source `CalloutView`, `CalloutMapMarkerView`, `am9.q.d`;
REA `ev_aeb18e0d45d30678a10fd0c4ff11a8944c0298a9052b568c0a13bd40582d4fb7`,
`ev_8f4b43061253754ef08393f133eac398b32958af15c62547c349e67c753d224b`.

The browser uses this geometry and Uber Move Text Medium from the official
Uber website's declared font URL on `tb-static.uber.com`, fetched directly by
the client. The webfont outlines have not been compared with the packaged
Android font. The captured dark callout has body#161616/text#dedede; pickup is
approximately20dp with4dp center, dropoff16dp with4dp center. The20dp pickup is
an observed profile, not fully bound to the packaged16dp anchor default.
Normal font styles are14/16/18sp, a legacy fallback uses12/14/16dp and the
captured device font scale is1.1. Browser16px/20px text is a provisional reference
profile, not proof of the account's selected model/font-size branch. RTL,
long-label wrapping, native union shadow and active-trip annotation transitions
remain unverified. Missing ETAs stay absent rather than being fabricated.

The legacy pulse's opacity is additionally quantized through Android
`ObjectAnimator.ofInt(255,0)` / `Paint.setAlpha(int)`, with float multiplication,
float addition and truncation. The browser matches that8bit evaluator.
REA `ev_ce2b41b384d76e4d92956ece7eaa4f2164e630ada982c83bed48b988b88a4d89`.

## Device framework interpolation

A temporary standalone DEX invoked public Android framework methods through
`app_process` on the connected SDK36 device. It did not install an app, interact
with the Uber UI or make network/account requests. Its own temporary device file
was removed and absence verified. This was an ordinary ADB framework probe,
separate from REA's retained shipped-APK analysis.

The probe captured `Path.approximate(0.002f)` for the exact float control points:
24 samples for route(0.4,0,0.2,1) and23 for hide(0.8,0.2,0.6,1). The browser's
float32 binary search/linear interpolation matches all2002 independent calls to
the device's actual `PathInterpolator.getInterpolation` exactly (1001 per curve).
The selected legacy reveal and route pulse use this captured route table rather
than the analytic cubic. The hide table is retained for subsequent phase wiring;
its availability is not a claim that every cancellation transition is implemented.

The platform table is tied to this reference framework version. Other Android
versions can sample a path differently. The migrated profile's analytic curve
and native GL rasterization are separate, still unverified implementation paths.

## Native live transport and predictions

The shipped `z62.z.c`/`c0` channel calls
`https://cn-geo1.uber.com/uber.streaming.ramen.RamenService/RamenStreaming`
using bidirectional HTTP/2 gRPC. OAuth bearer and ordinary mobile headers bind
the saved account; a new `x-uber-streamgate-connection-id` is generated per
connection. The initial proto3 Request with lastSeenSeqId0 is an empty protobuf
inside the five-byte gRPC frame; the request stream stays open. On the Orin,
the recovered endpoint accepted HTTP200application/grpc and returned eight
native heartbeat frames in a bounded30second idle probe. This proves headless
authentication/transport liveness, not active-trip subscription success.

Response tags are1MsgList,2ControlMsg,3HeartBeat,4GraphQL status. Msg tags are
1int64sequence,2topic,3nested UUID,5Content,7requestFeatureAck. Content tags
1enum (1binary protobuf/2JSON),2payload bytes. Receipt ACKs precede selected
consumer processing; unknown topics are acknowledged but never projected.
Requested feature ACKs follow consumption. The native topic is
`trip_driver_location_update_v2`; this is local dispatch, not a fabricated
subscription request. Sequence cursors retain exact64bit values. Reconnects
resume the cursor with fresh headers; UNAUTHENTICATED16 refreshes OAuth.

TripDriverLocationUpdateV2 fields are1path points,2tripUuid,3currentRoute,
4etaToPickup,5etaToPickupString,6etaToPickupStringShort,7prediction,
8encodedCurrentTraffic,9meetupLocation,10isAgentDetached. Path point tags
1/2/3/4/5 are double latitude/longitude/course/epoch/speed; epoch is milliseconds.
Prediction tags1double distanceInMeters,2int64timestamp. Prediction timestamp
**differences are seconds**. The projector exposes only bounded location, route,
prediction and ETA fields for the exact selected trip. Traffic/meetup/detachment
rendering is not claimed implemented.

Native `fab.q.c` maps exact-trip EN_ROUTE push field4 directly through
`ActiveOrderSchema.etaInMinutes`; **etaToPickup is minutes**. The ETA label
preserves server formatted strings, falling back to the numeric minute value;
negative ETA hides it. Formatted string getters in this APK are serializer-only,
so their use in the browser is not evidence of identical native map typography.
The street-view HUD consumes numeric ETA with native plural resources. Ordinary
assigned-trip annotation decoration remains a comparison gap. No ETA is
fabricated from routing distance, booking time or a clock countdown.

`kub.g.F/a`, `c66.o.accept`, and `WaypointRoute.a/d` establish prediction playback:
every real route observation cancels predictions and resets a6000ms debounce.
At expiry, capture the latest server point list; begin at index1, use adjacent
timestamp differences as animation seconds, and schedule the next target after
that duration. Distances are offsets from the original real agent, not cumulative
from the previous prediction. Edge boundaries advance to the next edge; route
end clamps. A new real point cancels timers even if it is behind the previous
predicted agent and suppressed for motion. No server predictions means no
extrapolation. Last accepted motion targets include predictions.

Tests cover real heartbeat bytes, wire ACKs/BigInt cursors, fragmented frames,
backpressure, reconnects, credential generation changes, stalled callbacks,
ETA unit/negative/missing values, stale positions, prediction debounce and
route progression, immediate SSE delivery and terminal-state cancellation.
A real client browser test exercises streamed ETA changes, persistent sprites,
intermediate positions, route trimming and pulse frames in both themes. Its
coordinates are synthetic. The subsequent real-trip validation below verifies delivered ETA/currentRoute/
prediction data; frame-by-frame visual parity with Android remains unverified.

Retained REA evidence for the new wire and playback contract includes:
`ev_56df2dda860cd18200fc7992ac3953803136d6ca4c2c08034a41bf5f358aa443`
(content decoding),
`ev_8d154911dab8a733fd3005e120d6370a2e18fd1452ede01e0887bb635dd14db9`
(receipt ACK),
`ev_340dd28e7472cd7efea299b426bf2685f823c9501256d405b852d18986af6287`
and `ev_3a4166aa094b4d80bc3641469201088f45a407e124931fee025b6dbb9c80a6b8`
(driver Wire adapter),
`ev_66513deb9d903e9a7fd858dbbcf73484e02c725b8a9f3c899b1b9fb671d19c1c`
and `ev_bc3a1528e360d88309f53e1f21537d2900773052c6d610e40ad1345847697c29`
(prediction debounce/cancel),
`ev_7915abcb31f89d92bf30fcec2304a3ebe9c4db914b645826421fc81b9f144e1b`
(recursive prediction timing). Full source bodies and APK stay outside Git.

The production transport and codec were additionally exercised on the headless
Orin with the existing CLI session: one authenticated connection, eight frames,
80wire bytes in30seconds, zero driver messages while idle, clean bounded stop.
The browser smoke test delivered a changed ETA over SSE within3ms on loopback,
retained the car node and sampled144distinct clipped route starts with348pulse
frames; these are synthetic test results, not live-trip smoothness measurements.

## Assigned-driver validation

On2026-10-15 an explicitly approved test ride was booked and then cancelled
through the CLI on the headless Orin. Its Ramen stream delivered exact-trip
`trip_driver_location_update_v2` messages containing currentRoute, a pickup ETA
that changed from3minutes to2minutes, real GPS epochs in milliseconds, and
server predictions with seconds-based timestamps. The iframe displayed the
ETA and car movement; the user confirmed “Looks right; cancel now.” This is
user visual confirmation, not an automated pixel comparison against Android.

A60second private SSE capture contains24projected scene events and16distinct
native stream sequences, with11–16prediction points per observation. Replaying
those actual scenes through the motion kernel produced309distinct positions
and cleared the car on terminal state without errors. These measurements do
not prove an identical native frame rate or every route/camera transition.
The browser QA probe waited for the fallback `.driver` class, which is replaced
by `.vehicle-artwork` when original artwork loads; that probe timed out even
while the ETA and motion model were updating. The maintained browser smoke
test now waits for the original artwork and tracks the stable driver ARIA label. It is not counted as a
passing automated live-browser check. The separate synthetic browser check and
user's direct observation remain the visual evidence.

The cancellation preview changed during the test, so the CLI refused the stale
plan before sending a cancellation mutation. A refreshed plan remained within
the approved terms and cancelled successfully. Uber's final receipt reported
no charge and a removed temporary hold; account status confirmed zero active
orders, and the final map scene was ClientCanceled with no car. The temporary
viewer and tunnel were then stopped. Raw scenes, account identifiers, endpoints
with viewer credentials and receipts remain private outside Git.
