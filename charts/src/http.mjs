import { ChartsError } from './errors.mjs';

export async function boundedFetch(url, init = {}, { fetchImpl = fetch, maxBytes = 4 * 1024 * 1024 } = {}) {
  const response = await fetchImpl(url, init);
  if (response.status === 429) {
    await response.body?.cancel();
    throw new ChartsError('RATE_LIMITED', 'TradingView requested a pause. The request was not retried.');
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new ChartsError('RESPONSE_LIMIT', 'The provider response exceeds the memory budget. Reduce the request size.');
  }
  if (!response.body) return response;
  let bytes = 0;
  const body = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new ChartsError('RESPONSE_LIMIT', 'The provider response exceeds the memory budget. Reduce the request size.');
    controller.enqueue(chunk);
  } }));
  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  Object.defineProperty(wrapped, 'url', { value: response.url });
  return wrapped;
}
