import { buildPasswordLogin } from './auth-protocol.mjs';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Timeline metadata describes the actual CLI clock and configured runtime zone.
// NotCapable is the shipped enum value for a client without fingerprint login.
export function buildLoginTimelineRequest({
  now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
} = {}) {
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) {
    throw new TypeError('Invalid login timestamp');
  }
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 128) {
    throw new TypeError('Invalid login time zone');
  }
  const date = new Date(now);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZoneName: 'short',
  }).formatToParts(date).map(part => [part.type, part.value]));
  const offset = new Intl.DateTimeFormat('en-US', {
    timeZone, timeZoneName: 'longOffset',
  }).formatToParts(date).find(part => part.type === 'timeZoneName')?.value;
  const match = /^(?:GMT|UTC)(?:([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?$/u.exec(offset ?? '');
  if (!match) throw new TypeError('Unsupported login time zone offset');
  const offsetMs = match[1] == null ? 0 : (match[1] === '-' ? -1 : 1)
    * ((Number(match[2]) * 60 + Number(match[3])) * 60 + Number(match[4] ?? 0)) * 1000;
  return {
    sortedIndex: 0,
    localTime: `${parts.month}-${parts.day}-${parts.year}T${parts.hour}:${parts.minute}:${parts.second} ${parts.dayPeriod} ${parts.timeZoneName}`,
    timeZone, timestampInMilli: String(now), timeZoneOffsetInMilli: String(offsetMs),
    pendingChargeEnabled: false, cmlEnabled: false, payWithPointsEnabled: false,
    pushEnabled: false, goodsSvcOfferEnabled: false, payYourWayEnabled: false,
    biometrics: { fingerprintStatus: 'NotCapable' },
  };
}

export function buildStreamingPasswordLogin({ userId, password, rememberMe = false, now, timeZone } = {}) {
  const passwordRequest = buildPasswordLogin({ userId, password, rememberMe });
  return {
    ...passwordRequest,
    path: '/services/accountservicing/streaming/v1/loginsummarytimeline',
    body: { login: passwordRequest.body, timeline: buildLoginTimelineRequest({ now, timeZone }) },
    headers: { accept: 'text/event-stream' }, responseType: 'login-sse',
  };
}

// LoginTimelineStreamingResponseAdapter chooses the DTO by the SSE event field.
// The data is a direct native response; it has no additional data/login wrapper.
export function parseLoginSseFrame({ event = null, data } = {}) {
  const discriminator = event || null;
  if (typeof data !== 'string') return { type: 'error', reason: 'invalid_stream_data', discriminator };
  if (event != null && event !== '' && !['LOGIN', 'TIMELINE'].includes(event)) {
    return { type: 'error', reason: 'unknown_stream_event', discriminator };
  }
  let response;
  try { response = JSON.parse(data); }
  catch { return { type: 'error', reason: 'invalid_stream_json', discriminator }; }
  if (!isObject(response)) return { type: 'error', reason: 'invalid_stream_response', discriminator };
  if (event === 'LOGIN') return { type: 'login', response };
  if (event === 'TIMELINE') return { type: 'timeline', response };
  // A missing event name is parsed by the native adapter as a direct Status
  // error, even if it happens to contain a true success boolean.
  return {
    type: 'error', reason: 'untagged_stream_status', discriminator,
    ...(typeof response.success === 'boolean' ? { status: response } : {}),
  };
}

// POST login streams must never reconnect automatically. This decoder stops at
// the same first login/error result that the native client awaits. Callers must
// cancel their response reader after a terminal result and validate the account
// independently before replacing a saved session. Results can contain secrets.
export function createLoginSseDecoder({ maxBytes = 10 * 1024 * 1024, maxFrames = 256 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0
    || !Number.isSafeInteger(maxFrames) || maxFrames <= 0) throw new TypeError('Invalid login stream limits');
  let buffer = '';
  let bytesRead = 0;
  let frameCount = 0;
  let atStart = true;
  let terminal = null;
  let deferredError = null;
  let closed = false;
  let event = null;
  let data = [];

  function consumeLine(line) {
    if (!line) {
      if (data.length) {
        frameCount += 1;
        if (frameCount > maxFrames) {
          terminal = { type: 'error', reason: 'stream_frame_limit' };
        } else {
          const parsed = parseLoginSseFrame({ event, data: data.join('\n') });
          if (parsed.type === 'login') terminal = parsed;
          else if (parsed.type === 'error') {
            if (parsed.discriminator === 'LOGIN' || parsed.reason === 'unknown_stream_event') terminal = parsed;
            else if (parsed.discriminator == null) deferredError = parsed;
            // Native getLoginFlow filters out Error(TIMELINE), so this must
            // not mask a later login response or trigger a second login POST.
          }
        }
      }
      event = null;
      data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    // id/retry are intentionally ignored: this login POST is never replayed.
  }

  function consumeAvailable(final = false) {
    while (!terminal) {
      const index = buffer.search(/[\r\n]/u);
      if (index < 0) break;
      if (buffer[index] === '\r' && index === buffer.length - 1 && !final) break;
      const line = buffer.slice(0, index);
      const width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(index + width);
      consumeLine(line);
    }
    if (terminal) { buffer = ''; data = []; }
    return terminal;
  }

  return {
    push(text) {
      if (terminal) return terminal;
      if (closed) throw new TypeError('The login stream is closed');
      if (typeof text !== 'string') throw new TypeError('Login stream chunks must be decoded text');
      bytesRead += Buffer.byteLength(text, 'utf8');
      if (bytesRead > maxBytes) {
        terminal = { type: 'error', reason: 'stream_byte_limit' };
        buffer = ''; data = [];
        return terminal;
      }
      if (atStart && text.length) {
        atStart = false;
        if (text.startsWith('\uFEFF')) text = text.slice(1);
      }
      buffer += text;
      return consumeAvailable();
    },
    finish() {
      if (terminal) return terminal;
      closed = true;
      consumeAvailable(true);
      // EOF is not an SSE record terminator. An unterminated final data frame
      // is discarded rather than turned into proof that login succeeded.
      terminal ??= deferredError ?? { type: 'error', reason: 'stream_closed_without_login' };
      buffer = ''; data = [];
      return terminal;
    },
  };
}

export function parseLoginSseResponse(text, options) {
  const decoder = createLoginSseDecoder(options);
  return decoder.push(text) ?? decoder.finish();
}
