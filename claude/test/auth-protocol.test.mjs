import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sendMagicLinkRequest, sendMagicLinkRequestHash, parseSendMagicLinkResponse,
  verifyEmailCodeRequest, verifyMagicLinkRequest, parseMagicLink,
  verifyGoogleMobileRequest, parseVerifyResponse,
} from '../src/auth-protocol.mjs';

test('email initiation preserves existing identity and has no fabricated proof', () => {
  const request = sendMagicLinkRequest({ email: 'person@example.com', utcOffset: -420, issuedAt: 1792340000, nonce: 'fresh-own-nonce' });
  assert.equal(request.url, 'https://claude.ai/api/auth/send_magic_link');
  assert.equal(request.json.email_address, 'person@example.com');
  assert.equal(request.json.utc_offset, -420);
  assert.equal(request.json.attestation_issued_at, 1792340000);
  assert.equal(request.json.client_attestation, undefined);
  assert.equal(request.json.play_integrity_token, undefined);
  assert.equal(request.json.login_intent, undefined);
  assert.throws(() => sendMagicLinkRequest({ email: 'person@example.com', issuedAt: 1 }), /together/);
});

test('public request hash is SHA-256 hexadecimal and input-bound', () => {
  const hash = sendMagicLinkRequestHash({ email: 'person@example.com', issuedAt: 1792340000, nonce: 'fresh-own-nonce' });
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, sendMagicLinkRequestHash({ email: 'other@example.com', issuedAt: 1792340000, nonce: 'fresh-own-nonce' }));
  assert.notEqual(hash, sendMagicLinkRequestHash({ email: 'person@example.com', issuedAt: 1792340001, nonce: 'fresh-own-nonce' }));
});

test('send response distinguishes sent, SSO and refusal without claiming auth', () => {
  assert.deepEqual(parseSendMagicLinkResponse({ sent: true, fallback_code_configuration: { charset: 'numeric', length: 6, show_input_after_delay: 0 } }), {
    status: 'email_sent', codeConfiguration: { charset: 'numeric', length: 6, showInputAfterDelay: 0 }, magicLinkIntentAvailable: false,
  });
  assert.equal(parseSendMagicLinkResponse({ sso_url: 'https://claude.ai/sso/example' }).status, 'sso_required');
  assert.throws(() => parseSendMagicLinkResponse({ sent: false }), /did not confirm/);
  assert.throws(() => parseSendMagicLinkResponse({ sent: true, fallback_code_configuration: { length: -1 } }), /configuration/);
  assert.throws(() => parseSendMagicLinkResponse({ sso_url: 'javascript:alert(1)' }), /Unsafe/);
});

test('code and nonce credentials remain distinct and no proof is invented', () => {
  const request = verifyEmailCodeRequest({ email: 'person@example.com', code: '001234' });
  assert.deepEqual(request.json.credentials, { method: 'code', code: '001234', email_address: 'person@example.com' });
  assert.equal(request.json.play_integrity_token, null);
  assert.equal(request.json.client_attestation, undefined);
  assert.throws(() => verifyEmailCodeRequest({ email: 'person@example.com', code: '123\n456' }), /Invalid/);
  const nonce = verifyMagicLinkRequest({ nonce: 'nonce-value', encodedEmailAddress: 'encoded-email', playIntegrityToken: 'genuine-proof' });
  assert.deepEqual(nonce.json.credentials, { method: 'nonce', nonce: 'nonce-value', encoded_email_address: 'encoded-email' });
  assert.equal(nonce.json.play_integrity_token, 'genuine-proof');
});

test('magic link parser rejects foreign origins and malformed credentials', () => {
  assert.deepEqual(parseMagicLink('https://claude.ai/magic-link/android#one:two'), { nonce: 'one', encodedEmailAddress: 'two' });
  assert.throws(() => parseMagicLink('https://claude.ai.evil.example/magic-link/android#one:two'), /official/);
  assert.throws(() => parseMagicLink('https://claude.ai/magic-link/android#one:two:three'), /credentials/);
  assert.throws(() => parseMagicLink('http://claude.ai/magic-link/android#one:two'), /official/);
});

test('Google identity tokens use separate native endpoint', () => {
  const request = verifyGoogleMobileRequest({ token: 'genuine-google-id-token', loginToken: 'existing-login-token' });
  assert.equal(request.url, 'https://claude.ai/api/auth/verify_google_mobile');
  assert.equal(request.json.token, 'genuine-google-id-token');
  assert.equal(request.json.login_token, 'existing-login-token');
  assert.equal(request.json.join_token, undefined);
  assert.throws(() => verifyGoogleMobileRequest({ token: 'x', origin: 'https://example.com' }), /Unsupported/);
});

test('verification cannot declare success without valid account', () => {
  const account = { uuid: '00000000-0000-4000-8000-000000000001', email_address: 'person@example.com', memberships: [] };
  assert.equal(parseVerifyResponse({ success: true, account, created: false }).accountId, account.uuid);
  assert.equal(parseVerifyResponse({ success: true, state: { kind: 'authenticated', account } }).status, 'authenticated');
  assert.throws(() => parseVerifyResponse({ success: true }), /authenticated account/);
  assert.throws(() => parseVerifyResponse({ success: false, account }), /authenticated account/);
  assert.equal(parseVerifyResponse({ state: { kind: 'second_factor_required', code_length: 6 } }).status, 'additional_verification_required');
});
