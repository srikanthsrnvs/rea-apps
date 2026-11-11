import { publicError } from './errors.mjs';

// Finite samples keep both model calls and one-shot CLI processes bounded. The
// initial callback can occur before start() returns its watcher.
export async function sampleStream(start, { seconds, maxUpdates, signal, transform, now = () => new Date().toISOString() }) {
  const updates = [];
  let finish, settled = false, timer, watcher;
  const done = new Promise(resolve => { finish = result => { if (!settled) { settled = true; resolve(result); } }; });
  const abort = () => finish({ reason: 'aborted' });
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw signal.reason;
    watcher = await start({
      onData: (...args) => {
        if (settled) return;
        try {
          const data = transform(...args);
          if (data === undefined) return;
          updates.push({ receivedAt: now(), data });
          if (updates.length >= maxUpdates) finish({ reason: 'max_updates' });
        } catch (error) { finish({ reason: 'error', error }); }
      },
      onError: error => finish({ reason: 'error', error }),
    });
    timer = setTimeout(() => finish({ reason: 'duration' }), seconds * 1000);
    watcher.closed.then(() => finish({ reason: 'disconnected' }), error => finish({ reason: 'error', error }));
    const result = await done;
    if (signal.aborted) throw signal.reason;
    if (result.error && !updates.length) throw result.error;
    return { updates, completedBecause: result.reason, monitoringContinues: false,
      ...(result.error ? { streamError: publicError(result.error) } : {}),
      warnings: ['disconnected', 'error'].includes(result.reason) ? ['STREAM_INTERRUPTED'] : [] };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    settled = true;
    await watcher?.stop();
  }
}
