import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pkceChallenge,
  parseCallback,
  decodeLong,
  withExpiry,
  createContext,
  createLogin,
  shoppingRequest,
} from '../src/protocol.mjs';

test('PKCE matches RFC 7636 Appendix B test vector', () => {
  assert.equal(
    pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('callback cannot substitute another loopback port, nonce or native host', () => {
  const expected = 'http://127.0.0.1:45678/callback/nonce';
  for (const value of [
    'http://127.0.0.1:45679/callback/nonce?session=x',
    'http://127.0.0.1:45678/callback/other?session=x',
    'http://user@127.0.0.1:45678/callback/nonce?session=x',
  ])
    assert.throws(() => parseCallback(value, expected));
  assert.throws(() =>
    parseCallback(
      'uberlogin://other.example/applogin/helix?session=x',
      'uberlogin://auth3.uber.com/applogin/helix',
    ),
  );
  assert.deepEqual(
    parseCallback(`${expected}?session=s&authCode=c`, expected),
    { session: 's', authCode: 'c' },
  );
});

test('signed high/low durations retain precision and convert seconds to expiry', () => {
  assert.equal(decodeLong({ high: -1, low: -1, unsigned: false }), -1n);
  assert.equal(decodeLong({ high: 0, low: -1, unsigned: false }), 4294967295n);
  assert.equal(
    decodeLong({ high: 2147483647, low: -1, unsigned: false }),
    9223372036854775807n,
  );
  assert.equal(
    withExpiry({ expiresIn: { high: 0, low: 60, unsigned: false } }, 1000)
      .expiresAt,
    61000,
  );
});

test('login rejects the HTTP callback that Uber excludes from its allowlist', () => {
  assert.throws(
    () => createLogin(createContext(), 'http://127.0.0.1:1234/callback/x'),
    /does not allow/,
  );
  const pending = createLogin(
    createContext(),
    'https://auth.uber.com/v2/applogin/helix',
  );
  assert.equal(
    new URL(pending.url).searchParams.get('app_url'),
    pending.callback,
  );
  assert.equal(
    new URL(pending.url).searchParams.get('codeChallenge'),
    pkceChallenge(pending.verifier),
  );
});

test('coordinate requests keep pickup separate and preserve via order', () => {
  const body = shoppingRequest('37,-122', '38,-121', ['37.5,-121.5']);
  assert.deepEqual(body.pickupWaypoint.taskTypes, ['PICKUP']);
  assert.deepEqual(
    body.waypointSpecs.map((x) => x.taskTypes[0]),
    ['VIA', 'DROP_OFF'],
  );
  assert.deepEqual(body.waypointSpecs[1].locationSpec.point, {
    latitude: 38,
    longitude: -121,
  });
  for (const invalid of ['91,0', '0,181', '1,', '1,2,3', 'NaN,0'])
    assert.throws(() => shoppingRequest(invalid, '0,0'));
});
