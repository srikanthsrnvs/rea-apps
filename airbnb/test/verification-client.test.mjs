import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airbnb-verification-client-'));
process.env.AIRBNB_STATE_DIR = root;
const { browserVerificationStatus, takeBrowserVerification, removeBrowserVerification } = await import('../src/verification-client.mjs');
const publicKey = '12345678-ABCD-ABCD-ABCD-123456789ABC';
test.after(() => fs.rm(root, { recursive: true, force: true }));
async function fixture() {
  const record = { id: randomUUID(), directory: path.join(root, `verification-${randomUUID()}`), expiresAt: Date.now() + 60000 };
  await fs.mkdir(record.directory, { mode: 0o700 });
  const result = { id: record.id, status: 'completed', eventId: 'challenge-suppressed', publicKey, token: 'synthetic-offline-verification-token', receivedAt: new Date().toISOString() };
  await fs.writeFile(path.join(record.directory, 'verification-result.json'), JSON.stringify(result), { mode: 0o600 });
  return record;
}

test('local request validation cannot consume a genuine verification result', async () => {
  const record = await fixture();
  await assert.rejects(takeBrowserVerification(record, publicKey, () => { throw Error('Invalid local request'); }), /Invalid local request/);
  assert.equal((await browserVerificationStatus(record)).status, 'completed');
  let validated;
  const token = await takeBrowserVerification(record, publicKey, value => { validated = value; });
  assert.equal(token, validated);
  await assert.rejects(takeBrowserVerification(record, publicKey), { code: 'VERIFICATION_CONSUMED' });
  assert.equal((await browserVerificationStatus(record)).status, 'consumed');
});

test('mismatched, expired and incomplete browser proofs never pass as complete', async () => {
  const record = await fixture();
  await assert.rejects(takeBrowserVerification({ ...record, id: randomUUID() }, publicKey), { code: 'VERIFICATION_REQUIRED' });
  await assert.rejects(takeBrowserVerification(record, 'different-key'), { code: 'VERIFICATION_REQUIRED' });
  await assert.rejects(takeBrowserVerification({ ...record, expiresAt: Date.now() - 1 }, publicKey), { code: 'VERIFICATION_EXPIRED' });
  assert.equal((await browserVerificationStatus({ ...record, expiresAt: 1 })).status, 'expired');
  assert.equal((await browserVerificationStatus(record)).status, 'completed');
});

test('public status omits tokens and cleanup removes only the owning login directory', async () => {
  const record = await fixture();
  const status = JSON.stringify(await browserVerificationStatus(record));
  assert.equal(status.includes('synthetic'), false);
  assert.equal(status.includes(record.directory), false);
  await removeBrowserVerification(record);
  await assert.rejects(fs.stat(record.directory), { code: 'ENOENT' });
  const unrelated = path.join(root, 'unrelated');
  await fs.mkdir(unrelated);
  await removeBrowserVerification({ directory: unrelated });
  assert.equal((await fs.stat(unrelated)).isDirectory(), true);
});
