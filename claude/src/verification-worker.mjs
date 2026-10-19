import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createVerificationRelay } from './verification-relay.mjs';

async function writeRecord(directory, name, value) {
  const filename = path.join(directory, name), temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function runVerificationWorker(directory) {
  process.umask(0o077);
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('Private verification directory required');
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('Private verification directory required');
  const configPath = path.join(directory, 'verification-config.json'), configInfo = await fs.lstat(configPath);
  if (!configInfo.isFile() || configInfo.isSymbolicLink() || configInfo.size > 100_000 || (configInfo.mode & 0o077)) throw new TypeError('Verification config must be an owner-only regular file');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  if (typeof config.cloudflared !== 'string' || !path.isAbsolute(config.cloudflared) || /[\x00\r\n]/.test(config.cloudflared)) throw new TypeError('An absolute tunnel executable path is required');
  let tunnel, closing, published = false, logTail = '', deadline, completionTimer;
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const relay = await createVerificationRelay({ directory, publicKey: config.publicKey, dataExchangeBlob: config.dataExchangeBlob, ttlMs: config.ttlMs,
    async onResult() {
      try {
        if (config.loginId) {
          if (!/^[0-9a-f-]{36}$/i.test(config.loginId)) throw new TypeError('Invalid login ID');
          const { completeLogin } = await import('./auth.mjs');
          await completeLogin({ loginId: config.loginId, deferVerificationCleanup: true });
        }
      } catch (error) {
        await writeRecord(directory, 'verification-auth-error.json', { code: typeof error.code === 'string' ? error.code : 'LOGIN_STEP_FAILED' }).catch(() => {});
      } finally { completionTimer = setTimeout(() => void close(), 750); }
    },
    onStop() { return close(); },
  });
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      clearTimeout(deadline); clearTimeout(completionTimer);
      process.removeListener('SIGTERM', close); process.removeListener('SIGINT', close);
      if (tunnel?.pid && tunnel.exitCode === null && tunnel.signalCode === null) {
        // Only signal the child object created by this worker, never a saved PID.
        const exited = new Promise(resolve => tunnel.once('exit', resolve));
        tunnel.kill('SIGTERM');
        const killTimer = setTimeout(() => tunnel.kill('SIGKILL'), 1500); killTimer.unref();
        await exited; clearTimeout(killTimer);
      }
      await relay.close();
      await writeRecord(directory, 'verification-host.json', { id: relay.id, pid: process.pid, status: 'closed', expiresAt: relay.expiresAt });
      if(config.loginId){
        const {readState,stateDirectory}=await import('./state.mjs');
        const pending=await readState('pending-login');
        if(pending?.id!==config.loginId&&path.dirname(directory)===stateDirectory&&path.basename(directory)===`verification-${config.loginId}`)await fs.rm(directory,{recursive:true,force:true});
      }
    })().catch(async () => {
      process.exitCode = 1;
      await writeRecord(directory, 'verification-error.json', { id: relay.id, code: 'VERIFICATION_CLEANUP_FAILED' }).catch(() => {});
    }).finally(() => finish());
    return closing;
  }
  process.once('SIGTERM', close); process.once('SIGINT', close);
  try {
    const port = await relay.listen();
    await writeRecord(directory, 'verification-host.json', { id: relay.id, pid: process.pid, port, key: relay.key, expiresAt: relay.expiresAt });
    tunnel = spawn(config.cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const receive = chunk => {
      logTail = (logTail + chunk.toString('utf8')).slice(-16384);
      const origin = logTail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
      if (!origin || published || closing) return;
      published = true; clearTimeout(deadline);
      const output = { id: relay.id, pid: process.pid, status: 'ready', url: `${origin}/#key=${relay.key}`, expiresAt: relay.expiresAt };
      writeRecord(directory, 'verification-url.json', output).then(() => {
        if (!closing) process.stdout.write(`${JSON.stringify(output)}\n`);
      }).catch(() => void fail('STATE_WRITE_FAILED'));
    };
    const fail = async code => {
      process.exitCode = 1;
      await writeRecord(directory, 'verification-error.json', { id: relay.id, code, expiresAt: relay.expiresAt }).catch(() => {});
      await close();
    };
    tunnel.stdout.on('data', receive); tunnel.stderr.on('data', receive);
    tunnel.once('error', () => void fail('TUNNEL_START_FAILED'));
    tunnel.once('exit', () => { if (!closing) void fail('TUNNEL_EXITED'); });
    deadline = setTimeout(() => void fail('TUNNEL_START_TIMEOUT'), Math.min(45_000, Math.max(100, relay.expiresAt - Date.now())));
    const expiry = setTimeout(() => void close(), Math.max(0, relay.expiresAt - Date.now()));
    await finished; clearTimeout(expiry);
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runVerificationWorker(process.argv[2]).catch(async () => {
    // Startup diagnostics never include configuration, challenge tokens or logs.
    const directory = process.argv[2];
    try {
      if (typeof directory === 'string' && path.isAbsolute(directory)) {
        const info = await fs.lstat(directory);
        if (info.isDirectory() && !info.isSymbolicLink()) {
          await writeRecord(directory, 'verification-error.json', { code: 'VERIFICATION_START_FAILED' });
        }
      }
    } catch {}
    process.stderr.write('Verification worker could not start.\n'); process.exitCode = 1;
  });
}
