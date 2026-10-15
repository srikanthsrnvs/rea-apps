# Android map reconstruction

The iframe viewer is an experimental reconstruction. It uses Uber's own map
cartography and original vehicle artwork where available. It is **not yet a
pixel-identical or behavior-identical port of the Android map**. Booking and
authentication remain HTTP-only on the headless host; the client's browser
renders the iframe. No Android runtime, emulator, screenshot stream, browser
process, or developer map key is required on the server.

## What the shipped app establishes

Target: Uber Android 4.651.10003, base APK SHA256
`2a92686a421d1d37bd16d287869ac9dbc5c71f36a6b0793b187f0a2bc1c24a91`.
Installed version and update metadata matched this retained APK on 2026-10-15.
Private APKs, account responses, screenshots, fonts, and evidence are excluded
from the repository. Evidence IDs below refer to retained REA observations;
decompiled code is static evidence, rather than an observed execution trace.

| Question | Evidence and result | Remaining boundary |
| --- | --- | --- |
| Can the Android view itself run in an iframe? | `UberMapView` initializes `NativeMapView` and `UBMMap`; packaged ARM64 libraries depend on Android EGL/GLES/JNI. REA `ev_5c877cfc6af1ce00db777ef3b86a4d68f928952e537a39dcfd538760129d6431`. | It is a native renderer. Reusing data/assets is separate from executing that binary in a browser. |
| Can we obtain the actual cartography? | `UberMapView.setDefaultStyle` declares `https://tc2.uber.com/style/default/native?o=DEFAULT`, REA `ev_a4bc38c4a12c501e716c595ee8716b7d8d0e07aa2fcef9e2c9ef3cc16de2ca6f`. Live GET returned the style plus vector-source manifests, sprites and glyph templates. Sample vector tile, glyph range, sprite JSON and sprite PNG returned 200. | Public responses were accessible for these probes. Future availability and the active rider's dynamic style override are not guaranteed. |
| Is there a separate auto style? | `in9.a` defines both default and `https://tc2.uber.com/style/auto/native?o=DEFAULT`; REA `ev_229692aff0cb6ef7321f1f366f5453ffd2619d62115f6c27d55b492db151614a`. Both URLs returned styles. | The default currently names itself `uber-stylesheet-driver`. The prototype deliberately names its source; it does not infer active rider configuration from that name. |
| How is dark mode applied? | `UberMapView.setNightModeEnabled` adds/removes the `night` style class. The style has `paint.night` and `layout.night` overrides. | The adapter merges this class; other native class combinations are not reproduced. |
| What draws the car? | `bn9.c.a` selects optional glTF or 2D renderers (`ev_5c05f1f4c4fa03b6366b8032c943b0a77aacbf439c8b7ba92f4ed73fb7eed2fb`). Saved shopping responses supply `productContext.presentation.standardMapIcon`, `spritesheetMapIcon`, and `spriteDivisionCount`. | Runtime feature flags decide the branch. A 3D-looking car is not by itself proof of the glTF branch. |
| Can we reuse vehicle artwork? | A returned UberX sprite URL downloaded as a 7168×112 PNG with 64 square frames; the response explicitly supplies 64 divisions. Standard icon is 112×112. | The CLI saves the exact selected product's artwork during a new booking. Older or externally booked trips may only expose a standard trip icon, or no icon. It never substitutes UberX for another product. |
| What is the frame selection? | `bn9.s.onDraw`: `floor(normalizedRotation / 360 * (numSprites - 1))`, REA `ev_e045323afaab9d2c6733b76aa1c0ef6217d76808fb9cd49cbce79e71fc471c2f`. `setRotation` subtracts the controller offset (`ev_7bf5b0406801bf5cc88a611917692c844f5971f2cfd38165b939e4d8b8350ee2`). | Legacy projection binds the offset to camera bearing. The complete rotated-camera update sequence and MMDF behavior need parity testing. |
| What is the vehicle size? | Compiled resources specify 56dp base; standard fallback scale is 5/7, or 40dp. Legacy `bn9.l.a` clamps sprite scale to `0.25 + (zoom-10)/6 * 0.75`, between 0.25 and 1 (`ev_82d2917b4f3892620bb326c4587022704096038a99c23f8e9a852778150ab581`). | Show/hide animation, alternate renderer scaling and device-density rasterization are not yet matched. |

