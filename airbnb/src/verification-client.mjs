import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { stateDirectory } from './state.mjs';
import { AirbnbError } from './errors.mjs';

const workerPath = fileURLToPath(new URL('./verification-worker.mjs', import.meta.url));
const executable = async file => { try { await fs.access(file, fs.constants.X_OK); return file; } catch { return null; } };
async function readJSON(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function directoryFor(loginId) {
  if (!/^[0-9a-f-]{36}$/.test(loginId)) throw new AirbnbError('INVALID_LOGIN_ID', 'Invalid login identifier.');
  return path.join(stateDirectory, `verification-${loginId}`);
}
export async function findVerificationTunnel() {
  const configured = process.env.AIRBNB_CLOUDFLARED;
  if (configured) {
    if (!path.isAbsolute(configured) || !await executable(configured)) throw new AirbnbError('VERIFICATION_TUNNEL_UNAVAILABLE', 'AIRBNB_CLOUDFLARED must name an executable absolute path.');
    return configured;
  }
  const bundled = fileURLToPath(new URL('../.runtime/cloudflared', import.meta.url));
  const choices = [bundled, ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, 'cloudflared'))];
  for (const file of choices) if (await executable(file)) return file;
  throw new AirbnbError('VERIFICATION_TUNNEL_UNAVAILABLE', 'Install cloudflared with the Linux setup script or set AIRBNB_CLOUDFLARED. It runs only during browser verification.');
}
export async function startBrowserVerification(loginId, widget, cloudflared, { ttlMs = 15 * 60000 } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 100 || ttlMs > 15 * 60000) throw new AirbnbError('VERIFICATION_EXPIRED', 'The pending login has expired or has an invalid lifetime.');
  const directory = directoryFor(loginId);
  const previous = await readJSON(path.join(directory, 'verification-url.json'));
  const [host, result, failure] = await Promise.all(['verification-host.json', 'verification-result.json', 'verification-error.json'].map(file => readJSON(path.join(directory, file))));
  if (previous && previous.expiresAt > Date.now() && !failure && (host?.status !== 'closed' || result?.status === 'completed')) return { directory, id: previous.id, expiresAt: previous.expiresAt };
  if (host?.status === 'closed') await fs.rm(directory, { recursive: true, force: true });
  else if (await readJSON(path.join(directory, 'verification-config.json'))) throw new AirbnbError('VERIFICATION_START_PENDING', 'A verification worker is already starting or has an uncertain outcome. Cancel this login before starting another.');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  await fs.writeFile(path.join(directory, 'verification-config.json'), JSON.stringify({ publicKey: widget.publicKey, dataExchangeBlob: widget.dataExchangeBlob ?? '', cloudflared, ttlMs }), { mode: 0o600, flag: 'wx' });
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [workerPath, directory], { detached: true, stdio: 'ignore' });
  let launchError;
  child.once('error', error => { launchError = error; });
  child.unref();
  for (let elapsed = 0; elapsed < 20000; elapsed += 200) {
    const ready = await readJSON(path.join(directory, 'verification-url.json'));
    if (ready) return { directory, id: ready.id, expiresAt: ready.expiresAt };
    if (launchError || await readJSON(path.join(directory, 'verification-error.json'))) break;
    await delay(200);
  }
  await stopBrowserVerification({ directory });
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, delay(3000)]);
  }
  if (child.exitCode !== null || child.signalCode !== null || launchError) await fs.rm(directory, { recursive: true, force: true });
  throw new AirbnbError('VERIFICATION_LINK_UNAVAILABLE', 'The verification link could not start. Inspect auth status; no code verification was submitted.');
}
export async function browserVerificationStatus(record) {
  if (!record) return null;
  const directory = record.directory;
  const [url, result, error] = await Promise.all(['verification-url.json', 'verification-result.json', 'verification-error.json'].map(file => readJSON(path.join(directory, file))));
  if (Date.now() >= record.expiresAt) return { status: 'expired', expiresAt: new Date(record.expiresAt).toISOString() };
  if (result?.id === record.id && result.status === 'completed') return { status: result.consumedAt ? 'consumed' : 'completed', expiresAt: new Date(record.expiresAt).toISOString() };
  if (error || result?.status === 'failed') return { status: 'failed', expiresAt: new Date(record.expiresAt).toISOString() };
  return { status: 'waiting', url: url?.id === record.id ? url.url : undefined, expiresAt: new Date(record.expiresAt).toISOString() };
}
export async function takeBrowserVerification(record, publicKey, validate) {
  const result = record && await readJSON(path.join(record.directory, 'verification-result.json'));
  if (!record || Date.now() >= record.expiresAt) throw new AirbnbError('VERIFICATION_EXPIRED', 'Browser verification expired. Cancel this login and start again.');
  if (!result || result.id !== record.id || result.status !== 'completed' || !['challenge-complete', 'challenge-suppressed'].includes(result.eventId) || result.publicKey !== publicKey || typeof result.token !== 'string') throw new AirbnbError('VERIFICATION_REQUIRED', 'Complete the verification URL in your own browser before continuing phone login.');
  if (result.consumedAt) throw new AirbnbError('VERIFICATION_CONSUMED', 'This verification was already submitted. It was not replayed.');
  if (validate) validate(result.token);
  result.consumedAt = new Date().toISOString();
  const file = path.join(record.directory, 'verification-result.json');
  await fs.writeFile(`${file}.tmp`, JSON.stringify(result), { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
  return result.token;
}
export async function stopBrowserVerification(record) {
  if (!record) return;
  const host = await readJSON(path.join(record.directory, 'verification-host.json'));
  if (!host || record.id && host.id !== record.id || !Number.isSafeInteger(host.port) || host.port < 1 || host.port > 65535 || typeof host.key !== 'string') return;
  try { await fetch(`http://127.0.0.1:${host.port}/stop`, { method: 'POST', headers: { authorization: `Bearer ${host.key}` }, signal: AbortSignal.timeout(1500) }); } catch {}
}
export async function removeBrowserVerification(record) {
  if (!record) return;
  await stopBrowserVerification(record);
  // The worker publishes closed only after its owned tunnel has exited. Avoid
  // deleting files while that worker is still publishing its final metadata.
  for (let elapsed = 0; elapsed < 4000; elapsed += 100) {
    const host = await readJSON(path.join(record.directory, 'verification-host.json'));
    if (!host || host.status === 'closed') break;
    if (elapsed >= 3900) return;
    await delay(100);
  }
  // Only an exact child directory belonging to this login can be removed.
  if (path.dirname(record.directory) === stateDirectory && /^verification-[0-9a-f-]{36}$/.test(path.basename(record.directory))) await fs.rm(record.directory, { recursive: true, force: true });
}
