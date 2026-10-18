import { authenticatedStreamContext, refresh } from './client.mjs';
import { createRamenTransport } from './ramen-transport.mjs';
import {
  encodeRamenRequest,
  decodeRamenResponse,
  decodeTripDriverPayload,
} from './ramen-codec.mjs';
import { MapLiveProjection } from './map-live.mjs';
import { RideEvents } from './ride-events.mjs';

export function createLiveMapFeed(
  {
    tripId,
    getSnapshot,
    isAuthorized,
    durationMs = 3600000,
    onState = () => {},
  },
  {
    startTransport = createRamenTransport,
    getContext = authenticatedStreamContext,
    refreshSession = refresh,
    now = Date.now,
  } = {},
) {
  const projection = new MapLiveProjection(tripId, { now }),
    listeners = new Set(),
    events = new RideEvents();
  let transport = null,
    closed = false,
    state = { state: 'not-started' };
  const publish = (value) => {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {
        /* isolated viewer */
      }
    }
  };
  const metadata = (scene) => ({
    ...events.observe(scene),
    liveTransport: {
      ...scene.liveTransport,
      state: state.state,
      mode: 'ramen_grpc',
    },
  });
  function start() {
    if (transport || closed || !projection.tripId) return;
    transport = startTransport({
      durationMs,
      encodeRamenRequest,
      decodeRamenResponse,
      assertOwner: async () => !closed && (await isAuthorized()),
      getContext: async ({ reason, signal }) => {
        if (signal.aborted || closed || !(await isAuthorized()))
          throw new Error('Map session changed');
        if (reason === 'GRPC_UNAUTHENTICATED') await refreshSession();
        if (signal.aborted || closed || !(await isAuthorized()))
          throw new Error('Map session changed');
        return getContext();
      },
      onState: (update) => {
        state = update;
        onState(update);
        if (!closed && projection.latest) publish(metadata(projection.latest));
      },
      onMessage: async (message, { signal }) => {
        if (closed || signal.aborted || !(await isAuthorized())) return;
        let update;
        try {
          update = decodeTripDriverPayload(
            message.contentType,
            message.payload,
          );
        } catch {
          onState({
            state: 'message-rejected',
            code: 'INVALID_DRIVER_PAYLOAD',
          });
          return;
        }
        if (closed || signal.aborted || !(await isAuthorized())) return;
        const scene = projection.accept(update, message.seq);
        if (scene) publish(metadata(scene));
      },
    });
    transport.done.catch(() => {});
  }
  return {
    async read() {
      if (closed || !(await isAuthorized()))
        throw new Error('Map session changed');
      const snapshot = await getSnapshot();
      if (closed || !(await isAuthorized()))
        throw new Error('Map session changed');
      const scene = projection.snapshot(snapshot);
      if (['active', 'dispatching'].includes(scene.state)) start();
      else if (transport) {
        transport.stop();
        transport = null;
      }
      return metadata(scene);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      transport?.stop();
    },
  };
}

export async function createSelectedTripFeed(
  { tripId, isAuthorized, durationMs, onState },
  { getMap } = {},
) {
  const readMap = getMap ?? (await import('./trip-map.mjs')).getTripMap;
  let selected = tripId;
  return createLiveMapFeed({
    tripId,
    isAuthorized,
    durationMs,
    onState,
    getSnapshot: async () => {
      let scene;
      try {
        scene = await readMap({ tripId: selected });
      } catch (error) {
        if (error.code !== 'TRIP_NOT_FOUND' || !selected) throw error;
        return {
          schemaVersion: 1,
          observedAt: new Date().toISOString(),
          state: 'unavailable',
          tripId: selected,
          pollingIntervalMs: 8000,
          driver: { position: null, path: [] },
          routes: [],
          waypoints: [],
          eta: {},
          warnings: [
            'The selected trip is absent from the current status response.',
          ],
        };
      }
      if (scene.tripId) selected ??= scene.tripId;
      return scene;
    },
  });
}
