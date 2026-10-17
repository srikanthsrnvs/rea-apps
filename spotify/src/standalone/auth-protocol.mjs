// Independent RFC 8628 device-grant implementation. The public desktop client ID
// and grant endpoints are present in Spotify's shipped desktop application.
// Corroborating protocol reference (MIT): librespot revision
// 19959512c212cbc48a3ff64382fe204f52c659a7, docs/device-authorization.md.
// No network, persistence, or browser operations belong in this module.

export const CLIENT_ID = "65b708073fc0480ea92a077233ca87bd";
export const DEVICE_AUTH_URL = "https://accounts.spotify.com/oauth2/device/authorize";
export const TOKEN_URL = "https://accounts.spotify.com/api/token";
export const DEFAULT_SCOPES = Object.freeze([
  "app-remote-control", "playlist-modify", "playlist-modify-private",
  "playlist-modify-public", "playlist-read", "playlist-read-collaborative",
  "playlist-read-private", "streaming", "ugc-image-upload", "user-follow-modify",
  "user-follow-read", "user-library-modify", "user-library-read", "user-modify",
  "user-modify-playback-state", "user-modify-private", "user-personalized",
  "user-read-birthdate", "user-read-currently-playing", "user-read-email",
  "user-read-play-history", "user-read-playback-position", "user-read-playback-state",
  "user-read-private", "user-read-recently-played", "user-top-read",
]);

export class AuthProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthProtocolError";
    this.code = code;
  }
}

const invalid = () => {
  throw new AuthProtocolError("INVALID_AUTH_RESPONSE", "Spotify returned an invalid authentication response.");
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
};
function seconds(value, fallback, maximum = 86400) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) invalid();
  return result;
}
function secret(value, errorCode = "INVALID_AUTH_RESPONSE") {
  // OAuth tokens and device codes are opaque. Reject whitespace/control characters
  // without reflecting any part of the offending credential in an exception.
  if (typeof value !== "string" || value.length < 1 || value.length > 16384 || /[^\x21-\x7e]/u.test(value)) {
    throw new AuthProtocolError(errorCode, "A required authentication credential is invalid.");
  }
  return value;
}
function approvalUrl(value) {
  if (typeof value !== "string" || value.length > 4096 || value !== value.trim() || /[\x00-\x20\x7f\\]/u.test(value)) invalid();
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !["spotify.com", "www.spotify.com", "accounts.spotify.com"].includes(url.hostname)) invalid();
  return url.href;
}
function userCode(value) {
  if (typeof value !== "string" || !/^[A-Z0-9](?:[A-Z0-9-]{0,62}[A-Z0-9])?$/u.test(value)) invalid();
  return value;
}
function scopeList(value) {
  if (!Array.isArray(value) || value.length > 100 || value.some((scope) =>
    typeof scope !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/u.test(scope))) {
    throw new AuthProtocolError("INVALID_AUTH_SCOPE", "Authentication scopes must be valid scope names.");
  }
  return [...new Set(value)];
}

export function deviceAuthorizationParams(scopes = DEFAULT_SCOPES) {
  const params = new URLSearchParams({ client_id: CLIENT_ID });
  const requested = scopeList(scopes);
  if (requested.length) params.set("scope", requested.join(" "));
  return params;
}

export function deviceTokenParams(deviceCode) {
  return new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: secret(deviceCode, "INVALID_DEVICE_CODE"),
  });
}

export function refreshTokenParams(refreshToken) {
  return new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: secret(refreshToken, "INVALID_REFRESH_TOKEN"),
  });
}

// PRIVATE result: deviceCode is a credential. Never serialize this record as a
// tool result. publicAuthorization deliberately selects the safe fields instead.
export function parseDeviceAuthorization(payload, nowMs = Date.now()) {
  if (!object(payload)) invalid();
  const now = timestamp(nowMs);
  const intervalMs = seconds(payload.interval, 5, 300) * 1000;
  const expiresAt = now + seconds(payload.expires_in, undefined) * 1000;
  const nextPollAt = now + intervalMs;
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(nextPollAt)) invalid();
  const verificationUri = approvalUrl(payload.verification_uri);
  const verificationUriComplete = payload.verification_uri_complete === undefined
    ? undefined : approvalUrl(payload.verification_uri_complete);
  return {
    deviceCode: secret(payload.device_code),
    userCode: userCode(payload.user_code),
    verificationUri,
    ...(verificationUriComplete ? { verificationUriComplete } : {}),
    url: verificationUriComplete ?? verificationUri,
    expiresAt,
    nextPollAt,
    intervalMs,
  };
}

