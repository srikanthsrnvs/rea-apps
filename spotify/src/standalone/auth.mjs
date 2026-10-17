import { randomBytes } from "node:crypto";
import { readState, saveState, removeState, withStateLock } from "./state.mjs";
import { DEVICE_AUTH_URL, TOKEN_URL, deviceAuthorizationParams, deviceTokenParams, refreshTokenParams, parseDeviceAuthorization, parseTokenResponse, publicAuthorization, classifyOAuthError } from "./auth-protocol.mjs";
import { readJson } from "./http.mjs";
const fail = (error) => { throw Object.assign(new Error(error.message), { code: error.code }); };
async function exchange(url, params) {
  let response;
  try { response = await fetch(url, { method: "POST", body: params, redirect: "error", signal: AbortSignal.timeout(15000) }); }
  catch { fail({ code: "AUTH_NETWORK_ERROR", message: "Spotify authentication did not respond. The request was not repeated." }); }
  const body = await readJson(response);
  const retryHeader = response.headers.get("retry-after");
  const retryAfterMs = /^\d+$/.test(retryHeader || "") ? Number(retryHeader) * 1000 : Math.max(0, Date.parse(retryHeader || "") - Date.now()) || 0;
  return { ok: response.ok, status: response.status, body, retryAfterMs };
}
const authenticated = session => ({ loggedIn: true, phase: "authenticated", ...(session.username ? { username: session.username } : {}), backend: "standalone" });
const approval = pending => ({ ...publicAuthorization(pending), ...(pending.transientError ? { temporaryError: pending.transientError, retryAfterSeconds: Math.max(0, Math.ceil((pending.nextPollAt - Date.now()) / 1000)) } : {}) });
export async function login() {
  return withStateLock(async () => {
    const session = await readState("session");
    if (session && !session.reauthRequired) return authenticated(session);
    const pending = await readState("login");
    if (pending?.expiresAt > Date.now() && !pending.error) return approval(pending);
    const response = await exchange(DEVICE_AUTH_URL, deviceAuthorizationParams());
    if (!response.ok) fail(classifyOAuthError(response.body, response.status));
    const next = parseDeviceAuthorization(response.body);
    await saveState("login", next); return approval(next);
  });
}
export async function loginStatus() {
  return withStateLock(async () => {
    const session = await readState("session");
    if (session && !session.reauthRequired) return authenticated(session);
    const pending = await readState("login");
    if (!pending) return { loggedIn: false, phase: session?.reauthRequired ? "reauth_required" : "logged_out", backend: "standalone" };
    if (pending.expiresAt <= Date.now()) return { loggedIn: false, phase: "expired", backend: "standalone" };
    if (pending.error) return { loggedIn: false, phase: pending.error.phase, errorCode: pending.error.code };
    if (pending.nextPollAt > Date.now()) return approval(pending);
    pending.nextPollAt = Date.now() + pending.intervalMs;
    await saveState("login", pending);
    const response = await exchange(TOKEN_URL, deviceTokenParams(pending.deviceCode));
    if (!response.ok) {
      const error = classifyOAuthError(response.body, response.status);
      delete pending.transientError;
      if (error.code === "AUTHORIZATION_SLOW_DOWN") {
        pending.intervalMs += 5000; pending.nextPollAt = Date.now() + pending.intervalMs;
      } else if (error.code !== "AUTHORIZATION_PENDING") {
        if (error.retryable) {
          pending.transientError = error.code;
          pending.nextPollAt = Date.now() + Math.max(pending.intervalMs, response.retryAfterMs, 10000);
        } else pending.error = error;
      }
      await saveState("login", pending);
      return pending.error ? { loggedIn: false, phase: error.phase, errorCode: error.code } : approval(pending);
    }
    const next = { ...parseTokenResponse(response.body), controllerId: randomBytes(16).toString("hex"), acquiredAt: Date.now() };
    await saveState("session", next); await removeState("login");
    return authenticated(next);
  });
}
// Caller holds the shared command lock. Never starts a browser or desktop app.
export async function getSession({ refresh = false } = {}) {
  let session = await readState("session");
  if (!session) fail({ code: "LOGIN_REQUIRED", message: "Run spotify login and approve the returned Spotify pairing link." });
  if (session.reauthRequired) fail({ code: "LOGIN_REQUIRED", message: "The saved Spotify authorization was revoked. Run spotify login again." });
  if (refresh || session.expiresAt <= Date.now() + 60000) {
    const response = await exchange(TOKEN_URL, refreshTokenParams(session.refreshToken));
    if (!response.ok) {
      const error = classifyOAuthError(response.body, response.status);
      if (error.phase === "reauth_required") await saveState("session", { ...session, reauthRequired: true });
      fail(error);
    }
    session = { ...session, ...parseTokenResponse(response.body, { previousRefreshToken: session.refreshToken }) };
    await saveState("session", session);
  }
  return session;
}
export async function logout() {
  return withStateLock(async () => { await removeState("session"); await removeState("login"); return { loggedIn: false, phase: "logged_out", backend: "standalone" }; });
}