The cartography uses Uber's `8_u1` extension of a version-8 style. The browser
adapter expands legacy `ref` layers, applies the night class, and preserves
source URLs, glyphs, sprites, paint and layout values. It reports unsupported
native properties, including density/collision padding, `is-stroke` metadata,
and insertion-point metadata. Dropping these properties is not evidence of
visual equivalence. The browser uses pinned MapLibre GL JS 6.14.0; its style
format is documented in the [MapLibre style specification](https://maplibre.org/maplibre-style-spec/).

## Trip data and update behavior

The existing authenticated read endpoint is `POST /rt/riders/me/status` with
body `{}`. A fresh native ARM64 Linux read on 2026-10-15 returned idle state
and `metadata.pollingIntervalMs:8000`; no driver coordinates were invented.
The map projection accepts these recovered paths:

```text
Legacy:
  fulfillmentStateData.orders[].orderPlan.jobs[].legacyTripData.trip
  trip.vehicle.vehiclePath[] = {latitude,longitude,course,epoch,speed}
  trip.currentRoute, trip.legs[].encodedPolyline
  trip.pickupLocation, trip.destination, trip.viaLocations

Modern:
  riderAppOrdersResponse.orders[].jobs.singlePersonalTransport.transport
  transport.provider.vehicle.vehiclePath[]
  transport.waypoints[].transportJobWaypointType.{pickup,dropoff,via}WaypointView.location.location
  riderAppOrdersResponse.features[order.id].mapRoutelineFeature
  feature.encodedProviderPolyline, feature.legs[].encodedPolyline
  feature.vehicleMapIconUrl
```

Single-order responses carry their features directly. Multiple transport jobs
require explicit trip selection. The normalizer merges compatible same-trip
representations without switching to another trip, and returns no account,
payment, driver phone or authentication objects.

Key source observations:

- Vehicle-path parser: `ev_e798a8c833de4f7b839d0cc6bda7742ead3abeca3a602c8c0cbca7c29c809e2c`.
- Path-point parser: `ev_624291e31d99aed5f393e77260c04730c0c7f614340937d561db524779d07e61`; epoch is `TimestampInMs`.
- Modern route-feature parser: `ev_fdf1de88db1c83e86bea5813d195c090b5bef3890b32d6cfae7216d8c96c81eb`.
- Map-hub routing decodes with factor `1e-5`: `ev_d6c0ee029d82ac2db142e6d51a056b377277a88787bcecd5ca1cd9592cc07f1f`. The exact current-trip leg consumer remains a separate caller-coverage gap.
- Native driver-location factory: `ev_22ca6342287473710ca7cd5f4da172ab8f64dcdd2c5bcbb893993f503e49931b` prefers a separate `TripDriverLocationUpdateV2` stream for en-route trips and otherwise uses snapshot data.

`map` remains a snapshot read. `map serve` and `map stream` now connect to the
native Ramen HTTP/2 gRPC stream and consume only the selected trip's
`trip_driver_location_update_v2` messages. They retain shared status polling
(minimum8seconds) for lifecycle/fallback data. Native pickup ETA is in minutes;
server currentRoute and prediction points feed the reconstructed motion queue.
The iframe receives authenticated SSE events immediately instead of waiting for
the next browser poll. The stream owner is bound to the saved login generation;
refresh happens in short transactions and does not lock other CLI operations.

On2026-10-15 the Orin authenticated to the recovered stream, then received
actual assigned-driver messages during an approved real-trip test. These carried
pickup ETA, currentRoute and prediction points. The user confirmed the ETA and
car movement looked right. Cancellation completed; the final receipt reported
no charge, and account status reported zero active orders. See the [transport and prediction contract](map-parity.md#native-live-transport-and-predictions)
for the wire contract, tests and remaining verification limits.

## Runtime and embedding

```sh
uber map --trip-id TRIP_UUID
uber map stream --trip-id TRIP_UUID --duration 30
uber map serve --trip-id TRIP_UUID
```

`map serve` prints JSON containing `mapUrl` and `expiresAt`, then remains running.
The URL is an expiring read-only viewer lease, separate from Uber credentials.
It contains a viewer key in its fragment; scene requests send that key in a
header. Keep the complete URL private to its intended viewer. State endpoints
have no permissive CORS. Referrers are disabled, and the page and state responses
are not cached. Logout/account change revokes scene access. The server binds to
the selected trip and clears its positions if that trip disappears, without
claiming an unconfirmed reason for its disappearance.

For a separate client, place this foreground process behind a reachable HTTPS
reverse proxy. The proxy must preserve the configured path prefix:

```sh
uber map serve --trip-id TRIP_UUID --port 8765 \
  --public-url https://orin.example/uber-map/ \
  --frame-origin https://client.example
```

Embed the exact returned URL:

```html
<iframe src="RETURNED_MAP_URL" title="Ride map"
        style="border:0;width:100%;height:600px"></iframe>
```

`--host 0.0.0.0` permits direct network listening and requires `--public-url`.
Use HTTPS when the containing client page is HTTPS; browsers block insecure
mixed-content iframes. `--frame-origin` can repeat to restrict permitted parents;
omitting it allows embedding from any parent with the complete viewer URL.
The viewer needs scripts and CSS from the pinned MapLibre distribution on
unpkg.com and map assets from Uber's hosts. The CLI host runs only Node HTTP.
Default lifetime is one hour; `--duration` accepts 10–86400 seconds. SIGINT or
SIGTERM shuts the server down. No tunnel, DNS entry or certificate is created
implicitly by this command.

In Docker, publish the chosen port and use a named state volume as in the
container installation guide. The viewer uses a per-transaction kernel lock,
shared with other CLI containers; it does not hold the command lock for the
whole viewer lifetime. Native installations use the existing local state mutex.

Successful booking output now includes the command for opening that trip's map.
Artwork is optional metadata: failure to save it cannot change an accepted
booking into an apparent purchase failure, and it never retries a ride request.

## Verification and open work

- Native Android route-choice screenshot captured without dispatching a ride.
- Original cartography rendered in a browser with actual vector tiles, sprites,
  glyphs and night styling. This is a real map render, not a screenshot background.
- Cross-origin iframe harness uses synthetic trip coordinates to exercise route,
  markers, original vehicle artwork, zoom and recentering. Synthetic movement or
  coordinates are not presented as a real active ride.
- Automated tests cover geometry limits, response variants, exact trip selection,
  missing/terminal states, map-data privacy, viewer authorization and expiry,
  account revocation, shared polling, error backoff, styles and sprite math.
- Regression tests cover native sharing redirects, account-scoped token caching,
  exact trip matching, cancelled/revoked states and failed order fetches. Browser
  QA checks initial failure, recovery, stale-location labels and empty-state hiding.

Remaining work for the requested identical clone: verify the active rider style
and feature flags; match native density/collision rules, waypoint and ETA
annotations, camera framing and transitions; compare the delivered prediction
timeline frame by frame against Android during an
explicitly authorized real trip.

A real test ride on 2026-10-15 exposed a live-data failure: the status response
reported Dispatching, `isAllRiderAppOrdersEnabled: true`,
`riderAppOrdersFetchSucceeded: false`, and null fulfillment orders. The browser
could not obtain trip geometry and displayed its default world camera. The ride
was cancelled; Uber's receipt reported no charge. This live test failed.

The projection now reports `MAP_TRIP_FETCH_FAILED` for that server response,
and startup rejects non-idle scenes without valid coordinates. The browser keeps
the map hidden until real coordinates arrive, instead of displaying a default
world camera. These changes prevent misleading output; they do not establish a
working assigned-driver feed. The native `/client-status` response contains only
`clientStatus`, so it cannot repair the missing trip data. The order-fetch failure
is bypassed for explicitly selected rides using the native sharing data API.

`ShareApi.shareTrip` supplies the selected ride's official link via
`GET /rt/trips/{tripUUID}/share-yo-ride?shareTripType=RIDER_SHARE`.
Following first-party redirects without account credentials yields its tracking
token. `ShareClient.a` / `ks3.i.apply` establish
`POST /rt/sharetrip/fetch` with `{request:{shareToken,usePolylines:false}}`.
The token stays on the CLI host; only the closed map projection reaches the
iframe. Resolution is cached in memory for one minute, scoped to rider and trip.
Neither retrieving a link nor fetching its data sends messages to contacts.

The headless Orin retrieved the exact cancelled test trip through this API,
including correct pickup/destination and `status:ClientCanceled`. The scene
now recovers from missing account-status trip data without claiming the trip is
still active. The official share page itself returned HTTP 404 after redirecting
to m.uber.com and declared SAMEORIGIN; it is not used as an embedded map.
Driver coordinates, when present, require plausible recent millisecond
observations. Unknown timestamp units are omitted instead of guessed. The source
also honors `hideRouteline`. A later live test verified fresh timestamped car coordinates and movement in the
browser; exact native animation and pixel parity remain unverified.


A second explicitly authorized live test established a native response switch:
`usePolylines:true` returns an encoded car position under `routeLines[id=car]`
and null `locations`. Requesting `false` returns timestamped `locations` with
latitude, longitude, course, and millisecond epoch. The map now requests raw
locations rather than treating the encoded car track as a passenger routeline.


The live test also confirmed that raw tracking locations do not include the
approach road geometry. Native `RoutingApi.fetchRouteline` exposes
`POST /rt/routing/fetch-routelines` with direct `{origin,destination,type:"DRIVING"}`
(RoutelineRequest and rtapi.models.location.Location writers). The CLI now uses
that native endpoint when an active selected ride lacks routelines. It requests
separate driver-to-pickup and pickup-to-destination recommendations, or
current-position-to-destination after the trip begins. It checks decoded endpoints,
respects hidden routes, skips unsupported via routes, and preserves positions if
routing fails. These lines are explicitly tagged as Uber routing recommendations;
they are not claimed to reveal the driver's selected navigation path.

The second live test was cancelled on request. Uber's final receipt reported no
charge and removal of its $7.95 authorization hold. No further ride was booked.
The viewer also reloads when a renewed URL changes its fragment, preventing an
old tab from continuing to use the previous access key.
