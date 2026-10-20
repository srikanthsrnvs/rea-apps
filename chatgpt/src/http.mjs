import { ChatGptError } from './errors.mjs';

const MAX_JSON_BYTES = 32 * 1024 * 1024;

export async function readText(response, { maxBytes = MAX_JSON_BYTES } = {}) {
  const chunks = [];
  let length = 0;
  try {
    if (response.body) for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > maxBytes) throw new ChatGptError('RESPONSE_TOO_LARGE', 'The server response exceeded the configured size limit.');
      chunks.push(chunk);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    if (error instanceof ChatGptError) throw error;
    throw new ChatGptError('INVALID_RESPONSE', 'The server response could not be read.');
  }
}

export async function send(url, {
  method = 'GET', headers = {}, body, fetcher = globalThis.fetch, timeoutMs = 30_000, signal,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new ChatGptError('INVALID_ARGUMENT', 'Request timeout must be a positive integer.');
  let response;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    response = await fetcher(url, { method, headers, body, redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (error) {
    const cancelled = signal?.aborted;
    throw new ChatGptError(cancelled ? 'CANCELLED' : 'NETWORK_ERROR',
      cancelled ? 'The request was cancelled.' : 'The request did not complete. Its outcome may be unknown.',
      { method, outcome: method === 'GET' ? 'read_failed' : 'unknown' });
  }
  if (!response.ok) {
    let value;
    const text = await readText(response, { maxBytes: 128 * 1024 });
    try { value = JSON.parse(text); } catch { /* HTML challenges are handled below. */ }
    const challenge = response.headers.get('cf-mitigated') === 'challenge';
    const serverCode = value?.error?.code ?? (typeof value?.error === 'string' ? value.error : undefined);
    const details = { status: response.status, ...(typeof serverCode === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(serverCode) ? { serverCode } : {}),
      ...(response.headers.get('dpop-nonce') ? { proofNonce: response.headers.get('dpop-nonce') } : {}) };
    throw new ChatGptError(challenge ? 'VERIFICATION_REQUIRED' : response.status === 401 ? 'AUTH_REQUIRED' : 'HTTP_ERROR',
      challenge ? 'OpenAI requires verification before this request can proceed.' : `OpenAI returned HTTP ${response.status}.`, details);
  }
  return response;
}

export async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  if (options.json !== undefined) headers.set('content-type', 'application/json');
  const response = await send(url, { ...options, headers,
    body: options.json === undefined ? options.body : JSON.stringify(options.json) });
  const text = await readText(response, options);
  if (!text && response.status === 204) return null;
  try { return JSON.parse(text); }
  catch { throw new ChatGptError('INVALID_RESPONSE', 'OpenAI returned a non-JSON response.', { status: response.status }); }
}
