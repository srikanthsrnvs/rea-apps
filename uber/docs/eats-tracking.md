# Delivery tracking

`uber eats track` is the seventh Eats tool. It is read-only and shares the saved
Uber login. `--order-id` selects one workflow or native order ID. It never switches
to the account's next active order, changes a cart, sends a message or cancels food.

## Commands and lifetime

```sh
uber eats track --order-id WORKFLOW_UUID
uber eats track --action stream --order-id WORKFLOW_UUID --duration 300
uber eats track --action stream --order-id WORKFLOW_UUID --after 42 --duration 300
uber eats track --action serve --order-id WORKFLOW_UUID \
  --host 0.0.0.0 --port 8787 --public-url https://tracking.example/delivery/ \
  --frame-origin https://client.example --duration 3600
```

Snapshot exits after one read. Stream emits NDJSON until verified completion,
deadline or SIGINT/SIGTERM. Serve returns `mapUrl`, `eventsUrl`, `expiresAt` and
listening details; its foreground HTTP server stays running until expiry or signal.
The public URL must already route to the listening port. No tunnel, browser, Android
or other food service is started automatically. MapLibre and Uber's public map
assets load in the client's browser; server runtime remains Node built-ins only.

An explicit tracker observes native `POST /rt/eats/v2/eaters/active-orders` snapshots
at eight-second intervals. HTTP viewers share one cached read, including failures.
Keep a stream or SSE client connected to observe transitions continuously. An absent
active order becomes `unavailable` until history verifies its completion. Verified
terminal scenes cannot revert to active, remove the moving courier and stop upstream
map reads. The public projection includes no phone numbers, action tokens,
payment credentials, messages or unrelated orders.

## Events

NDJSON emits `event: "scene"` snapshots and `event: "delivery"` changes. For example:

```json
{
  "event": "delivery",
  "id": "WORKFLOW_UUID:43",
  "sequence": 43,
  "type": "stage_changed",
  "stage": "time_to_meet_courier",
  "previousStage": "on_the_way",
  "orderId": "ORDER_UUID",
  "workflowId": "WORKFLOW_UUID",
  "observedAt": "2026-10-18T02:00:00.000Z"
}
```

The scene exposes `eventCursor` and a bounded `deliveryEvents` list. Event types:

| Type                                                                                                    | Meaning                                                          |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `snapshot`                                                                                              | The first observed state; does not fabricate earlier transitions |
| `stage_changed`                                                                                         | Native stage, status title or progress changed                   |
| `order_received`, `preparing`, `courier_to_restaurant`, `on_the_way`, `time_to_meet_courier`, `arrived` | A newly observed native stage                                    |
| `delivered`, `cancelled`, `failed`                                                                      | Matching history confirms a native terminal outcome              |
| `courier_assigned`, `courier_unassigned`                                                                | Assigned courier identity changed                                |
| `courier_location`                                                                                      | A new native courier coordinate                                  |
| `eta_changed`, `delay_changed`, `activity_changed`                                                      | Server presentation or estimate changed                          |

Retain the last sequence with `--after` to resume NDJSON. The latest 128 events are
saved atomically in the private account state. Older cursors produce `event: "gap"`;
future cursors are rejected. Events represent observation time, not an assertion of
the exact time a transition happened. Stages skipped between observations are not
backfilled. ETA and courier movement are separate events.

SSE is available at `eventsUrl`. Read its key from the `mapUrl` fragment and send
`Authorization: Bearer KEY`; never put it in a query. Resume with
`Last-Event-ID: WORKFLOW_UUID:43`. The server rejects a cursor for another order or
ahead of its log and reports retention gaps. Reconnection is at-least-once delivery:
deduplicate by event ID. Errors are `refresh-error`; expiry/logout are
`expired`/`revoked`. The server denies arbitrary cross-origin reads.

## Iframe hooks

Set one or more exact `--frame-origin` values when starting serve. A permitted
parent can subscribe without making a cross-origin API request:

