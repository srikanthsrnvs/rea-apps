import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'uber-cancel-test-'));
process.env.UBER_CLI_STATE_DIR = directory;
const { saveState } = await import('../src/state.mjs');
const { createContext } = await import('../src/protocol.mjs');
const { prepareCancellation, confirmCancellation } = await import(
  '../src/cancellation.mjs'
);
const context = createContext();
const originalFetch = globalThis.fetch;
test.after(async () => {
  globalThis.fetch = originalFetch;
  await fs.rm(directory, { recursive: true, force: true });
});
const tripId = 'df00bf9a-d252-42f4-9a7c-4e6aeaf79a3c';
test('cancellation previews before sending and blocks changed fees', async () => {
  await saveState('session', {
    context,
    accessToken: 'test',
    userUUID: 'rider',
    expiresAt: Date.now() + 3600000,
  });
  await saveState('integrity', {
    token: 'test',
    contextDeviceId: context.deviceId,
    expiresAt: Date.now() + 3600000,
  });
  let chargeFee = false;
  let cancels = 0;
  globalThis.fetch = async (url, options) => {
    const endpoint = new URL(url).pathname;
    if (endpoint.endsWith('cancellation-info')) {
      assert.deepEqual(JSON.parse(options.body), {
        reasonId: 'rider_changed_mind',
      });
      return Response.json({
        chargeFee,
        title: chargeFee ? 'Fee applies' : 'No fee',
      });
    }
    assert.ok(endpoint.endsWith('rider-cancel'));
    cancels++;
    assert.equal(JSON.parse(options.body).reason, 'rider_changed_mind');
    return Response.json({ clientStatus: { status: 'idle' } });
  };
  const first = await prepareCancellation({
    tripId,
    reason: 'rider_changed_mind',
  });
  assert.equal(cancels, 0);
  chargeFee = true;
  await assert.rejects(confirmCancellation(first.planId), /terms changed/);
  assert.equal(cancels, 0);
  const second = await prepareCancellation({
    tripId,
    reason: 'rider_changed_mind',
  });
  assert.equal(second.preview.chargeFee, true);
  assert.equal(
    (await confirmCancellation(second.planId)).operationId,
    second.operationId,
  );
  assert.equal(cancels, 1);
});
