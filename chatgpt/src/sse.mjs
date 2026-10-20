import { ChatGptError } from './errors.mjs';

/** Decode SSE without buffering a complete response or reconnecting a write. */
export async function* parseSSE(source, { maxFrameBytes = 2 * 1024 * 1024, maxLineBytes = 1024 * 1024 } = {}) {
  for (const [name, value] of Object.entries({ maxFrameBytes, maxLineBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new ChatGptError('INVALID_ARGUMENT', `${name} must be a positive integer.`);
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '', lineBytes = 0, event = '', data = [], frameBytes = 0, lastId = '', retry, skipLF = false;
  function processLine() {
    const current = line;
    line = '';
    frameBytes += lineBytes + 1;
    lineBytes = 0;
    if (frameBytes > maxFrameBytes) throw new ChatGptError('SSE_TOO_LARGE', 'A server event exceeds the configured size limit.');
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
          throw new ChatGptError('SSE_TOO_LARGE', 'A server event line exceeds the configured size limit.');
        }
      }
    }
  }
  try {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) throw new ChatGptError('INVALID_STREAM', 'SSE input must contain byte chunks.');
      yield* textFrames(decoder.decode(chunk, { stream: true }));
    }
    yield* textFrames(decoder.decode());
    // An unterminated event is deliberately discarded. Completion is determined separately by the app protocol.
  } catch (error) {
    if (error instanceof TypeError && /encoded data|encoding/i.test(error.message)) {
      throw new ChatGptError('INVALID_STREAM', 'The server stream contains invalid UTF-8.');
    }
    throw error;
  }
}
