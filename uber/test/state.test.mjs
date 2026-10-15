import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { withStateLock } from '../src/state.mjs';

const moduleURL = new URL('../src/state.mjs', import.meta.url).href;

async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'uber-state-test-'),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function worker(script, directory) {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', script, directory],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const finished = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(stderr || `Worker exited ${code}`)),
    );
  });
  return { child, finished };
}

test('processes serialize read-modify-write transactions', async (t) => {
  const directory = await fixture(t);
  const counter = path.join(directory, 'counter');
  await fs.writeFile(counter, '0');
  const script = `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { setTimeout } from 'node:timers/promises';
    import { withStateLock } from ${JSON.stringify(moduleURL)};
    const directory = process.argv[1];
    for (let i = 0; i < 8; i++) await withStateLock(async () => {
      const file = path.join(directory, 'counter');
      const value = Number(await fs.readFile(file, 'utf8'));
      await setTimeout(3);
      await fs.writeFile(file, String(value + 1));
    }, { directory, pollIntervalMs: 2 });
  `;
  await Promise.all(
    Array.from({ length: 4 }, () => worker(script, directory).finished),
  );
  assert.equal(await fs.readFile(counter, 'utf8'), '32');
  assert.deepEqual(await fs.readdir(path.join(directory, '.state-lock')), []);
  assert.equal(
    (await fs.stat(path.join(directory, '.state-lock'))).mode & 0o777,
    0o700,
  );
});

test('recovers a process that died while holding the lock', async (t) => {
  const directory = await fixture(t);
  const { child, finished } = worker(
    `
    import { withStateLock } from ${JSON.stringify(moduleURL)};
    await withStateLock(async () => process.exit(0), { directory: process.argv[1] });
  `,
    directory,
  );
  await finished;
  assert.equal(
    (await fs.readdir(path.join(directory, '.state-lock'))).length,
    1,
  );
  await Promise.all(
    Array.from({ length: 3 }, () =>
      withStateLock(async () => 1, {
        directory,
        pollIntervalMs: 2,
      }),
    ),
  );
  assert.deepEqual(await fs.readdir(path.join(directory, '.state-lock')), []);
  assert.equal(child.exitCode, 0);
});

test('times out without removing a live owner and releases on callback errors', async (t) => {
  const directory = await fixture(t);
  const { child, finished } = worker(
    `
    import { withStateLock } from ${JSON.stringify(moduleURL)};
    await withStateLock(async () => {
      process.send('locked');
      await new Promise(resolve => process.once('message', resolve));
    }, { directory: process.argv[1] });
    process.disconnect();
  `,
    directory,
  );
  try {
    await once(child, 'message');
    await assert.rejects(
      withStateLock(() => assert.fail('must not acquire'), {
        directory,
        timeoutMs: 30,
        pollIntervalMs: 2,
      }),
      { code: 'UBER_STATE_LOCK_TIMEOUT' },
    );
    assert.equal(
      (await fs.readdir(path.join(directory, '.state-lock'))).length,
      1,
    );
  } finally {
    child.send('release');
    await finished;
  }
  await assert.rejects(
    withStateLock(
      () => {
        throw new Error('callback failed');
      },
      { directory },
    ),
    /callback failed/,
  );
  assert.equal(await withStateLock(() => 42, { directory }), 42);
  assert.deepEqual(await fs.readdir(path.join(directory, '.state-lock')), []);
});
