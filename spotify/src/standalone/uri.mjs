const invalid = (message) => { throw Object.assign(new Error(message), { code: "INVALID_ARGUMENT" }); };

// Resource validation is independent of authentication and playback transport.
export function spotifyUri(value) {
  if (typeof value !== "string") invalid("A Spotify URI or open.spotify.com URL is required.");
  if (value.startsWith("https://open.spotify.com/")) {
    const url = new URL(value), parts = url.pathname.split("/").filter(Boolean);
    if (parts[0]?.startsWith("intl-")) parts.shift();
    if (parts.length !== 2) invalid("Expected a Spotify resource URL.");
    value = `spotify:${parts[0]}:${parts[1]}`;
  }
  if (!/^spotify:(?:track|album|artist|playlist|episode|show|audiobook|user):[A-Za-z0-9]+$/.test(value))
    invalid("Expected a supported Spotify resource URI or URL.");
  return value;
}

export function spotifyUris(value) {
  const values = (Array.isArray(value) ? value : String(value ?? "").split(",")).map(spotifyUri);
  if (!values.length || values.length > 1000) invalid("Supply between 1 and 1000 Spotify URIs.");
  return values;
}

export function spotifyId(value, type) {
  const uri = spotifyUri(value), parts = uri.split(":");
  if (parts[1] !== type) invalid(`Expected a Spotify ${type} URI.`);
  return parts[2];
}
