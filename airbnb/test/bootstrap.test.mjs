import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airbnb-bootstrap-'));
process.env.AIRBNB_STATE_DIR = directory;
const { createClient } = await import('../src/client.mjs');
const { readState, saveState } = await import('../src/state.mjs');
const { parseDeviceRegistration } = await import('../src/bootstrap.mjs');
const assignment = () => ({ device_type: 'ANDROID', device_assignment_type: 'STRICTLY_NECESSARY', device_id: 'genuine-test-assignment', expire_at_epoch_second: Math.floor(Date.now() / 1000) + 3600 });
test('one server-issued assignment is persisted and reused across CLI clients, including after HTTP420', async () => {
  try {
    let registrations = 0, protectedRequests = 0;
    const fetchImpl = async (url, options) => {
      if (url.pathname === '/v2/client_configs') {
        registrations++;
        assert.deepEqual(JSON.parse(options.body), { configs: [], trebuchet_keys: [], deviceAssignmentsToRequest: [{ deviceAssignmentType: 'STRICTLY_NECESSARY', deviceType: 'ANDROID' }] });
        return Response.json({ device_assignments: [assignment()] });
      }
      protectedRequests++;
      assert.equal(options.headers['x-airbnb-everest-device-id'], 'genuine-test-assignment');
      assert.equal(options.headers['x-airbnb-supports-airlock-v2'], 'true');
      // Ordinary response cookies/headers must not replace the native assignment.
      return Response.json({}, { status: 420, headers: { 'x-airbnb-everest-device-id': 'different-web-cookie-value' } });
    };
    for (let i = 0; i < 2; i++) {
      const client = await createClient({ anonymous: true, fetchImpl });
      await assert.rejects(client.request({ path: 'phone_one_time_passwords', method: 'POST', body: {} }), { code: 'AIRBNB_HTTP_ERROR' });
    }
    assert.equal(registrations, 1); assert.equal(protectedRequests, 2);
    assert.equal((await readState('request-context')).everestDeviceId, 'genuine-test-assignment');
    // Expiration is an absolute epoch second, not a duration.
    await saveState('request-context', { everestDeviceId: 'expired', everestExpiresAt: Math.floor(Date.now() / 1000) - 1 });
    await (await createClient({ anonymous: true, fetchImpl })).response({ path: 'airlocks/-123' });
    assert.equal(registrations, 2);
    await saveState('request-context', {});
    let failedCalls = 0;
    await assert.rejects(createClient({ anonymous: true, fetchImpl: async url => {
      failedCalls++; assert.equal(url.pathname, '/v2/client_configs');
      return Response.json({ device_assignments: [] });
    } }), { code: 'DEVICE_REGISTRATION_FAILED' });
    assert.equal(failedCalls, 1);
    assert.throws(() => parseDeviceRegistration({ device_assignments: [{ ...assignment(), device_type: 'WEB' }] }), { code: 'DEVICE_REGISTRATION_FAILED' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