```js
const frame = document.querySelector('iframe');
const viewerOrigin = new URL(mapUrl).origin;
frame.src = mapUrl;
window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || event.origin !== viewerOrigin)
    return;
  if (event.data.type === 'uber-eats:ready') {
    frame.contentWindow.postMessage(
      { type: 'uber-eats:subscribe' },
      viewerOrigin,
    );
  }
  if (event.data.type === 'uber-eats:snapshot') render(event.data.scene);
  if (event.data.type === 'uber-eats:delivery')
    handleDeliveryEvent(event.data.event);
  if (event.data.type === 'uber-eats:unavailable') stopTracking();
});
frame.addEventListener('load', () => {
  frame.contentWindow.postMessage(
    { type: 'uber-eats:subscribe' },
    viewerOrigin,
  );
});
// Later:
frame.contentWindow.postMessage(
  { type: 'uber-eats:unsubscribe' },
  viewerOrigin,
);
```

The iframe sends a credential-free `uber-eats:ready` message to the configured
origin once its first scene is available, so the parent need not wait for every map
image to finish loading. It then checks the actual parent window and exact configured origin before
sharing its closed scene or events. It never broadcasts to `*`, shares the viewer
key, or enables message subscriptions when the allowlist is empty. Expiry, logout,
account replacement and parent-origin removal revoke access. Local document events
`deliverychange` and `deliveryevent` are also available inside the iframe.

## Native evidence and limits

REA/JADX 0.7.1 inspected the installed Eats APK (SHA-256
`f25b14fb027b905a6cdda40501940a715694a1fbc7cabc486178bbce11091263`).

- Native status selection prefers `orderFeedV2.header.activeOrderStatus` over
  `activeOrderStatus`: `ev_8052c457afd178ad31fc1bc8e3bf5d3b733adc3b52f1d20b467520d9ffd4902b`.
- UI stage ordinals are `0 CONFIRM`, `1 PREPARATION`, `2 EN_ROUTE_TO_RESTAURANT`,
  `3 EN_ROUTE_TO_EATER`, `4 TIME_TO_MEET_COURIER`, `5 ARRIVED`:
  `ev_c343e5c05837fa4038add68bc1cc092b9fcf0637f991c94efaa34935ff47d451`,
  native consumer `ev_0d1c838d18b917294699e0699d3201ece316e94c4b8bc3a1c43152f3f03a636c`.
  The CLI applies these to the verified five-segment layout. Unknown layouts retain
  their native values. Meeting/arrival never establishes successful delivery.
- Native map entities and route legs:
  `ev_8053b0ab1fdcaa61de4641db09801f105c54741cb71e67cfde2879c2f130cae6`,
  `ev_9fa3e6db51df8622db4d65006db6e7f1724039acb6e93c56434e1d1f6526e3de`.
  The native route caller concatenates leg polylines at precision 1e-5 and uses the
  first point for the courier: `ev_18b30e245c238f8e625163610bc1d9326571de42764f5ecc0015e82489c023ef`.
- History completion enum:
  `ev_7b6f9c55395114988be2a5b4a90d490305cc2664810a2983dd0e882ca6002f85`.
  `SUCCESS` means delivered; native eater/ops/restaurant cancellation and failed
  delivery outcomes remain distinct. Unknown completion states stay unavailable.
- Server analytics expose `order_status`, `cfc_state` and ETA epochs as open values;
  their complete vocabulary was not recovered. The CLI preserves a closed selection
  and uses native UI stages first, rather than parsing translated English titles.

Live headless verification used an existing real delivery: native courier coordinates,
vehicle sprite, road route, ETA and progress were rendered in a development browser
on the Mac. The implementation reuses the previously recovered ride motion/pulse
kernel. Exact Eats-specific animation timing, camera parity and native push transport
remain unverified. Courier GPS epochs are not fabricated from HTTP receipt time.
No additional food order or cancellation is necessary to read tracking.
