import { once } from 'node:events';
import { mapSessionGuard, mapServerOptions } from './map-server.mjs';
import { createSelectedTripFeed } from './map-live-feed.mjs';

export async function runMapStream(
  { tripId, duration },
  {
    createFeed = createSelectedTripFeed,
    createGuard = mapSessionGuard,
    output = process.stdout,
    signals = process,
    setDeadline = setTimeout,
  } = {},
) {
  const seconds = mapServerOptions({
    durationSeconds: duration ?? 30,
  }).durationSeconds;
  const isAuthorized = await createGuard(),
    abort = new AbortController();
  let closed = false,
    feed,
    timer,
    polling,
    reading = false,
    queued = null,
    writing = null;
  // Coalesce state snapshots under output backpressure; never accumulate an
  // unbounded history of routes if a pipe's consumer stops reading.
  function emit(value) {
    if (closed) return Promise.resolve();
    queued = value;
    if (writing) return writing;
    writing = (async () => {
      while (queued && !closed) {
        const value = queued;
        queued = null;
        if (!output.write(JSON.stringify(value) + '\n'))
          await once(output, 'drain', { signal: abort.signal });
      }
    })()
      .catch(() => stop())
      .finally(() => {
        writing = null;
      });
    return writing;
  }
  function stop() {
    feed?.close();
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearInterval(polling);
    abort.abort();
  }
  const listener = () => stop();
  signals.once('SIGINT', listener);
  signals.once('SIGTERM', listener);
  output.once('error', listener);
  try {
    // Start the deadline before the first write: even a stalled consumer must
    // release the native stream and its listeners without waiting for drain.
    timer = setDeadline(stop, seconds * 1000);
    feed = await createFeed({
      tripId,
      isAuthorized,
      durationMs: seconds * 1000,
      onState: (state) => {
        emit({ event: 'transport', ...state });
        if (state.state === 'revoked') stop();
      },
    });
    if (closed) return;
    feed.subscribe((scene) => emit({ event: 'scene', scene }));
    const initial = await feed.read();
    await emit({ event: 'scene', scene: initial });
    if (closed || !['active', 'dispatching'].includes(initial.state)) return;
    polling = setInterval(async () => {
      if (closed || reading) return;
      reading = true;
      try {
        if (!(await isAuthorized())) {
          stop();
          return;
        }
        const scene = await feed.read();
        await emit({ event: 'scene', scene });
        if (scene.state === 'ended') stop();
      } catch {
        emit({ event: 'refresh-error' });
      } finally {
        reading = false;
      }
    }, 8000);
    if (!abort.signal.aborted) await once(abort.signal, 'abort');
  } finally {
    stop();
    signals.off('SIGINT', listener);
    signals.off('SIGTERM', listener);
    output.off('error', listener);
  }
}
