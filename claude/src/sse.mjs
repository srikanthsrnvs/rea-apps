import { ClaudeError } from './errors.mjs';

/** Decode SSE without buffering a complete response or reconnecting a write. */
export async function* parseSSE(source, { maxFrameBytes = 2 * 1024 * 1024, maxLineBytes = 1024 * 1024 } = {}) {
  for (const [name, value] of Object.entries({ maxFrameBytes, maxLineBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new ClaudeError('INVALID_ARGUMENT', `${name} must be a positive integer.`);
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '', lineBytes = 0, event = '', data = [], frameBytes = 0, lastId = '', retry, skipLF = false;
  function processLine() {
    const current = line;
    line = '';
    frameBytes += lineBytes + 1;
    lineBytes = 0;
    if (frameBytes > maxFrameBytes) throw new ClaudeError('SSE_TOO_LARGE', 'A server event exceeds the configured size limit.');
    if (current === '') {
      const frame = data.length ? { event: event || 'message', data: data.join('\n'), id: lastId, ...(retry == null ? {} : { retry }) } : null;
      event = ''; data = []; frameBytes = 0; retry = undefined;
      return frame;
    }
    if (current.startsWith(':')) return null;
    const colon = current.indexOf(':');
    const field = colon === -1 ? current : current.slice(0, colon);
    let value = colon === -1 ? '' : current.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\u0000')) lastId = value;
    else if (field === 'retry' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) retry = Number(value);
    return null;
  }
  function* textFrames(text) {
    for (const char of text) {
      if (skipLF) { skipLF = false; if (char === '\n') continue; }
      if (char === '\r' || char === '\n') {
        const frame = processLine();
        if (char === '\r') skipLF = true;
        if (frame) yield frame;
      } else {
        line += char;
        lineBytes += Buffer.byteLength(char, 'utf8');
        if (lineBytes > maxLineBytes) {
          throw new ClaudeError('SSE_TOO_LARGE', 'A server event line exceeds the configured size limit.');
        }
      }
    }
  }
  try {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) throw new ClaudeError('INVALID_STREAM', 'SSE input must contain byte chunks.');
      yield* textFrames(decoder.decode(chunk, { stream: true }));
    }
    yield* textFrames(decoder.decode());
    // An unterminated event is deliberately discarded. A completion needs message_stop.
  } catch (error) {
    if (error instanceof TypeError && /encoded data|encoding/i.test(error.message)) {
      throw new ClaudeError('INVALID_STREAM', 'The server stream contains invalid UTF-8.');
    }
    throw error;
  }
}

function object(value) { return value != null && typeof value === 'object' && !Array.isArray(value); }

export function parseCompletionEvent(frame) {
  if (frame.event === 'ping') return { type: 'ping' };
  let value;
  try { value = JSON.parse(frame.data); }
  catch { throw new ClaudeError('INVALID_STREAM', 'A completion event contains invalid JSON.'); }
  if (!object(value)) throw new ClaudeError('INVALID_STREAM', 'A completion event is not an object.');
  if (frame.event === 'error') return { ...value, type: 'error' };
  if (typeof value.type !== 'string' || !value.type) {
    throw new ClaudeError('INVALID_STREAM', 'A completion event has no type.');
  }
  return value;
}

/** Keeps all content blocks; plain text is derived only from text blocks. */
export function createCompletionAccumulator({ maxContentBytes = 16 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 1) throw new ClaudeError('INVALID_ARGUMENT', 'maxContentBytes must be a positive integer.');
  let current = null, stopped = false, contentBytes = 0;
  const messages = [], limits = [], unknownTypes = new Set();
  function ensureMessage() {
    if (!current) throw new ClaudeError('INVALID_STREAM', 'Content arrived before message_start.');
  }
  function contentAt(index) {
    ensureMessage();
    if (!Number.isSafeInteger(index) || index < 0 || !current.content[index]) {
      throw new ClaudeError('INVALID_STREAM', 'A content event refers to an unknown block.');
    }
    return current.content[index];
  }
  function account(value) {
    contentBytes += Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
    if (contentBytes > maxContentBytes) throw new ClaudeError('SSE_TOO_LARGE', 'The completion exceeds the configured content limit.');
  }
  function snapshot() {
    return structuredClone({
      completed: stopped, requiresReconciliation: unknownTypes.size > 0, messages,
      text: messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text ?? '')).join(''),
      messageLimits: limits, unknownEventTypes: [...unknownTypes],
    });
  }
  function push(event) {
    if (stopped && !['ping', 'message_limit'].includes(event.type)) {
      throw new ClaudeError('INVALID_STREAM', 'A completion event arrived after message_stop.');
    }
    if (event.type === 'ping' || event.type === 'conversation_ready') return;
    if (event.type === 'error') {
      const envelope = object(event.error) ? event.error : event;
      throw new ClaudeError('COMPLETION_ERROR', typeof envelope.message === 'string' ? envelope.message : 'Claude returned a completion error.', { error: envelope, partial: snapshot() });
    }
    if (event.type === 'message_start') {
      if (!object(event.message) || typeof event.message.uuid !== 'string') throw new ClaudeError('INVALID_STREAM', 'A message_start has no message UUID.');
      current = { ...event.message, content: Array.isArray(event.message.content) ? structuredClone(event.message.content) : [] };
      if (event.discarded_parent_message_uuid != null) current.discardedParentMessageId = event.discarded_parent_message_uuid;
      account(current); messages.push(current); return;
    }
    if (event.type === 'message_limit') {
      if (!object(event.message_limit)) throw new ClaudeError('INVALID_STREAM', 'A message_limit event has no limit information.');
      account(event.message_limit); limits.push(event.message_limit); return;
    }
    if (event.type === 'message_stop') { ensureMessage(); stopped = true; return; }
    if (event.type === 'message_delta') {
      ensureMessage();
      if (!object(event.delta)) throw new ClaudeError('INVALID_STREAM', 'A message_delta has no delta.');
      if ('content' in event.delta || 'uuid' in event.delta || 'parent_uuid' in event.delta) throw new ClaudeError('INVALID_STREAM', 'A message delta attempts to replace message identity or content.');
      account(event.delta); Object.assign(current, event.delta);
      if (object(event.usage)) current.usage = { ...current.usage, ...event.usage };
      return;
    }
    if (event.type === 'content_block_start') {
      ensureMessage();
      if (!Number.isSafeInteger(event.index) || event.index !== current.content.length || !object(event.content_block)) {
        throw new ClaudeError('INVALID_STREAM', 'The server content block sequence is incomplete or out of order.');
      }
      account(event.content_block); current.content.push(structuredClone(event.content_block)); return;
    }
    if (event.type === 'content_block_delta') {
      const block = contentAt(event.index), delta = event.delta;
      if (!object(delta)) throw new ClaudeError('INVALID_STREAM', 'A content delta is missing.');
      account(delta);
      if (delta.type === 'text_delta' && block.type === 'text' && typeof delta.text === 'string') block.text = (block.text ?? '') + delta.text;
      else if (delta.type === 'thinking_delta' && block.type === 'thinking' && typeof delta.thinking === 'string') block.thinking = (block.thinking ?? '') + delta.thinking;
      else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') block.partial_json = (block.partial_json ?? '') + delta.partial_json;
      else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') block.signature = (block.signature ?? '') + delta.signature;
      else {
        (block.deltas ??= []).push(structuredClone(delta));
        unknownTypes.add(`content_block_delta:${delta.type ?? 'unknown'}`);
      }
      return;
    }
    if (event.type === 'content_block_stop') {
      const block = contentAt(event.index);
      if (block.partial_json) {
        try { block.input = JSON.parse(block.partial_json); }
        catch { unknownTypes.add('invalid_tool_json'); }
      }
      if (event.stop_timestamp != null) block.stop_timestamp = event.stop_timestamp;
      return;
    }
    if (event.type === 'content_block_retract') {
      ensureMessage();
      if (event.from_index == null) return;
      if (!Number.isSafeInteger(event.from_index) || event.from_index < 0 || event.from_index > current.content.length) {
        throw new ClaudeError('INVALID_STREAM', 'The server retracts an unknown content block.');
      }
      current.content.splice(event.from_index);
      return;
    }
    // Unknown/advanced events are retained by streaming callbacks. Never pretend that
    // a partial reconstruction is authoritative: callers reconcile a completed chat.
    unknownTypes.add(event.type);
  }
  function finish() {
    if (!stopped) throw new ClaudeError('STREAM_INCOMPLETE', 'The stream ended without message_stop. Check the conversation before sending again.', { partial: snapshot() });
    return snapshot();
  }
  return { push, snapshot, finish };
}

export async function consumeCompletionStream(source, { onEvent, snapshotOnEvent = true, ...options } = {}) {
  const state = createCompletionAccumulator(options);
  for await (const frame of parseSSE(source, options)) {
    const event = parseCompletionEvent(frame);
    state.push(event);
    if (onEvent) await onEvent(event, snapshotOnEvent ? state.snapshot() : undefined);
  }
  return state.finish();
}
