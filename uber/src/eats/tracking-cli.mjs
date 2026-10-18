import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { getEatsTracking } from './tracking-service.mjs';
import {
  mapSessionGuard,
  mapServerOptions,
  startMapServer,
} from '../map-server.mjs';
import { requireUUID } from '../plans.mjs';

export async function runEatsTracking(
  values,
  {
    read = getEatsTracking,
    guard = mapSessionGuard,
    startServer = startMapServer,
    output = process.stdout,
    signals = process,
    print = (line) => output.write(`${JSON.stringify(line, null, 2)}\n`),
  } = {},
) {
  const action = values.action ?? 'snapshot';
  requireUUID(values['order-id'], 'Order ID');
  if (action === 'snapshot') {
    const value = await read({ orderId: values['order-id'], raw: values.raw });
    print(value);
    return value;
  }
  const options = {
    host: values.host,
    port: values.port,
    publicUrl: values['public-url'],
    frameOrigins: values['frame-origin'],
    durationSeconds: values.duration ?? (action === 'stream' ? 300 : 3600),
  };
  const config = mapServerOptions(options),
    isAuthorized = await guard(),
    abort = new AbortController();
  let server,
    closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    abort.abort();
    server?.close().catch(() => {
      process.exitCode = 1;
    });
  };
  signals.once('SIGINT', close);
  signals.once('SIGTERM', close);
  output.once('error', close);
  const deadline = setTimeout(close, config.durationSeconds * 1000);
  const cleanup = () => {
    clearTimeout(deadline);
    signals.off('SIGINT', close);
    signals.off('SIGTERM', close);
    output.off('error', close);
  };
  const getScene = async () => {
    if (closed || !(await isAuthorized()))
      throw new Error('Delivery tracking session changed');
    const scene = await read({ orderId: values['order-id'] });
    if (closed || !(await isAuthorized()))
      throw new Error('Delivery tracking session changed');
    return scene;
  };
  try {
    if (action === 'serve') {
      server = await startServer(options, {
        getScene,
        isAuthorized,
        onClose: () => {
          close();
          cleanup();
        },
        fidelity: { updates: 'native_eats_polling' },
      });
      if (closed) {
        await server.close();
        return;
      }
      print({
        mapUrl: server.mapUrl,
        expiresAt: server.expiresAt,
        listening: server.listening,
        orderId: values['order-id'],
        workflowId: server.tripId,
        state: server.state,
        fidelity: server.fidelity,
        eventsUrl: new URL('./events', server.mapUrl).href.split('#')[0],
        lifecycle:
          'Foreground read-only tracking server. Keep running until delivery, expiry or SIGINT/SIGTERM. The viewer credential is the URL fragment; send it as a Bearer header to /events.',
      });
      return server;
    }
    let cursor = Number(values.after ?? 0),
      initial = true;
    const emit = async (value) => {
      if (closed) return;
      if (!(await isAuthorized()))
        throw new Error('Delivery tracking session changed');
      if (!output.write(`${JSON.stringify(value)}\n`))
        await once(output, 'drain', { signal: abort.signal });
    };
    while (!closed) {
      try {
        const scene = await getScene();
        if (initial && cursor > (scene.eventCursor ?? 0))
          throw Object.assign(
            new Error('The tracking cursor is ahead of the saved event log'),
            { code: 'EATS_CURSOR_INVALID' },
          );
        initial = false;
        const oldest = scene.deliveryEvents?.[0]?.sequence;
        if (oldest && cursor && cursor < oldest - 1)
          await emit({ event: 'gap', after: cursor, oldestAvailable: oldest });
        for (const event of scene.deliveryEvents ?? [])
          if (event.sequence > cursor) {
            await emit({ event: 'delivery', ...event });
            cursor = event.sequence;
          }
        await emit({ event: 'scene', scene });
        if (scene.state === 'ended') break;
      } catch (error) {
        if (closed) break;
        if (initial || error.code === 'EATS_CURSOR_INVALID') throw error;
        if (!(await isAuthorized()))
          throw new Error('Delivery tracking session changed');
        await emit({
          event: 'refresh-error',
          message: 'Delivery status refresh failed; retrying',
        });
      }
      await delay(8000, undefined, { signal: abort.signal });
    }
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    if (action !== 'serve' || !server) {
      close();
      cleanup();
    }
  }
}
