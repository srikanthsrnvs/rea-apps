export class ChartsError extends Error {
  constructor(code, message) { super(message); this.name = 'ChartsError'; this.code = code; }
}

const messages = {
  INVALID_ARGUMENT: 'Invalid provider arguments. Check the tool schema and indicator inputs.',
  SYMBOL_ERROR: 'TradingView could not resolve this symbol. Use symbols search and an exchange-qualified symbol.',
  SERIES_ERROR: 'This series, chart type or timeframe is unavailable to the current session.',
  STUDY_ERROR: 'The study was refused or could not run. Pine studies require an account with access.',
  QUOTE_ERROR: 'A requested quote is unavailable.',
  AUTH_ERROR: 'The TradingView session was rejected or expired. Sign in and run charts login again.',
  NOT_FOUND: 'The requested TradingView resource was not found.',
  NO_DATA: 'TradingView returned no data for this request.',
  TIMEOUT: 'The request deadline expired. Try a smaller request or a longer timeout.',
  ABORTED: 'The request was cancelled.',
  DISCONNECTED: 'The TradingView connection closed before the operation completed.',
  CONNECTION_ERROR: 'Could not connect to TradingView.',
  PROTOCOL_ERROR: 'TradingView returned an unexpected protocol response.',
  PARSE_ERROR: 'TradingView returned data that could not be decoded.',
  HTTP_ERROR: 'TradingView rejected the HTTP request. Check fields, permissions and service availability.',
  CRITICAL_ERROR: 'TradingView refused this chart configuration.',
};

// Provider errors can contain response bodies, cookies or compiled scripts. Do not
// forward upstream messages/details or exception stacks to the CLI or MCP client.
export function publicError(error, signal) {
  if (signal?.aborted) {
    const timeout = signal.reason?.name === 'TimeoutError';
    return { code: timeout ? 'TIMEOUT' : 'ABORTED', message: messages[timeout ? 'TIMEOUT' : 'ABORTED'], retryable: timeout };
  }
  if (error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError') return { code: 'TIMEOUT', message: messages.TIMEOUT, retryable: true };
  if (error instanceof ChartsError) return { code: error.code, message: error.message, retryable: ['PROVIDER_BUSY', 'RATE_LIMITED'].includes(error.code) };
  const code = Object.hasOwn(messages, error?.code) ? error.code : 'INTERNAL_ERROR';
  return { code, message: messages[code] ?? 'The operation could not complete.',
    retryable: ['TIMEOUT', 'DISCONNECTED', 'CONNECTION_ERROR'].includes(code) };
}

const secretKeys = /^(sessionid(?:_sign)?|signature|auth_?token|(?:access|refresh|id)_?token|token|sessionhash|privatechannel|(?:set-)?cookies?|credentials|password|key_?source|previousBinding|callback_?url|authorization|script)$/iu;
export function safeData(value, depth = 0) {
  if (depth > 24) throw new ChartsError('OUTPUT_LIMIT', 'The result is too deeply nested. Reduce the request size.');
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (['string', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(item => safeData(item, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !secretKeys.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key))
    .map(([key, item]) => [key, safeData(item, depth + 1)]));
  return null;
}

export function boundedResult(value) {
  const result = safeData(value);
  if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) {
    throw new ChartsError('OUTPUT_LIMIT', 'The result exceeds 2 MiB. Reduce bars, fields, trades or page size.');
  }
  return result;
}
