import { getTripMap } from './trip-map.mjs';
import { getTripShareLink } from './trip-share.mjs';
import {
  mapServerOptions,
  mapSessionGuard,
  startMapServer,
} from './map-server.mjs';
import { createSelectedTripFeed } from './map-live-feed.mjs';
import { runMapStream } from './map-stream-cli.mjs';
import { requireUUID } from './plans.mjs';

// CLI adapters own argument validation and process lifetime; the map services
// remain independent of stdout and process signals.
export async function runMapCommand(command, values, print) {
  if (values['trip-id']) requireUUID(values['trip-id'], 'Trip ID');
  if (command === 'map link') {
    if (values.confirm || values['dry-run'] || values.raw)
      throw new Error('Map link is a read-only trip-link request');
    print(await getTripShareLink(values['trip-id']));
    return;
  }
  if (command === 'map') {
    if (
      ['host', 'port', 'public-url', 'frame-origin', 'duration'].some(
        (key) => values[key] !== undefined,
      )
    )
      throw new Error('Viewer settings belong to uber map serve');
    print(await getTripMap({ tripId: values['trip-id'] }));
    return;
  }
  if (command === 'map stream') {
    requireUUID(values['trip-id'], 'Trip ID');
    if (
      values.raw ||
      values.confirm ||
      values['dry-run'] ||
      ['host', 'port', 'public-url', 'frame-origin'].some(
        (key) => values[key] !== undefined,
      )
    )
      throw new Error('Map stream supports --trip-id and --duration');
    await runMapStream({
      tripId: values['trip-id'],
      duration: values.duration,
    });
    return;
  }
  if (command !== 'map serve')
    throw new Error(`Unknown map command: ${command}`);
  if (values.raw || values.confirm || values['dry-run'])
    throw new Error('Map serve supports read-only viewer settings');
  const options = {
    host: values.host,
    port: values.port,
    publicUrl: values['public-url'],
    frameOrigins: values['frame-origin'],
    durationSeconds: values.duration,
  };
  const validated = mapServerOptions(options);
  const isAuthorized = await mapSessionGuard();
  const feed = await createSelectedTripFeed({
    tripId: values['trip-id'],
    isAuthorized,
    durationMs: validated.durationSeconds * 1000,
  });
  let viewer;
  try {
    viewer = await startMapServer(options, {
      isAuthorized,
      getScene: () => feed.read(),
      subscribeToScenes: (listener) => feed.subscribe(listener),
      onClose: () => {
        feed.close();
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      },
    });
  } catch (error) {
    feed.close();
    throw error;
  }
  const { mapUrl, expiresAt, listening, tripId, state, fidelity } = viewer;
  print({
    mapUrl,
    expiresAt,
    listening,
    tripId,
    state,
    fidelity,
    lifecycle:
      'Foreground server; keep this command running. Stop with SIGINT/SIGTERM or wait for expiry.',
  });
  function stop() {
    viewer.close().catch(() => {
      process.exitCode = 1;
    });
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
