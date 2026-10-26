import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ChartsError } from './errors.mjs';
import { readPrivateText } from './private-files.mjs';

export const defaultStateDirectory = () => process.env.CHARTS_STATE_DIR || path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'charts-cli');
const validCookie = value => typeof value === 'string' && /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,8192}$/u.test(value);

export function createSessionStore(directory = defaultStateDirectory()) {
  const recordPath = name => {
    if (!/^[a-z-]{1,40}$/u.test(name)) throw new ChartsError('STATE_ERROR', 'Invalid state record name.');
    return path.join(directory, `${name}.json`);
  };
  const filename = recordPath('session');
  async function checkDirectory(create = false) {
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const info = await fs.lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ChartsError('STATE_ERROR', 'Charts state must be a real directory, not a symlink.');
      if (create) await fs.chmod(directory, 0o700);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function read(name) {
    await checkDirectory();
    try {
      return JSON.parse(await readPrivateText(recordPath(name), 32768, { repairPermissions: true }));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new ChartsError('STATE_ERROR', 'The private Charts state record could not be read safely.');
    }
  }
  async function write(name, value) {
    await checkDirectory(true);
    const temporary = path.join(directory, `.record-${randomUUID()}.tmp`);
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); } finally { await file.close(); }
      await fs.rename(temporary, recordPath(name));
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async function removeRecord(name) { await checkDirectory(); await fs.rm(recordPath(name), { force: true }); }
  // Same participant-ticket lock used by the native account CLIs. Unique
  // participant files avoid deleting a new owner's lock during crash recovery.
  async function lock(operation, { signal } = {}) {
    signal?.throwIfAborted();
    await checkDirectory(true);
    const lockDirectory = path.join(directory, '.state-lock');
    await fs.mkdir(lockDirectory, { recursive: true, mode: 0o700 });
    const lockInfo = await fs.lstat(lockDirectory);
    if (!lockInfo.isDirectory() || lockInfo.isSymbolicLink()) throw new ChartsError('STATE_ERROR', 'Charts lock state must be a real directory.');
    const id = `${process.pid}-${randomUUID()}`, ownFile = path.join(lockDirectory, `${id}.json`);
    const owner = { id, pid: process.pid, hostname: os.hostname(), ticket: 0 };
    const publish = async () => {
      const temporary = `${ownFile}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify(owner), { mode: 0o600 }); await fs.rename(temporary, ownFile); }
      finally { await fs.rm(temporary, { force: true }); }
    };
    const participants = async () => {
      const records = [];
      for (const entry of (await fs.readdir(lockDirectory)).filter(name => name.endsWith('.json'))) {
        let other;
        try { other = JSON.parse(await readPrivateText(path.join(lockDirectory, entry), 1024, { repairPermissions: true })); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!other || entry !== `${other.id}.json` || !Number.isSafeInteger(other.pid) || other.pid < 1
          || !Number.isSafeInteger(other.ticket) || other.ticket < 0 || typeof other.hostname !== 'string') throw new ChartsError('STATE_ERROR', 'Invalid Charts state lock.');
        let alive = true;
        if (other.hostname === owner.hostname) {
          try { process.kill(other.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else if (error.code !== 'EPERM') throw error; }
        }
        if (alive) records.push(other); else await fs.rm(path.join(lockDirectory, entry), { force: true });
      }
      return records;
    };
    const deadline = performance.now() + 30000;
    try {
      await publish(); owner.ticket = 1 + Math.max(0, ...(await participants()).map(other => other.ticket));
      await publish();
      while (performance.now() < deadline) {
        signal?.throwIfAborted();
        const waiting = (await participants()).some(other => other.id !== id && (other.ticket === 0 || other.ticket < owner.ticket || (other.ticket === owner.ticket && other.id < id)));
        if (!waiting) { signal?.throwIfAborted(); return await operation(); }
        await delay(25);
      }
      throw new ChartsError('STATE_BUSY', 'Another Charts command holds the state lock.');
    } finally { await fs.rm(ownFile, { force: true }); }
  }
  return {
    read, write, removeRecord, lock,
    async load() {
      await checkDirectory();
      try {
        const data = JSON.parse(await readPrivateText(filename, 32768, { repairPermissions: true }));
        if (data.version !== 1 || !validCookie(data.credentials?.session)
          || (data.credentials.signature !== undefined && !validCookie(data.credentials.signature))
          || !Number.isSafeInteger(data.account?.id) || data.account.id <= 0 || typeof data.account.username !== 'string') {
          throw new ChartsError('STATE_ERROR', 'The saved Charts session is invalid. Run charts login --replace.');
        }
        return data;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error instanceof ChartsError) throw error;
        throw new ChartsError('STATE_ERROR', 'The Charts session could not be read safely.');
      }
    },
    async save(data, { replace = false } = {}) {
      await checkDirectory(true);
      const temporary = path.join(directory, `.session-${randomUUID()}.tmp`);
      try {
        const file = await fs.open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(data) + '\n'); await file.sync(); } finally { await file.close(); }
        // Exclusive link makes two simultaneous non-replacing logins safe.
        if (replace) await fs.rename(temporary, filename);
        else await fs.link(temporary, filename);
      } catch (error) {
        if (error.code === 'EEXIST') throw new ChartsError('SESSION_EXISTS', 'A Charts session is already saved. Use login --replace to replace it.');
        throw error;
      } finally { await fs.rm(temporary, { force: true }); }
    },
    async remove() { await checkDirectory(); await fs.rm(filename, { force: true }); },
  };
}

export function sessionStatus(session) {
  return { authenticated: Boolean(session), validated: false,
    account: session ? { id: session.account.id, username: session.account.username } : null,
    savedAt: session?.savedAt ?? null, cookieExpiresAt: session?.cookieExpiresAt ?? null,
    expired: session?.cookieExpiresAt ? Date.parse(session.cookieExpiresAt) <= Date.now() : null };
}

export { validCookie };
