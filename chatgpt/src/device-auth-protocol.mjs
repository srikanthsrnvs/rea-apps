import { timingSafeEqual } from 'node:crypto';
import { ChatGptError } from './errors.mjs';
import { sha256url } from './native-crypto.mjs';

// OpenAI Codex's public device authorization flow. No Android proof key is used.
export const DEVICE_AUTH_CONFIG = Object.freeze({
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  flowVersion: 'codex-device-auth-v1',
  userCodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
  pollUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
  verificationUrl: 'https://auth.openai.com/codex/device',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  redirectUri: 'https://auth.openai.com/deviceauth/callback',
  minPollIntervalMs: 5_000,
  maxLifetimeMs: 15 * 60 * 1_000,
});

function text(value, label, code = 'INVALID_DEVICE_AUTH_INPUT') {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ChatGptError(code, `${label} must be a nonempty single-line string.`);
  }
  return value;
}

function responseObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChatGptError('INVALID_DEVICE_AUTH_RESPONSE', 'Device authorization returned an invalid response.');
  }
  return value;
}

function verifier(value, code = 'INVALID_DEVICE_AUTH_INPUT') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(value)) {
    throw new ChatGptError(code, 'Device authorization returned an invalid PKCE verifier.');
  }
  return value;
}

function jsonRequest(url, body) {
  return { method: 'POST', url, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body };
}

export function deviceCodeRequest() {
  return jsonRequest(DEVICE_AUTH_CONFIG.userCodeUrl, { client_id: DEVICE_AUTH_CONFIG.clientId });
}

export function parseDeviceCodeResponse(value) {
  const response = responseObject(value);
  const code = 'INVALID_DEVICE_AUTH_RESPONSE';
  const deviceAuthId = text(response.device_auth_id, 'Device authorization ID', code);
  const userCode = text(response.user_code ?? response.usercode, 'User verification code', code);
  if (response.user_code !== undefined && response.usercode !== undefined && response.user_code !== response.usercode) {
    throw new ChatGptError(code, 'Device authorization returned conflicting user codes.');
  }
  const interval = response.interval === undefined ? 5 : response.interval;
  const seconds = typeof interval === 'string' && /^\d+$/.test(interval.trim()) ? Number(interval.trim()) : interval;
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0 || seconds * 1000 > DEVICE_AUTH_CONFIG.maxLifetimeMs) {
    throw new ChatGptError(code, 'Device authorization returned an invalid polling interval.');
  }
  return {
    deviceAuthId,
    userCode,
    intervalMs: Math.max(DEVICE_AUTH_CONFIG.minPollIntervalMs, seconds * 1000),
    verificationUrl: DEVICE_AUTH_CONFIG.verificationUrl,
  };
}

export function deviceTokenPollRequest({ deviceAuthId, userCode } = {}) {
  return jsonRequest(DEVICE_AUTH_CONFIG.pollUrl, {
    device_auth_id: text(deviceAuthId, 'Device authorization ID'),
    user_code: text(userCode, 'User verification code'),
  });
}

export function parseDeviceTokenPollResponse(value) {
  const response = responseObject(value);
  const errorCode = 'INVALID_DEVICE_AUTH_RESPONSE';
  const code = text(response.authorization_code, 'Authorization code', errorCode);
  const proofVerifier = verifier(response.code_verifier, errorCode);
  const challenge = response.code_challenge;
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    throw new ChatGptError(errorCode, 'Device authorization returned an invalid PKCE challenge.');
  }
  if (!timingSafeEqual(Buffer.from(sha256url(proofVerifier)), Buffer.from(challenge))) {
    throw new ChatGptError('AUTH_PKCE_MISMATCH', 'Device authorization returned inconsistent PKCE values.');
  }
  return { code, verifier: proofVerifier, challenge };
}

// Encode these fields as application/x-www-form-urlencoded for token exchange.
export function deviceCodeGrant({ code, verifier: proofVerifier } = {}) {
  return {
    grant_type: 'authorization_code',
    client_id: DEVICE_AUTH_CONFIG.clientId,
    code: text(code, 'Authorization code'),
    code_verifier: verifier(proofVerifier),
    redirect_uri: DEVICE_AUTH_CONFIG.redirectUri,
  };
}
