/** Bounded native Ramen transport. No session I/O or logging.
 * Native sources: see docs/map-parity.md.
 * getContext MUST finish its short auth/state transaction before returning; the
 * transport never enters an authentication/state lock. Owner identity is stable
 * across token refresh but must change across logout/login/account replacement.
 * Codec API supplied by parent; this module deliberately contains no proto clone.
 */
import http2 from 'node:http2';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const RAMEN_ORIGIN = 'https://cn-geo1.uber.com';
export const RAMEN_PATH = '/uber.streaming.ramen.RamenService/RamenStreaming';
const MAX_FRAME = 8 * 1024 * 1024;
const safeError = (code, retryable = false, status) =>
  Object.assign(new Error(code), {
    code,
    retryable,
    ...(status == null ? {} : { status }),
  });
const abortError = () => safeError('STOPPED');
const checkAbort = (signal) => {
  if (signal.aborted) throw abortError();
};
// Cancellation must not wait for a caller callback that ignores its signal.
async function abortable(operation, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve(value);
    };
    const onAbort = () => finish(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        checkAbort(signal);
        return operation();
      })
      .then(
        (value) => finish(null, value),
        (error) => finish(error),
      );
  });
}

export function encodeGrpcFrame(payload, { maxFrameBytes = MAX_FRAME } = {}) {
  if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array))
    throw safeError('INVALID_ENCODER_OUTPUT');
  if (payload.length > maxFrameBytes)
    throw safeError('OUTBOUND_FRAME_TOO_LARGE');
  const frame = Buffer.allocUnsafe(payload.length + 5);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}
/** Incremental framing with one bounded payload allocation, no repeated concat. */
export class GrpcFrameDecoder {
  constructor({ maxFrameBytes = MAX_FRAME, maxFramesPerChunk = 4096 } = {}) {
    this.maxFrameBytes = maxFrameBytes;
    this.maxFramesPerChunk = maxFramesPerChunk;
    this.header = Buffer.alloc(5);
    this.headerOffset = 0;
    this.payload = null;
    this.payloadOffset = 0;
  }
  push(chunk) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array))
      throw safeError('INVALID_NETWORK_CHUNK');
    const frames = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.payload === null) {
        const count = Math.min(5 - this.headerOffset, chunk.length - offset);
        this.header.set(
          chunk.subarray(offset, offset + count),
          this.headerOffset,
        );
        this.headerOffset += count;
        offset += count;
        if (this.headerOffset < 5) break;
        if (this.header[0] !== 0)
          throw safeError(
            this.header[0] === 1
              ? 'UNSUPPORTED_GRPC_COMPRESSION'
              : 'INVALID_GRPC_COMPRESSION_FLAG',
          );
        const length = this.header.readUInt32BE(1);
        if (length > this.maxFrameBytes)
          throw safeError('INBOUND_FRAME_TOO_LARGE');
        this.payload = Buffer.allocUnsafe(length);
        this.payloadOffset = 0;
      }
      const count = Math.min(
        this.payload.length - this.payloadOffset,
        chunk.length - offset,
      );
      this.payload.set(
        chunk.subarray(offset, offset + count),
        this.payloadOffset,
      );
      this.payloadOffset += count;
      offset += count;
      if (this.payloadOffset === this.payload.length) {
        frames.push(this.payload);
        this.payload = null;
        this.payloadOffset = 0;
        this.headerOffset = 0;
        if (frames.length > this.maxFramesPerChunk)
          throw safeError('FRAME_BATCH_LIMIT');
      }
    }
    return frames;
  }
  finish() {
    if (this.headerOffset !== 0 || this.payload !== null)
      throw safeError('TRUNCATED_GRPC_FRAME');
  }
}

function prepareHeaders(headers, connectionId) {
  if (!headers || typeof headers !== 'object')
    throw safeError('INVALID_AUTH_CONTEXT');
  const clean = {},
    omit = new Set([
      'accept',
      'content-type',
      'te',
      'host',
      'connection',
      'keep-alive',
      'proxy-connection',
      'transfer-encoding',
      'upgrade',
    ]);
  let size = 0;
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (name.startsWith(':') || omit.has(name)) continue;
    if (
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) ||
      typeof value !== 'string' ||
      /[\r\n\0]/.test(value) ||
      value.length > 16384
    )
      throw safeError('INVALID_AUTH_CONTEXT');
    size += name.length + value.length;
    if (size > 65536) throw safeError('AUTH_HEADERS_LIMIT');
    clean[name] = value;
  }
  if (!clean.authorization) throw safeError('MISSING_AUTHORIZATION');
  return {
    ...clean,
    ':method': 'POST',
    ':path': RAMEN_PATH,
    'content-type': 'application/grpc',
    te: 'trailers',
    'grpc-accept-encoding': 'identity',
    'x-uber-streamgate-connection-id': connectionId,
  };
}
const sequence = (value) => {
  try {
    const n = BigInt(value ?? 0);
    if (n < 0n || n > 0x7fffffffffffffffn) throw 0;
    return n;
  } catch {
    throw safeError('INVALID_SEQUENCE');
  }
};

