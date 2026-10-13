import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const bin = new URL('../bin/resy', import.meta.url);

test('model catalog is available without credentials, browser, tunnel or a network request', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'resy-catalog-'));
  try {
    const result = spawnSync(process.execPath, [bin.pathname, 'tools'], { env: { ...process.env, RESY_CLI_STATE_DIR: dir }, encoding: 'utf8' });
    assert.equal(result.status, 0);
    const catalog = JSON.parse(result.stdout).tools;
    for (const name of ['login', 'search', 'availability', 'calendar', 'details', 'payments', 'reservations', 'book', 'cancel', 'operation']) assert.ok(catalog.some(item => item.command === name));
    assert.deepEqual(catalog.find(item => item.command === 'search').inputSchema.required, ['query', 'near', 'date']);
    assert.match(catalog.find(item => item.command === 'book').description, /user approval/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid flags and unprepared booking confirmations fail before network access', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'resy-args-'));
  try {
    for (const args of [
      ['unknown'], ['me', '--query', 'x'], ['search', '--query', 'x'],
      ['search', '--query', 'x', '--near', '999,999', '--date', '2026-10-12'],
      ['search', '--query', 'x', '--near', '34,-118', '--date', '2026-10-12', '--page', '0'],
      ['me', '--pretty', '--pretty'], ['book', '--confirm'], ['book', '--plan-id', '../secret', '--confirm'],
      ['cancel', '--reservation-token', 'example', '--confirm'], ['book', '--slot-token', 'example'],
      ['book', '--plan-id', '00000000-0000-4000-8000-000000000000', '--confirm', '--date', '2026-10-12'],
    ]) {
      const result = spawnSync(process.execPath, [bin.pathname, ...args], { env: { ...process.env, RESY_CLI_STATE_DIR: dir }, encoding: 'utf8' });
      assert.equal(result.status, 1, args.join(' '));
      assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENT', args.join(' '));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
