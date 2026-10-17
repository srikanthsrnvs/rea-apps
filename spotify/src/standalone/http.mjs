const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, details }); };
export function spotifyUrl(input, query) {
  let url;
  try { url = new URL(input); } catch { fail("INVALID_ENDPOINT", "Invalid Spotify endpoint."); }
  const allowed = ["accounts.spotify.com", "apresolve.spotify.com", "spclient.wg.spotify.com", "api-partner.spotify.com", "clienttoken.spotify.com"].includes(url.hostname)
    || /^[a-z0-9-]+-(?:spclient|dealer)\.spotify\.com$/.test(url.hostname);
  if (!allowed || url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443"))
    fail("INVALID_ENDPOINT", "Requests must use an approved Spotify HTTPS endpoint.");
  if (query) for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) {
    url.searchParams.delete(key);
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
  }
  return url;
}
export async function readJson(response) {
  const chunks = []; let length = 0;
  if (!response.body) return null;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 8 * 1024 * 1024) fail("RESPONSE_TOO_LARGE", "Spotify returned a response exceeding the size limit.");
    chunks.push(chunk);
  }
  if (!length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { fail("INVALID_RESPONSE", "Spotify did not return a valid JSON response."); }
}
export function createRequest(getAccessToken, { fetchImpl = fetch } = {}) {
  return async (input, { method = "GET", body, query, headers = {} } = {}) => {
    const url = spotifyUrl(input, query);
    if (!["GET", "POST", "PUT", "DELETE", "PATCH"].includes(method)) fail("INVALID_METHOD", "Unsupported Spotify request method.");
    if (Object.keys(headers).some(k => /^(?:authorization|cookie|host)$/i.test(k))) fail("INVALID_HEADER", "Credentials are supplied only by the private session.");
    const token = ["apresolve.spotify.com", "clienttoken.spotify.com"].includes(url.hostname) ? null : await getAccessToken();
    if (token !== null && (typeof token !== "string" || !token || /[\r\n\x00]/.test(token))) fail("INVALID_SESSION", "The saved Spotify session is invalid.");
    let response;
    try {
      response = await fetchImpl(url, {
        method, headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(15000),
      });
    } catch { fail("NETWORK_ERROR", "Spotify did not confirm the request. Read playback state before retrying an action."); }
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      await response.body?.cancel().catch(() => {});
      fail("RATE_LIMITED", "Spotify rate limited the request. It was not repeated.", /^\d+$/.test(retry || "") ? { retryAfterSeconds: Number(retry) } : undefined);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const code = response.status === 401 ? "AUTHENTICATION_REQUIRED" : response.status === 403 ? "ACCESS_DENIED" : response.status === 404 ? "NOT_FOUND" : "SPOTIFY_HTTP_ERROR";
      fail(code, `Spotify rejected the request (HTTP ${response.status}).`, { httpStatus: response.status });
    }
    const result = await readJson(response);
    if (result?.errors?.some(e => e.message === "PersistedQueryNotFound"))
      fail("QUERY_VERSION_UNSUPPORTED", "Spotify no longer recognizes the pinned query. Update the CLI query manifest.");
    if (result?.errors?.length) fail("QUERY_ERROR", "Spotify rejected the catalog query.");
    return result;
  };
}