/**
 * Returns {done, stop}. `done` resolves to a sanitized terminal summary.
 * No headers, tokens, message bodies or coordinates enter summaries/state hooks.
 *
 * Required callbacks:
 * getContext({attempt,reason,signal}) -> {headers,owner:string}
 * assertOwner(owner,{signal}) -> boolean (false permanently revokes this handle)
 * encodeRamenRequest({lastSeenSeqId:decimalString,messageAcks?,featureAcks?}) ->Buffer
 * decodeRamenResponse(Buffer)-> root codec {kind,messages?,reason?,heartbeat?}
 * onMessage(message,{owner,receivedAt,signal}) consumes only selected topic messages.
 *
 * Root codec ACK shape: messageAcks:[{messageId:uuid}] and
 * featureAcks:[{messageId:uuid,consumptionTimeInMs,consumerPlugins:[name]}].
 * Native default-background false is omitted. See codec ACK aliases at integration.
 */
export function createRamenTransport({
  getContext,
  assertOwner,
  encodeRamenRequest,
  decodeRamenResponse,
  onMessage,
  onState = () => {},
  signal: externalSignal,
  topics = ['trip_driver_location_update_v2'],
  consumerName = 'a0',
  durationMs = 30 * 60 * 1000,
  idleTimeoutMs = 30000,
  writeTimeoutMs = 5000,
  maxReconnects = 8,
  maxFrameBytes = MAX_FRAME,
  maxConnectionBytes = 64 * 1024 * 1024,
  maxMessagesPerEnvelope = 2048,
  reconnectBaseMs = 250,
  reconnectMaxMs = 8000,
  connectSession = (origin) => http2.connect(origin),
  lastSeenSeqId = '0',
} = {}) {
  for (const f of [
    getContext,
    assertOwner,
    encodeRamenRequest,
    decodeRamenResponse,
    onMessage,
  ])
    if (typeof f !== 'function')
      throw new TypeError('Ramen transport callback missing');
  for (const [name, value] of Object.entries({
    durationMs,
    idleTimeoutMs,
    writeTimeoutMs,
    maxFrameBytes,
    maxConnectionBytes,
    maxMessagesPerEnvelope,
    reconnectBaseMs,
    reconnectMaxMs,
  }))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError(`Invalid ${name}`);
  if (
    !Number.isInteger(maxReconnects) ||
    maxReconnects < 0 ||
    maxReconnects > 64
  )
    throw new TypeError('Invalid maxReconnects');
  if (
    durationMs > 24 * 60 * 60 * 1000 ||
    maxFrameBytes > 16 * 1024 * 1024 ||
    maxConnectionBytes > 512 * 1024 * 1024
  )
    throw new TypeError('Ramen transport resource bound exceeded');
  const topicSet = new Set(topics),
    controller = new AbortController(),
    signal = controller.signal;
  let owner = null,
    lastSeen = sequence(lastSeenSeqId),
    totalFrames = 0,
    totalMessages = 0,
    totalBytes = 0,
    attempts = 0,
    reason = 'initial';
  const publish = (state, extra = {}) => {
    try {
      onState({ state, ...extra });
    } catch {
      /* diagnostics hooks never affect account ownership or stream delivery */
    }
  };
  const onExternalAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const durationTimer = setTimeout(() => controller.abort(), durationMs);
  durationTimer.unref?.();
  async function validateOwner() {
    checkAbort(signal);
    let current;
    try {
      current = await abortable(() => assertOwner(owner, { signal }), signal);
    } catch {
      throw safeError('OWNER_CHECK_FAILED');
    }
    checkAbort(signal);
    if (current !== true) throw safeError('OWNER_REVOKED');
  }

  async function connection(context) {
    const connectionId = randomUUID(),
      headers = prepareHeaders(context.headers, connectionId),
      decoder = new GrpcFrameDecoder({ maxFrameBytes }),
      deliveryController = new AbortController();
    const deliverySignal = AbortSignal.any([signal, deliveryController.signal]);
    await validateOwner();
    return new Promise((resolve, reject) => {
      let session,
        stream,
        idleTimer,
        settled = false,
        responseAccepted = false,
        connectionBytes = 0,
        processing = Promise.resolve();
      const writeWaiters = new Set();
      function finish(error) {
        if (settled) return;
        settled = true;
        deliveryController.abort();
        clearTimeout(idleTimer);
        signal.removeEventListener('abort', onAbort);
        for (const cancel of [...writeWaiters]) cancel();
        try {
          stream?.close(http2.constants.NGHTTP2_CANCEL);
        } catch {}
        try {
          session?.destroy();
        } catch {}
        if (error) reject(error);
        else resolve();
      }
      const onAbort = () => finish(abortError());
      const touch = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => finish(safeError('HEARTBEAT_TIMEOUT', true)),
          idleTimeoutMs,
        );
        idleTimer.unref?.();
      };
      async function write(payload) {
        checkAbort(signal);
        if (settled || !stream || stream.destroyed)
          throw safeError('STREAM_CLOSED', true);
        const frame = encodeGrpcFrame(payload, { maxFrameBytes });
        if (stream.write(frame)) return;
        await new Promise((done, fail) => {
          let ended = false,
            timer;
          const cleanup = () => {
            clearTimeout(timer);
            stream.off('drain', onDrain);
            writeWaiters.delete(onClose);
          };
          const settle = (error) => {
            if (ended) return;
            ended = true;
            cleanup();
            error ? fail(error) : done();
          };
          const onDrain = () => settle(),
            onClose = () => settle(safeError('STREAM_CLOSED', true));
          writeWaiters.add(onClose);
          stream.once('drain', onDrain);
          timer = setTimeout(
            () => settle(safeError('WRITE_TIMEOUT', true)),
            writeTimeoutMs,
          );
        });
      }
      async function sendRequest(value) {
        let payload;
        try {
          payload = encodeRamenRequest(value);
        } catch {
          throw safeError('REQUEST_ENCODING_FAILED');
        }
        await write(payload);
      }
      async function handleFrame(payload) {
        await validateOwner();
        if (settled) return;
        totalFrames++;
        let envelope;
        try {
          envelope = decodeRamenResponse(payload);
        } catch {
          throw safeError('INVALID_RAMEN_ENVELOPE');
        }
        if (envelope?.kind === 'heartbeat') return;
        if (envelope?.kind === 'control') {
          if (envelope.reason === 1 || envelope.reason === 'DISCONNECT')
            throw safeError('SERVER_DISCONNECT', true);
          if (envelope.reason === 2 || envelope.reason === 'REFRESH')
            throw safeError('SERVER_REFRESH', true);
          return;
        }
        if (envelope?.kind !== 'messages') return;
        if (
          !Array.isArray(envelope.messages) ||
          envelope.messages.length > maxMessagesPerEnvelope
        )
          throw safeError('MESSAGE_BATCH_LIMIT');
        for (const message of envelope.messages) {
          await validateOwner();
          if (settled) return;
          if (
            typeof message.uuid !== 'string' ||
            !message.uuid ||
            message.uuid.length > 512
          )
            throw safeError('INVALID_MESSAGE_UUID');
          const seq = sequence(message.seq);
          if (seq > lastSeen) lastSeen = seq;
          // Native transport receipt ACK precedes feature consumption, including unknown topics.
          await sendRequest({
            lastSeenSeqId: lastSeen.toString(),
            messageAcks: [{ messageId: message.uuid }],
          });
          totalMessages++;
          if (!topicSet.has(message.type)) continue;
          await validateOwner();
          if (settled) return;
          try {
            await abortable(
              () =>
                onMessage(message, {
                  owner,
                  receivedAt: Date.now(),
                  signal: deliverySignal,
                }),
              deliverySignal,
            );
          } catch {
            throw safeError('MESSAGE_HANDLER_FAILED');
          }
          if (message.requestFeatureAck) {
            await validateOwner();
            if (settled) return;
            await sendRequest({
              lastSeenSeqId: lastSeen.toString(),
              featureAcks: [
                {
                  messageId: message.uuid,
                  consumptionTimeInMs: Date.now(),
                  consumerPlugins: [consumerName],
                },
              ],
            });
          }
        }
      }
      try {
        session = connectSession(RAMEN_ORIGIN);
        session.on('error', () =>
          finish(safeError('HTTP2_SESSION_ERROR', true)),
        );
        session.on('goaway', () => finish(safeError('HTTP2_GOAWAY', true)));
        session.on('close', () =>
          finish(safeError('HTTP2_SESSION_CLOSED', true)),
        );
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) return onAbort();
        stream = session.request(headers, { endStream: false });
        touch();
        // Native sends initial request immediately; waiting for server headers can deadlock.
        processing = processing
          .then(() => sendRequest({ lastSeenSeqId: lastSeen.toString() }))
          .catch(finish);
        stream.on('error', () => finish(safeError('HTTP2_STREAM_ERROR', true)));
        stream.on('response', (response) => {
          const status = Number(response[':status']),
            content = String(response['content-type'] ?? '');
          if (status !== 200)
            return finish(safeError('HTTP_STATUS', status >= 500, status));
          if (!/^application\/grpc(?:[+;]|$)/i.test(content))
            return finish(safeError('INVALID_GRPC_CONTENT_TYPE'));
          const encoding = String(
            response['grpc-encoding'] ?? 'identity',
          ).toLowerCase();
          if (encoding !== 'identity')
            return finish(safeError('UNSUPPORTED_GRPC_COMPRESSION'));
          const grpcStatus = String(response['grpc-status'] ?? '0');
          if (grpcStatus !== '0')
            return finish(
              safeError(
                grpcStatus === '16' ? 'GRPC_UNAUTHENTICATED' : 'GRPC_STATUS',
                ['16', '14', '13', '4'].includes(grpcStatus),
                grpcStatus,
              ),
            );
          responseAccepted = true;
          touch();
          publish('connected', { attempt: attempts });
        });
        stream.on('data', (chunk) => {
          if (settled) return;
          stream.pause();
          touch();
          connectionBytes += chunk.length;
          totalBytes += chunk.length;
          if (connectionBytes > maxConnectionBytes)
            return finish(safeError('CONNECTION_BYTE_LIMIT', true));
          processing = processing
            .then(async () => {
              if (settled) return;
              if (!responseAccepted) throw safeError('DATA_BEFORE_RESPONSE');
              for (const payload of decoder.push(chunk)) {
                if (settled) return;
                await handleFrame(payload);
              }
            })
            .then(() => {
              if (!settled) stream.resume();
            })
            .catch(finish);
        });
        stream.on('trailers', (trailers) => {
          const status = String(trailers['grpc-status'] ?? '0');
          if (status !== '0')
            finish(
              safeError(
                status === '16' ? 'GRPC_UNAUTHENTICATED' : 'GRPC_STATUS',
                status === '16' ||
                  status === '14' ||
                  status === '13' ||
                  status === '4',
                status,
              ),
            );
        });
        stream.on('end', () => {
          processing = processing
            .then(() => {
              if (settled) return;
              decoder.finish();
              finish(safeError('STREAM_ENDED', true));
            })
            .catch(finish);
        });
        stream.on('aborted', () => finish(safeError('STREAM_ABORTED', true)));
        stream.on('close', () => {
          if (!settled)
            processing = processing
              .then(() => finish(safeError('STREAM_CLOSED', true)))
              .catch(finish);
        });
      } catch {
        finish(safeError('CONNECTION_SETUP_FAILED', true));
      }
    });
  }
  const done = (async () => {
    let terminal = { state: 'stopped', code: 'STOPPED' };
    try {
      for (let index = 0; index <= maxReconnects && !signal.aborted; index++) {
        attempts++;
        publish('connecting', { attempt: attempts });
        let context;
        try {
          context = await abortable(
            () => getContext({ attempt: attempts, reason, signal }),
            signal,
          );
        } catch {
          throw safeError('AUTH_CONTEXT_FAILED');
        }
        checkAbort(signal);
        if (typeof context?.owner !== 'string' || !context.owner)
          throw safeError('INVALID_OWNER');
        if (owner === null) owner = context.owner;
        else if (owner !== context.owner) throw safeError('OWNER_REVOKED');
        await validateOwner();
        try {
          await connection(context);
        } catch (error) {
          if (signal.aborted) break;
          const code = error.code ?? 'TRANSPORT_FAILED';
          reason = code;
          if (!error.retryable || index === maxReconnects)
            throw safeError(code);
          await validateOwner();
          const retryInMs = Math.min(
            reconnectMaxMs,
            reconnectBaseMs * 2 ** Math.min(index, 20),
          );
          publish('reconnecting', { attempt: attempts, retryInMs, code });
          try {
            await sleep(retryInMs, undefined, { signal });
          } catch {
            break;
          }
        }
      }
    } catch (error) {
      if (!signal.aborted)
        terminal = {
          state: error.code === 'OWNER_REVOKED' ? 'revoked' : 'failed',
          code: error.code ?? 'TRANSPORT_FAILED',
        };
    } finally {
      clearTimeout(durationTimer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
    const summary = {
      ...terminal,
      attempts,
      receivedFrames: totalFrames,
      receivedMessages: totalMessages,
      receivedBytes: totalBytes,
      lastSeenSeqId: lastSeen.toString(),
    };
    publish(summary.state, { code: summary.code });
    return summary;
  })();
  return { done, stop: () => controller.abort() };
}
