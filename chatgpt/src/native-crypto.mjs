import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { ChatGptError } from './errors.mjs';

const encode = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
export const sha256url = value => createHash('sha256').update(value).digest('base64url');

export function createProofKey() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
}

export function publicProofKey(privateJwk) {
  const publicJwk = createPublicKey(createPrivateKey({ key: privateJwk, format: 'jwk' })).export({ format: 'jwk' });
  const { kty, crv, x, y } = publicJwk;
  if (kty !== 'EC' || crv !== 'P-256' || !x || !y) {
    throw new ChatGptError('INVALID_PROOF_KEY', 'The saved proof key must use the P-256 curve.');
  }
  return { kty, crv, x, y };
}

export function proofTarget(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new ChatGptError('INVALID_PROOF_URL', 'Proof targets must be HTTP URLs without embedded credentials.');
  }
  return `${url.origin}${url.pathname || '/'}`;
}

// Native Android proof format: REA ev_5ecd280b75d0d740a25c0f8b8716999cb61a2cfc691c5e835b14a42d9746c3d5.
export function createDPoP({ privateJwk, url, method = 'POST', accessToken, nonce, now = Date.now(), id = randomUUID() }) {
  if (!Number.isFinite(now) || !id || !/^[A-Z]+$/.test(method)) {
    throw new ChatGptError('INVALID_PROOF_INPUT', 'Proof time, request ID and HTTP method are required.');
  }
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: publicProofKey(privateJwk) };
  const payload = { htm: method, htu: proofTarget(url), jti: id, iat: Math.floor(now / 1000) };
  if (accessToken) payload.ath = sha256url(accessToken);
  if (nonce) payload.nonce = nonce;
  const input = `${encode(header)}.${encode(payload)}`;
  const signature = sign('sha256', Buffer.from(input), {
    key: createPrivateKey({ key: privateJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363',
  });
  return `${input}.${signature.toString('base64url')}`;
}

export function createPKCE() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: sha256url(verifier), method: 'S256' };
}
