import test from 'node:test';
import assert from 'node:assert/strict';
import { clientHeaders } from '../src/client.mjs';
const device = { deviceId: 'synthetic-installation', instanceId: 'synthetic-instance' };
test('genuine partial JWT/cupcake are sent independently of gatekeeper and public metadata identifies the CLI', () => {
  const headers = clientHeaders({ device, session: { jsonWebToken: { rawToken: 'synthetic-jwt' }, cupcake: 'genuine-server-context' }, sequence: 3 });
  assert.equal(headers.authorization, 'AMAT synthetic-jwt');
  assert.equal(headers['x-axp-blueboxvalues'], 'genuine-server-context');
  assert.equal(headers['x-axp-gatekeeper'], undefined);
  assert.equal(headers['x-axp-request-sequence'], '3');
  assert.match(headers['user-agent'], /rea-amex/);
  assert.equal(clientHeaders({ device })['x-axp-blueboxvalues'], undefined);
});
test('server additional headers cannot rewrite transport framing or inject another header', () => {
  for (const entry of [{ header: 'Host', value: 'example.invalid' }, { header: 'x-context', value: 'first\r\nsecond' }, { header: 'content-length', value: '0' }]) {
    assert.throws(() => clientHeaders({ device, session: { additionalHeaders: [entry] } }), { code: 'UNSUPPORTED_SESSION_HEADER' });
  }
});
