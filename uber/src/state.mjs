import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { withKernelRequestLock } from './kernel-lock.mjs';

export const stateDirectory =
  process.env.UBER_CLI_STATE_DIR ||
  path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'uber-cli',
  );

export async function readState(name) {
  try {
    return JSON.parse(
      await fs.readFile(path.join(stateDirectory, `${name}.json`), 'utf8'),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveState(name, value) {
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDirectory, 0o700);
  const destination = path.join(stateDirectory, `${name}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function removeState(name) {
  await fs.rm(path.join(stateDirectory, `${name}.json`), { force: true });
}

// Local filesystem process mutex. Unique participant files avoid deleting a new
// owner's lock when several commands recover a crashed process simultaneously.
// All state reads and token-changing requests must happen inside this callback.
export async function withStateLock(
  operation,
  { directory = stateDirectory, timeoutMs = 30_000, pollIntervalMs = 25 } = {},
) {
  if (typeof operation !== 'function')
    throw new TypeError('Lock operation must be a function');
  // Set only by the Docker entrypoint, which holds flock for the whole process.
  if (process.env.UBER_CLI_KERNEL_LOCK === '1') return operation();
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs <= 0
  ) {
    throw new RangeError(
      'Lock timeout and poll interval must be positive finite numbers',
    );
  }
  if (process.env.UBER_CLI_KERNEL_LOCK_PER_REQUEST === '1')
    return withKernelRequestLock(operation, { directory, timeoutMs });
  const lockDirectory = path.join(directory, '.state-lock');
  await fs.mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(lockDirectory, 0o700);
  const id = `${process.pid}-${randomUUID()}`;
  const ownFile = path.join(lockDirectory, `${id}.json`);
  const participant = {
    version: 1,
    id,
    pid: process.pid,
    hostname: os.hostname(),
    ticket: 0,
  };
  const deadline = performance.now() + timeoutMs;

  async function publish() {
    const temporary = `${ownFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(participant), {
        flag: 'wx',
        mode: 0o600,
      });
      await fs.rename(temporary, ownFile);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async function participants() {
    const entries = await fs.readdir(lockDirectory);
    const result = [];
    for (const entry of entries.filter((name) => name.endsWith('.json'))) {
      const filename = path.join(lockDirectory, entry);
      let owner;
      try {
        owner = JSON.parse(await fs.readFile(filename, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (
        owner.version !== 1 ||
        entry !== `${owner.id}.json` ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0 ||
        !Number.isSafeInteger(owner.ticket) ||
        owner.ticket < 0 ||
        typeof owner.hostname !== 'string'
      ) {
        throw new Error(`Invalid state lock record: ${filename}`);
      }
      let alive = true;
      if (owner.hostname === participant.hostname) {
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') alive = false;
          else if (error.code !== 'EPERM') throw error;
        }
      }
      if (!alive) {
        // This unique filename is never reused by another acquisition.
        await fs.rm(filename, { force: true });
      } else result.push(owner);
    }
    return result;
  }

  try {
    // Ticket zero announces that this process is selecting its position.
    await publish();
    participant.ticket =
      1 + Math.max(0, ...(await participants()).map((owner) => owner.ticket));
    if (!Number.isSafeInteger(participant.ticket))
      throw new Error('State lock ticket overflow');
    await publish();
    for (;;) {
      const others = (await participants()).filter((owner) => owner.id !== id);
      const blocked = others.some(
        (owner) =>
          owner.ticket === 0 ||
          owner.ticket < participant.ticket ||
          (owner.ticket === participant.ticket && owner.id < id),
      );
      if (!blocked) {
        if (performance.now() >= deadline) break;
        return await operation();
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await delay(Math.min(pollIntervalMs, remaining));
    }
    const error = new Error(
      `Timed out waiting for the Uber state lock after ${timeoutMs} ms`,
    );
    error.code = 'UBER_STATE_LOCK_TIMEOUT';
    throw error;
  } finally {
    await fs.rm(ownFile, { force: true });
  }
}
