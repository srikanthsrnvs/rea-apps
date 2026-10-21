import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airbnb-context-'));
process.env.AIRBNB_STATE_DIR = directory;
const { createClient, clientHeaders } = await import('../src/client.mjs');
const { readState, saveState, withStateLock } = await import('../src/state.mjs');
const { captureResponseContext, readRequestContext } = await import('../src/request-context.mjs');
test('server context survives an error and is reused without replaying the failed request', async () => {
  try {
    await saveState('request-context', { everestDeviceId: 'registered-test-device', everestExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    let calls = 0;
    const client = await createClient({ anonymous: true, fetchImpl: async (_url, options) => {
      calls++;
      if (calls === 1) return new Response('{}', { status: 420, headers: { 'X-Airbnb-AAJ': 'server-aaj', 'X-Airbnb-Set-Native-Session-ID': 'server-session' } });
      assert.equal(options.headers['x-airbnb-aaj'], 'server-aaj');
      assert.equal(options.headers['x-airbnb-native-session-id'], 'server-session');
      return new Response('{}');
    } });
    await assert.rejects(withStateLock(() => client.request({ path: 'phone_one_time_passwords', method: 'POST', body: {} })), { code: 'AIRBNB_HTTP_ERROR' });
    assert.equal(calls, 1);
    await client.request({ path: 'airlocks/-123' });
    assert.equal(calls, 2);
    assert.equal((await readState('request-context')).nativeSessionId, 'server-session');
    assert.equal((await fs.stat(path.join(directory, 'request-context.json'))).mode & 0o777, 0o600);
    await captureResponseContext({ headers: { 'X-Airbnb-AAJ': 'bad\r\nvalue' } });
    assert.equal((await readRequestContext()).aaj, 'server-aaj');
    const prior = { aaj: 'prior-token', aajAcquiredAt: 100 };
    assert.equal(clientHeaders({ session: prior, context: { aaj: 'rotated', aajAcquiredAt: 200 } })['x-airbnb-aaj'], 'rotated');
    assert.equal(clientHeaders({ session: { aaj: 'new-login', aajAcquiredAt: 300 }, context: { aaj: 'anonymous', aajAcquiredAt: 200 } })['x-airbnb-aaj'], 'new-login');
    assert.equal(clientHeaders({ session: prior, context: { aaj: '', aajAcquiredAt: 200 } })['x-airbnb-aaj'], undefined);
    await saveState('request-context', { aaj: 'server-aaj', nativeSessionId: 'expired', nativeSessionAcquiredAt: Date.now() - 63_115_200_001 });
    assert.equal((await readRequestContext()).nativeSessionId, undefined);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
