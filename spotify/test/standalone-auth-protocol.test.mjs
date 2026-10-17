import test from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_ID, DEFAULT_SCOPES, DEVICE_AUTH_URL, TOKEN_URL, AuthProtocolError,
  deviceAuthorizationParams, deviceTokenParams, refreshTokenParams,
  parseDeviceAuthorization, parseTokenResponse, publicAuthorization, classifyOAuthError,
} from "../src/standalone/auth-protocol.mjs";

const now = 1_800_000_000_000;
const pending = () => ({
  device_code: "SECRET-device-code==", user_code: "ABCDEF",
  verification_uri: "https://spotify.com/pair",
  verification_uri_complete: "https://spotify.com/pair?code=ABCDEF",
  expires_in: 3599, interval: 5,
});
const token = () => ({
  access_token: "SECRET-access-token", refresh_token: "SECRET-refresh-token",
  expires_in: 3600, token_type: "Bearer", scope: "streaming user-read-private",
});
function invalid(fn) {
  assert.throws(fn, (error) => error instanceof AuthProtocolError &&
    !/SECRET|evil|malicious/u.test(error.message));
}

test("device grant uses canonical public client and standard form fields without secrets or redirect", () => {
  assert.equal(CLIENT_ID, "65b708073fc0480ea92a077233ca87bd");
  assert.equal(DEVICE_AUTH_URL, "https://accounts.spotify.com/oauth2/device/authorize");
  assert.equal(TOKEN_URL, "https://accounts.spotify.com/api/token");
  assert.equal(DEFAULT_SCOPES.length, 26);
  assert.equal(new Set(DEFAULT_SCOPES).size, 26);
  assert.ok(Object.isFrozen(DEFAULT_SCOPES));
  const start = deviceAuthorizationParams();
  assert.deepEqual([...start.keys()], ["client_id", "scope"]);
  assert.deepEqual(start.get("scope").split(" "), DEFAULT_SCOPES);
  assert.equal(deviceTokenParams("SECRET+code/==").get("device_code"), "SECRET+code/==");
  assert.equal(deviceTokenParams("SECRET+code/==").get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
  assert.equal(refreshTokenParams("SECRET-refresh").get("refresh_token"), "SECRET-refresh");
  assert.equal(refreshTokenParams("SECRET-refresh").get("grant_type"), "refresh_token");
});

test("scope and credential inputs reject ambiguous or injected form values", () => {
  assert.deepEqual([...deviceAuthorizationParams([])], [["client_id", CLIENT_ID]]);
  assert.equal(deviceAuthorizationParams(["streaming", "streaming"]).get("scope"), "streaming");
  for (const value of ["streaming", null, ["streaming user-read-email"], ["&client_secret=SECRET"], [""]]) {
    invalid(() => deviceAuthorizationParams(value));
  }
  for (const value of [" SECRET", "SECRET ", "SECRET\n", "", null, 1]) {
    invalid(() => deviceTokenParams(value));
    invalid(() => refreshTokenParams(value));
  }
});

test("device authorization honors server expiry/interval and retains private code only internally", () => {
  const record = parseDeviceAuthorization(pending(), now);
  assert.equal(record.deviceCode, "SECRET-device-code==");
  assert.equal(record.expiresAt, now + 3_599_000);
  assert.equal(record.intervalMs, 5000);
  assert.equal(record.nextPollAt, now + 5000);
  assert.equal(record.url, "https://spotify.com/pair?code=ABCDEF");
  const fallback = pending();
  delete fallback.verification_uri_complete;
  delete fallback.interval;
  const noComplete = parseDeviceAuthorization(fallback, now);
  assert.equal(noComplete.url, fallback.verification_uri);
  assert.equal(noComplete.intervalMs, 5000);
  const visible = publicAuthorization({ ...record, accessToken: "SECRET-access", refreshToken: "SECRET-refresh" });
  assert.deepEqual(visible, {
    loggedIn: false, phase: "awaiting_approval",
    verificationUri: "https://spotify.com/pair?code=ABCDEF", userCode: "ABCDEF", expiresAt: now + 3_599_000,
  });
  assert.doesNotMatch(JSON.stringify(visible), /SECRET|deviceCode|accessToken|refreshToken/u);
});

test("approval links must be HTTPS on exact Spotify approval hosts", () => {
  for (const uri of [
    "http://spotify.com/pair", "https://spotify.com.evil.test/pair", "https://evilspotify.com/pair",
    "https://spotify.com@evil.test/pair", "https://evil:SECRET@spotify.com/pair",
    "https://spotify.com:8443/pair", "javascript:malicious", " https://spotify.com/pair",
    "https://spotify.com/pair\n", "https://spotify.com\\@evil.test/pair", null,
  ]) {
    invalid(() => parseDeviceAuthorization({ ...pending(), verification_uri: uri }, now));
    invalid(() => parseDeviceAuthorization({ ...pending(), verification_uri_complete: uri }, now));
  }
  for (const host of ["spotify.com", "www.spotify.com", "accounts.spotify.com"]) {
    assert.equal(parseDeviceAuthorization({ ...pending(), verification_uri: `https://${host}/pair` }, now).verificationUri,
      `https://${host}/pair`);
  }
});

test("malformed codes, lifetimes and payload shapes cannot create an auth session", () => {
  for (const value of [null, [], true, "SECRET"]) invalid(() => parseDeviceAuthorization(value, now));
  for (const user_code of [" ABCDEF", "ABCDEF ", "abcDEF", "ABC\nDEF", "-ABCDEF", "ABCDEF-", ""]) {
    invalid(() => parseDeviceAuthorization({ ...pending(), user_code }, now));
  }
  assert.equal(parseDeviceAuthorization({ ...pending(), user_code: "ABC-DEF" }, now).userCode, "ABC-DEF");
  for (const expires_in of [undefined, null, 0, -1, 3.5, "3600", Infinity, 86401]) {
    invalid(() => parseDeviceAuthorization({ ...pending(), expires_in }, now));
  }
  for (const interval of [null, 0, -1, 1.5, "5", 301]) {
    invalid(() => parseDeviceAuthorization({ ...pending(), interval }, now));
  }
  for (const time of [NaN, -1, Infinity, Number.MAX_SAFE_INTEGER]) {
    invalid(() => parseDeviceAuthorization(pending(), time));
  }
  invalid(() => parseDeviceAuthorization({ ...pending(), expires_in: 1, interval: 300 }, Number.MAX_SAFE_INTEGER - 2000));
});

test("refresh retains existing private refresh token only when response omits a replacement", () => {
  const session = parseTokenResponse(token(), { nowMs: now });
  assert.deepEqual(session, {
    accessToken: "SECRET-access-token", refreshToken: "SECRET-refresh-token",
    tokenType: "Bearer", expiresAt: now + 3_600_000, scope: "streaming user-read-private",
  });
  const response = token(); delete response.refresh_token;
  assert.equal(parseTokenResponse(response, { previousRefreshToken: "SECRET-previous", nowMs: now }).refreshToken, "SECRET-previous");
  assert.equal(parseTokenResponse(token(), { previousRefreshToken: "SECRET-previous", nowMs: now }).refreshToken, "SECRET-refresh-token");
  invalid(() => parseTokenResponse(response, { nowMs: now }));
  invalid(() => parseTokenResponse({ ...token(), refresh_token: "" }, { previousRefreshToken: "SECRET-previous", nowMs: now }));
  for (const patch of [{ token_type: "MAC" }, { access_token: "SECRET\n" }, { expires_in: 0 }, { scope: "SECRET\n" }]) {
    invalid(() => parseTokenResponse({ ...token(), ...patch }, { nowMs: now }));
  }
});

test("OAuth outcomes are actionable without reflecting server diagnostics or credentials", () => {
  const expected = {
    authorization_pending: ["AUTHORIZATION_PENDING", "awaiting_approval", true],
    slow_down: ["AUTHORIZATION_SLOW_DOWN", "awaiting_approval", true],
    access_denied: ["AUTHORIZATION_DENIED", "denied", false],
    expired_token: ["AUTHORIZATION_EXPIRED", "expired", false],
    invalid_grant: ["AUTHENTICATION_REQUIRED", "reauth_required", false],
    invalid_client: ["AUTH_CLIENT_REJECTED", "error", false],
    unauthorized_client: ["AUTH_CLIENT_UNSUPPORTED", "error", false],
    invalid_scope: ["AUTH_SCOPE_REJECTED", "error", false],
    unsupported_grant_type: ["AUTH_GRANT_UNSUPPORTED", "error", false],
  };
  for (const [error, [code, phase, retryable]] of Object.entries(expected)) {
    const result = classifyOAuthError({ error, error_description: "SECRET-private", device_code: "SECRET-code" }, 400);
    assert.deepEqual([result.code, result.phase, result.retryable], [code, phase, retryable]);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/u);
  }
  assert.equal(classifyOAuthError({ error: "SECRET-unknown", error_description: "SECRET" }, 400).code, "AUTH_REQUEST_FAILED");
  assert.equal(classifyOAuthError(null, 429).code, "AUTH_RATE_LIMITED");
  assert.equal(classifyOAuthError("SECRET-edge-error", 503).code, "AUTH_SERVICE_UNAVAILABLE");
  assert.equal(classifyOAuthError({ error: "__proto__" }, 400).code, "AUTH_REQUEST_FAILED");
  assert.doesNotMatch(JSON.stringify(classifyOAuthError({ error: "SECRET-unknown" }, 400)), /SECRET/u);
});
