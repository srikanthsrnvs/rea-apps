import { createHash } from 'node:crypto';
import { ClaudeError } from './errors.mjs';

export const CLAUDE_AUTH = Object.freeze({
  origin: 'https://claude.ai',
  webOrigin: 'https://claude.ai',
  magicLinkPath: '/magic-link/android',
  googleClientId: '1062961139910-l2m55cb9h51u5cuc9c56eb3fevouidh9.apps.googleusercontent.com',
});

function text(value, name, max = 8192) {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ClaudeError('INVALID_ARGUMENT', `Invalid ${name}.`);
  }
  return value;
}

export function normalizeEmail(value) {
  const email = text(value, 'email address', 320).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ClaudeError('INVALID_ARGUMENT', 'Invalid email address.');
  return email;
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ClaudeError('PROTOCOL_ERROR', `Invalid ${name}.`);
  return value;
}

function ssoURL(value) {
  const url = new URL(text(value, 'SSO URL'));
  if (url.protocol !== 'https:' || url.username || url.password) throw new ClaudeError('PROTOCOL_ERROR', 'Unsafe SSO URL.');
  return url.href;
}

function originURL(origin) {
  const url = new URL(origin);
  if (!['https://api.claude.ai', 'https://claude.ai'].includes(url.origin) || url.href !== `${url.origin}/`) {
    throw new ClaudeError('INVALID_ARGUMENT', 'Unsupported Claude API origin.');
  }
  return url.origin;
}

function request(path, json, origin) {
  return { url: `${originURL(origin)}/api/${path}`, method: 'POST', json };
}

function proofFields({ playIntegrityToken = null, clientAttestation } = {}) {
  if (playIntegrityToken !== null) text(playIntegrityToken, 'Play Integrity token', 65536);
  const fields = { play_integrity_token: playIntegrityToken };
  if (clientAttestation !== undefined) {
    object(clientAttestation, 'client attestation');
    const proof = clientAttestation.play_integrity_token;
    const error = clientAttestation.play_integrity_mint_error;
    if (proof != null) text(proof, 'Play Integrity token', 65536);
    if (error != null) text(error, 'Play Integrity mint error', 256);
    fields.client_attestation = {
      ...(proof != null ? { play_integrity_token: proof } : {}),
      ...(error != null ? { play_integrity_mint_error: error } : {}),
    };
  }
  return fields;
}

// This public digest binds an integrity request to its inputs; it is not a signature or proof.
export function sendMagicLinkRequestHash({ email, issuedAt, nonce }) {
  email = normalizeEmail(email);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new ClaudeError('INVALID_ARGUMENT', 'Invalid attestation timestamp.');
  text(nonce, 'attestation nonce', 512);
  return createHash('sha256').update(`send_magic_link/v1:${issuedAt}:${nonce}:${email}`).digest('hex');
}

export function sendMagicLinkRequest({ email, utcOffset = 0, issuedAt, nonce, loginIntent, clientAttestation, origin = CLAUDE_AUTH.origin } = {}) {
  email = normalizeEmail(email);
  if (!Number.isSafeInteger(utcOffset) || Math.abs(utcOffset) > 1440) throw new ClaudeError('INVALID_ARGUMENT', 'Invalid UTC offset in minutes east of UTC.');
  const json = { email_address: email, recaptcha_token: 'xxx', recaptcha_site_key: 'xxx', utc_offset: utcOffset, source: 'claude', client: 'android' };
  if (loginIntent !== undefined) {
    if (loginIntent !== 'magic_link') throw new ClaudeError('INVALID_ARGUMENT', 'Unsupported login intent.');
    json.login_intent = loginIntent;
  }
  if ((issuedAt === undefined) !== (nonce === undefined)) throw new ClaudeError('INVALID_ARGUMENT', 'Timestamp and nonce must be supplied together.');
  if (issuedAt !== undefined) {
    sendMagicLinkRequestHash({ email, issuedAt, nonce });
    json.attestation_issued_at = issuedAt;
    json.attestation_nonce = nonce;
  }
  if (clientAttestation !== undefined) json.client_attestation = proofFields({ clientAttestation }).client_attestation;
  return request('auth/send_magic_link', json, origin);
}

