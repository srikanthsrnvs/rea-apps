import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { createDPoP, createPKCE, createProofKey, proofTarget, sha256url } from '../src/native-crypto.mjs';

test('native DPoP signs P-256 proof, exposes only public key, and binds method, target and token', () => {
  const key = createProofKey();
  const jwt = createDPoP({ privateJwk: key, url: 'https://AUTH.OPENAI.COM:443/oauth/token?ignored=1#fragment',
    accessToken: 'test-token', now: 1_800_000_123_456, id: 'test-request' });
  const [h, p, s] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.deepEqual({ ...header, jwk: undefined }, { typ: 'dpop+jwt', alg: 'ES256', jwk: undefined });
  assert.equal(header.jwk.d, undefined);
  assert.deepEqual(payload, { htm: 'POST', htu: 'https://auth.openai.com/oauth/token', jti: 'test-request',
    iat: 1_800_000_123, ath: sha256url('test-token') });
  const publicKey = createPublicKey({ key: header.jwk, format: 'jwk' });
  assert.equal(Buffer.from(s, 'base64url').length, 64);
  assert.equal(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), true);
  assert.equal(verify('sha256', Buffer.from(`${h}.${p}tampered`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), false);
});

test('token-exchange proof has no access-token hash; every proof gets a fresh ID', () => {
  const options = { privateJwk: createProofKey(), url: 'https://auth.openai.com/oauth/token' };
  const payload = jwt => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url'));
  const first = payload(createDPoP(options)), second = payload(createDPoP(options));
  assert.equal(Object.hasOwn(first, 'ath'), false);
  assert.notEqual(first.jti, second.jti);
});

test('PKCE uses independent high-entropy verifier and S256 challenge', () => {
  const a = createPKCE(), b = createPKCE();
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.challenge, sha256url(a.verifier));
  assert.notEqual(a.verifier, b.verifier);
});

test('proof target retains a non-default port and rejects embedded credentials', () => {
  assert.equal(proofTarget('https://example.test:8443/Some/Path?q=a'), 'https://example.test:8443/Some/Path');
  assert.throws(() => proofTarget('https://user:secret@example.test/path'));
  assert.throws(() => proofTarget('file:///tmp/test'));
});
