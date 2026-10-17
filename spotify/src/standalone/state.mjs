import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const stateDirectory = process.env.SPOTIFY_STATE_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "spotify-cli");
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export async function readState(name) {
  try { return JSON.parse(await fs.readFile(path.join(stateDirectory, `${name}.json`), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export async function saveState(name, record) {
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDirectory, 0o700);
  const destination = path.join(stateDirectory, `${name}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }); }
}
export async function removeState(name) { await fs.rm(path.join(stateDirectory, `${name}.json`), { force: true }); }

// Atomic, unique lock participants avoid deleting a replacement owner's lock.
// All standalone commands share this bakery lock, including token renewal.
export async function withStateLock(job, { timeoutMs = 60000 } = {}) {
  const directory = path.join(stateDirectory, ".locks");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDirectory, 0o700); await fs.chmod(directory, 0o700);
  const id = `${process.pid}-${randomUUID()}`, filename = path.join(directory, `${id}.json`);
  const own = { id, pid: process.pid, host: os.hostname(), ticket: 0 };
  const write = async () => {
    const temporary = filename + ".tmp";
    await fs.writeFile(temporary, JSON.stringify(own), { mode: 0o600 }); await fs.rename(temporary, filename);
  };
  const participants = async () => {
    const entries = [];
    for (const f of await fs.readdir(directory)) {
      if (!f.endsWith(".json")) continue;
      let record;
      try { record = JSON.parse(await fs.readFile(path.join(directory, f), "utf8")); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!Number.isSafeInteger(record.pid) || record.pid < 1 || !Number.isSafeInteger(record.ticket) || record.ticket < 0 || f !== record.id + ".json")
        fail("STATE_LOCK_INVALID", "The private Spotify state lock is invalid.");
      if (record.host === own.host) {
        try { process.kill(record.pid, 0); }
        catch (error) {
          if (error.code === "ESRCH") { await fs.rm(path.join(directory, f), { force: true }); continue; }
          if (error.code !== "EPERM") throw error;
        }
      }
      entries.push(record);
    }
    return entries;
  };
  try {
    await write();
    own.ticket = 1 + Math.max(0, ...(await participants()).map(r => r.ticket)); await write();
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const earlier = (await participants()).some(r => r.id !== id && (r.ticket === 0 || r.ticket < own.ticket || (r.ticket === own.ticket && r.id < id)));
      if (!earlier) return await job();
      if (Date.now() >= deadline) fail("STATE_LOCK_TIMEOUT", "Another Spotify command is still running. Inspect playback before retrying a mutation.");
      await delay(25);
    }
  } finally { await fs.rm(filename, { force: true }); await fs.rm(filename + ".tmp", { force: true }); }
}