export function parseSendMagicLinkResponse(payload) {
  object(payload, 'send magic link response');
  if (payload.sso_url != null) {
    return { status: 'sso_required', url: ssoURL(payload.sso_url) };
  }
  if (payload.sent !== true) throw new ClaudeError('LOGIN_NOT_SENT', 'Claude did not confirm sending a sign-in email.');
  let codeConfiguration = null;
  if (payload.fallback_code_configuration != null) {
    const config = object(payload.fallback_code_configuration, 'fallback code configuration');
    codeConfiguration = {};
    if (config.charset != null) codeConfiguration.charset = text(config.charset, 'code character set', 256);
    for (const [source, target] of [['length', 'length'], ['show_input_after_delay', 'showInputAfterDelay']]) {
      if (config[source] != null) {
        if (!Number.isSafeInteger(config[source]) || config[source] < 0) throw new ClaudeError('PROTOCOL_ERROR', 'Invalid code configuration.');
        codeConfiguration[target] = config[source];
      }
    }
  }
  return { status: 'email_sent', codeConfiguration, magicLinkIntentAvailable: payload.magic_link_intent_available === true };
}

function verifyRequest(credentials, options) {
  return request('auth/verify_magic_link', {
    credentials, recaptcha_token: 'xxx', recaptcha_site_key: 'xxx', source: 'claude', ...proofFields(options),
  }, options.origin ?? CLAUDE_AUTH.origin);
}

export function verifyEmailCodeRequest({ email, code, ...options } = {}) {
  email = normalizeEmail(email);
  code = text(code, 'email verification code', 128).trim();
  if (!/^[A-Za-z0-9]+$/.test(code)) throw new ClaudeError('INVALID_ARGUMENT', 'Invalid email verification code.');
  return verifyRequest({ method: 'code', code, email_address: email }, options);
}

export function verifyMagicLinkRequest({ nonce, encodedEmailAddress, ...options } = {}) {
  return verifyRequest({ method: 'nonce', nonce: text(nonce, 'magic link nonce'), encoded_email_address: text(encodedEmailAddress, 'encoded email address') }, options);
}

export function parseMagicLink(value) {
  const url = new URL(text(value, 'magic link URL', 16384));
  if (url.origin !== CLAUDE_AUTH.webOrigin || url.pathname !== CLAUDE_AUTH.magicLinkPath || url.username || url.password) {
    throw new ClaudeError('INVALID_ARGUMENT', 'Expected an official Claude Android magic link.');
  }
  const parts = decodeURIComponent(url.hash.slice(1)).split(':');
  if (parts.length !== 2) throw new ClaudeError('INVALID_ARGUMENT', 'Magic link has invalid credentials.');
  return { nonce: text(parts[0], 'magic link nonce'), encodedEmailAddress: text(parts[1], 'encoded email address') };
}

export function verifyGoogleMobileRequest({ token, joinToken, loginToken, ...options } = {}) {
  const json = { token: text(token, 'Google identity token', 65536), recaptcha_token: 'xxx', recaptcha_site_key: 'xxx', source: 'claude', ...proofFields(options) };
  if (joinToken !== undefined) json.join_token = text(joinToken, 'join token');
  if (loginToken !== undefined) json.login_token = text(loginToken, 'login token');
  return request('auth/verify_google_mobile', json, options.origin ?? CLAUDE_AUTH.origin);
}

export function verifyGoogleCodeRequest({ code, redirectUri = '', ...options } = {}) {
  if (typeof redirectUri !== 'string' || /[\x00-\x1f\x7f]/.test(redirectUri)) throw new ClaudeError('INVALID_ARGUMENT', 'Invalid Google redirect URI.');
  return request('auth/verify_google', { code: text(code, 'Google authorization code'), redirect_uri: redirectUri, source: 'claude', ...proofFields(options) }, options.origin ?? CLAUDE_AUTH.origin);
}

export function parseVerifyResponse(payload) {
  object(payload, 'verification response');
  if (payload.sso_url != null) return { status: 'sso_required', url: ssoURL(payload.sso_url) };
  const state = payload.state == null ? null : object(payload.state, 'authentication state');
  if (state && state.kind !== 'authenticated') {
    // AuthenticationState uses explicit variants; lifecycle decides how to continue.
    return { status: 'additional_verification_required', state: object(state, 'authentication state'), created: payload.created === true };
  }
  const account = payload.account ?? state?.account;
  if (!account || payload.success === false) throw new ClaudeError('LOGIN_NOT_VERIFIED', 'Claude did not return an authenticated account.');
  object(account, 'authenticated account');
  const accountId = text(account.uuid, 'account UUID', 128);
  const email = normalizeEmail(account.email_address);
  return { status: 'authenticated', accountId, email, account, created: payload.created === true };
}
