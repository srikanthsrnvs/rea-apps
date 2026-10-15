import { once } from 'node:events';
import { mapSessionGuard, mapServerOptions } from './map-server.mjs';
import { createSelectedTripFeed } from './map-live-feed.mjs';

export async function runMapStream({ tripId, duration }) {
  const seconds = mapServerOptions({
    durationSeconds: duration ?? 30,
  }).durationSeconds;
  const isAuthorized = await mapSessionGuard(),
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
        if (!process.stdout.write(JSON.stringify(value) + '\n'))
          await once(process.stdout, 'drain', { signal: abort.signal });
      }
    })()
      .catch(() => stop())
      .finally(() => {
        writing = null;
      });
    return writing;
  }
  function stop() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearInterval(polling);
    abort.abort();
    feed?.close();
  }
  const listener = () => stop();
  process.once('SIGINT', listener);
  process.once('SIGTERM', listener);
  process.stdout.once('error', listener);
  try {
    feed = await createSelectedTripFeed({
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
    if (!['active', 'dispatching'].includes(initial.state)) return;
    timer = setTimeout(stop, seconds * 1000);
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
    process.off('SIGINT', listener);
    process.off('SIGTERM', listener);
    process.stdout.off('error', listener);
  }
}
