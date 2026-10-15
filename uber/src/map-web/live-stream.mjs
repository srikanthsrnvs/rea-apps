// Authenticated fetch streaming keeps the viewer credential out of URL queries.
export async function watchScenes({
  url,
  key,
  signal,
  onScene,
  onUnavailable,
  onRefreshError,
}) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${key}` },
    signal,
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  if ([401, 403, 410].includes(response.status)) {
    onUnavailable(response.status);
    return;
  }
  if (
    !response.ok ||
    !response.headers.get('content-type')?.startsWith('text/event-stream') ||
    !response.body
  )
    throw new Error('Live map delivery is unavailable');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 8 * 1024 * 1024)
        throw new Error('Live map event exceeds limit');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const packet = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = packet.split('\n'),
          event = lines
            .find((line) => line.startsWith('event:'))
            ?.slice(6)
            .trim();
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (event === 'revoked' || event === 'expired') {
          onUnavailable(410);
          return;
        }
        if (event === 'refresh-error') {
          onRefreshError?.();
          continue;
        }
        if (event === 'scene') onScene(JSON.parse(data).scene);
      }
    }
    if (!signal.aborted) throw new Error('Live map delivery disconnected');
  } finally {
    await reader.cancel().catch(() => {});
  }
}