// PRIVATE result: tokens stay in the owner-only session store. OAuth refresh
// responses may omit a replacement refresh token; retain the previous one.
export function parseTokenResponse(payload, { previousRefreshToken, nowMs = Date.now() } = {}) {
  if (!object(payload) || typeof payload.token_type !== "string" || payload.token_type.toLowerCase() !== "bearer") invalid();
  const now = timestamp(nowMs);
  const expiresAt = now + seconds(payload.expires_in, undefined) * 1000;
  if (!Number.isSafeInteger(expiresAt)) invalid();
  const scope = payload.scope === undefined ? "" : payload.scope;
  if (typeof scope !== "string" || scope.length > 16384 || /[^\x20-\x7e]/u.test(scope)) invalid();
  return {
    accessToken: secret(payload.access_token),
    refreshToken: secret(payload.refresh_token === undefined ? previousRefreshToken : payload.refresh_token),
    tokenType: "Bearer",
    expiresAt,
    scope,
  };
}

export function publicAuthorization(record) {
  if (!object(record)) invalid();
  return {
    loggedIn: false,
    phase: "awaiting_approval",
    verificationUri: approvalUrl(record.url ?? record.verificationUriComplete ?? record.verificationUri),
    userCode: userCode(record.userCode),
    expiresAt: timestamp(record.expiresAt),
  };
}

const OAUTH_ERRORS = Object.freeze({
  authorization_pending: ["AUTHORIZATION_PENDING", "awaiting_approval", true, "Spotify is waiting for approval."],
  slow_down: ["AUTHORIZATION_SLOW_DOWN", "awaiting_approval", true, "Spotify requires a longer polling interval."],
  access_denied: ["AUTHORIZATION_DENIED", "denied", false, "Spotify sign-in was declined."],
  expired_token: ["AUTHORIZATION_EXPIRED", "expired", false, "The Spotify approval code expired. Start sign-in again."],
  invalid_grant: ["AUTHENTICATION_REQUIRED", "reauth_required", false, "Spotify sign-in is no longer valid. Start sign-in again."],
  invalid_client: ["AUTH_CLIENT_REJECTED", "error", false, "Spotify rejected this authentication client."],
  unauthorized_client: ["AUTH_CLIENT_UNSUPPORTED", "error", false, "Spotify does not allow this authentication flow for this client."],
  invalid_scope: ["AUTH_SCOPE_REJECTED", "error", false, "Spotify rejected the requested authentication scopes."],
  invalid_request: ["AUTH_REQUEST_REJECTED", "error", false, "Spotify rejected the authentication request."],
  unsupported_grant_type: ["AUTH_GRANT_UNSUPPORTED", "error", false, "Spotify rejected this authentication grant type."],
  server_error: ["AUTH_SERVICE_UNAVAILABLE", "error", true, "Spotify authentication is temporarily unavailable."],
  temporarily_unavailable: ["AUTH_SERVICE_UNAVAILABLE", "error", true, "Spotify authentication is temporarily unavailable."],
});

// Never copy error_description or an unknown server error string: upstream
// diagnostic text can contain submitted credentials or other private data.
export function classifyOAuthError(payload, status) {
  const known = object(payload) && typeof payload.error === "string"
    ? Object.hasOwn(OAUTH_ERRORS, payload.error) && OAUTH_ERRORS[payload.error] : undefined;
  if (known) {
    const [code, phase, retryable, message] = known;
    return { code, phase, retryable, message };
  }
  if (status === 429) return {
    code: "AUTH_RATE_LIMITED", phase: "error", retryable: true,
    message: "Spotify authentication is rate limited. Wait before retrying.",
  };
  if (Number.isInteger(status) && status >= 500 && status <= 599) return {
    code: "AUTH_SERVICE_UNAVAILABLE", phase: "error", retryable: true,
    message: "Spotify authentication is temporarily unavailable.",
  };
  return {
    code: "AUTH_REQUEST_FAILED", phase: "error", retryable: false,
    message: "Spotify authentication failed.",
  };
}
