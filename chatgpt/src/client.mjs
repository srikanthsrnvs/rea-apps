import { API_BASE, accountHeaders, authorizedSession } from './auth.mjs';
import { requestJson, send } from './http.mjs';
import { ChatGptError } from './errors.mjs';

export class ChatGptClient {
  constructor(session, { fetcher = globalThis.fetch } = {}) { this.session = session; this.fetcher = fetcher; }

  async request(operation, { stream = false, timeoutMs = 30_000 } = {}) {
    if (typeof operation.path !== 'string' || operation.path.startsWith('/') || operation.path.includes('..')
      || operation.path.includes(':') || operation.path.includes('\\')) {
      throw new ChatGptError('INVALID_ENDPOINT', 'Use a relative ChatGPT API path.');
    }
    const url = new URL(operation.path, API_BASE);
    if (url.origin !== new URL(API_BASE).origin || !url.pathname.startsWith('/backend-api/')) {
      throw new ChatGptError('INVALID_ENDPOINT', 'The request must remain on the ChatGPT API origin.');
    }
    for (const [key, value] of Object.entries(operation.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const method = operation.method ?? 'GET';
    const headers = { ...accountHeaders(this.session, url.href, method), ...operation.headers };
    if (!stream) return requestJson(url.href, { method, headers, json: operation.body, fetcher: this.fetcher, timeoutMs });
    headers.accept = 'text/event-stream';
    headers['content-type'] = 'application/json';
    return send(url.href, { method, headers, body: JSON.stringify(operation.body), fetcher: this.fetcher, timeoutMs });
  }
}

export async function createClient(options = {}) {
  return new ChatGptClient(await authorizedSession(options), options);
}
