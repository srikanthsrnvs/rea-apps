import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { readCredentials } from '../src/credentials.mjs';

test('credentials can arrive privately through stdin without argv secrets or state writes', async () => {
  const value = { userId: 'synthetic-user', password: 'synthetic password with spaces' };
  assert.deepEqual(await readCredentials({ credentialsStdin: true }, Readable.from([JSON.stringify(value)])), value);
  assert.deepEqual(await readCredentials({ userId: value.userId, passwordStdin: true }, Readable.from([value.password + '\n'])), value);
  for (const options of [{}, { credentialsStdin: true, passwordStdin: true }, { credentialsStdin: true, userId: 'ambiguous' }]) {
    await assert.rejects(readCredentials(options, Readable.from(['{}'])), { code: 'INVALID_CREDENTIAL_INPUT' });
  }
  await assert.rejects(readCredentials({ credentialsStdin: true }, Readable.from(['x'.repeat(20_000)])), { code: 'INVALID_CREDENTIAL_INPUT' });
});
test('unsafe credential files and symlinks cannot supply a login password', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amex-input-'));
  const file = path.join(directory, 'credentials.json'), link = path.join(directory, 'linked.json');
  try {
    const credentials = { userId: 'synthetic', password: 'not-a-real-password' };
    await fs.writeFile(file, JSON.stringify(credentials), { mode: 0o600 });
    assert.deepEqual(await readCredentials({ credentialsFile: file }), credentials);
    await fs.symlink(file, link);
    await assert.rejects(readCredentials({ credentialsFile: link }), { code: 'INVALID_CREDENTIAL_INPUT' });
    await fs.chmod(file, 0o644);
    await assert.rejects(readCredentials({ credentialsFile: file }), { code: 'INVALID_CREDENTIAL_INPUT' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
