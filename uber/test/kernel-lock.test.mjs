import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withKernelRequestLock } from '../src/kernel-lock.mjs';

test('Linux viewer transactions share flock and release after errors without holding the service lifetime', { skip: process.platform !== 'linux' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'uber-kernel-map-test-'));
  try {
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    let firstEntered;
    const entered = new Promise(resolve => { firstEntered = resolve; });
    const holder = withKernelRequestLock(async () => { firstEntered(); await blocked; }, { directory });
    await entered;
    await assert.rejects(withKernelRequestLock(() => assert.fail('Must not enter while locked'), { directory, timeoutMs: 30 }), { code: 'UBER_STATE_LOCK_TIMEOUT' });
    release(); await holder;
    await assert.rejects(withKernelRequestLock(async () => { throw new Error('fixture failure'); }, { directory }), /fixture failure/);
    assert.equal(await withKernelRequestLock(async () => 'released', { directory }), 'released');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
