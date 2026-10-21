import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readState, saveState, removeState, withStateLock } from './state.mjs';
import { QuilttError } from './errors.mjs';
import { requireConfig, inspectConnector } from './config.mjs';

const active = value => value && ['starting', 'waiting', 'validating'].includes(value.status) && value.expiresAt > Date.now();
export function loginResult(value) {
  if (!value) return { status: 'none' };
  const result = { loginId: value.loginId, status: value.status, expiresAt: new Date(value.expiresAt).toISOString() };
  if (active(value) && value.approvalUrl) result.approvalUrl = value.approvalUrl;
  if (active(value)) { result.retryAfterSeconds = 1; if (value.publicOrigin) result.connectorSetup = { redirectUrl: `${value.publicOrigin}/callback`, sendToken: true, sendMetadata: true, message: 'Set this Exit Redirect URL on the Sandbox Connector before opening approvalUrl. Use a stable --public-url to keep this setting across logins.' }; }
  if (value.error) result.error = value.error;
  return result;
}

export async function findCloudflared(explicit) {
  if (explicit) {
    try { await fs.access(explicit, 1); if (!(await fs.stat(explicit)).isFile()) throw new Error(); return await fs.realpath(explicit); }
    catch { throw new QuilttError('TUNNEL_UNAVAILABLE', 'The requested cloudflared path is not an executable file.'); }
  }
  const paths = [fileURLToPath(new URL('../.runtime/cloudflared', import.meta.url)), process.env.QUILTT_CLOUDFLARED, process.env.QUILTT_CLI_CLOUDFLARED, ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'cloudflared')), '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared', `${process.env.HOME}/.local/bin/cloudflared`].filter(Boolean);
  for (const candidate of paths) { try { await fs.access(candidate, 1); if ((await fs.stat(candidate)).isFile()) return await fs.realpath(candidate); } catch {} }
  throw new QuilttError('TUNNEL_UNAVAILABLE', 'Install cloudflared or supply an HTTPS --public-url reverse proxy for remote login.');
}

export async function startLogin({ timeoutSeconds = 600, replace = false, publicUrl, port = 0, cloudflaredPath, connect = false } = {}, { spawnImpl = spawn, pause = delay } = {}) {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3600) throw new QuilttError('INVALID_ARGUMENT', 'Login timeout must be 30–3600 seconds.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new QuilttError('INVALID_ARGUMENT', 'Port must be 0–65535.');
  let publicOrigin;
  if (publicUrl) {
    let parsed; try { parsed = new URL(publicUrl); } catch { throw new QuilttError('INVALID_ARGUMENT', 'Public URL must be an HTTPS origin.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || !port) throw new QuilttError('INVALID_ARGUMENT', 'Public URL must be an HTTPS origin, with a fixed loopback port.');
    publicOrigin = parsed.origin;
  }
  const config = await requireConfig();
  const environment = await inspectConnector(config.connectorId);
  if (environment.id !== config.environment.id) throw new QuilttError('ENVIRONMENT_CHANGED', 'The Connector no longer matches the configured Sandbox.');
  const session = await withStateLock(() => readState('session'));
  if (connect && session?.validated !== true) throw new QuilttError('AUTH_REQUIRED', 'Run quiltt login before linking another bank.');
  const usable = session?.validated === true && session.environmentId === config.environment.id
    && (config.secret || Date.parse(session.expiresAt) > Date.now());
  if (usable && !replace && !connect) return { status: 'authenticated', profile: session.profile, next: 'Use quiltt connect to link another bank, or login --replace to switch Profile.' };
  const existing = await withStateLock(() => readState('login'));
  if (!replace && active(existing)) return loginResult(existing);
  const tunnelPath = publicOrigin ? null : await findCloudflared(cloudflaredPath);
  let selected, launch = false;
  await withStateLock(async () => {
    const latest = await readState('login');
    if (!replace && active(latest)) { selected = latest; return; }
    selected = { version: 1, loginId: randomBytes(24).toString('base64url'), secret: randomBytes(32).toString('base64url'), status: 'starting', startedAt: Date.now(), expiresAt: Date.now() + timeoutSeconds * 1000, publicOrigin, port, tunnelPath, connectorId: config.connectorId, environmentId: config.environment.id, expectedProfileId: replace ? null : session?.profile?.id ?? null };
    await saveState('login', selected); launch = true;
  });
  if (!launch) return loginResult(selected);
  try {
    const child = spawnImpl(process.execPath, [fileURLToPath(new URL('./auth-worker.mjs', import.meta.url)), selected.loginId], { detached: true, stdio: 'ignore', env: process.env });
    child.on('error', async () => { await withStateLock(async () => { const current = await readState('login'); if (current?.loginId === selected.loginId && current.status === 'starting') await saveState('login', { ...current, status: 'failed', secret: undefined, approvalUrl: undefined, error: { code: 'LOGIN_WORKER_FAILED', message: 'Unable to start login worker.' } }); }); });
    child.unref();
  } catch {
    await withStateLock(async () => { const current = await readState('login'); if (current?.loginId === selected.loginId) await saveState('login', { ...current, status: 'failed', secret: undefined, approvalUrl: undefined, error: { code: 'LOGIN_WORKER_FAILED', message: 'Unable to start login worker.' } }); });
  }
  const deadline = Date.now() + 35000;
  for (;;) {
    const current = await withStateLock(() => readState('login'));
    if (current?.loginId !== selected.loginId || current.status !== 'starting' || Date.now() >= deadline) return loginResult(current);
    await pause(200);
  }
}

export async function pollLogin() {
  return withStateLock(async () => {
    let current = await readState('login');
    if (current && ['starting', 'waiting', 'validating'].includes(current.status) && current.expiresAt <= Date.now()) { current = { ...current, status: 'expired', secret: undefined, approvalUrl: undefined }; await saveState('login', current); }
    return loginResult(current);
  });
}
export async function waitLogin({ timeoutSeconds = 600 } = {}, { pause = delay } = {}) {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new QuilttError('INVALID_ARGUMENT', 'Wait timeout must be 1–3600 seconds.');
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) { const value = await pollLogin(); if (!['starting', 'waiting', 'validating'].includes(value.status) || Date.now() >= deadline) return value; await pause(1000); }
}
export async function cancelLogin() {
  return withStateLock(async () => { const current = await readState('login'); if (current && ['starting', 'waiting', 'validating'].includes(current.status)) { const canceled = { ...current, status: 'canceled', secret: undefined, approvalUrl: undefined }; await saveState('login', canceled); return loginResult(canceled); } return loginResult(current); });
}
export async function authStatus() {
  return withStateLock(async () => {
    let current = await readState('login');
    if (current && ['starting', 'waiting', 'validating'].includes(current.status) && current.expiresAt <= Date.now()) { current = { ...current, status: 'expired', secret: undefined, approvalUrl: undefined }; await saveState('login', current); }
    const session = await readState('session'), config = await readState('config');
    const profileSaved = session?.validated === true;
    return { authenticated: profileSaved && session.environmentId === config?.environment?.id && Boolean(config?.secret || Date.parse(session.expiresAt) > Date.now()),
      profileSaved, persistentServerAccess: Boolean(config?.secret), sessionExpiresAt: session?.expiresAt ?? null,
      profile: session?.profile ?? null, validatedAt: session?.validatedAt ?? null, login: loginResult(current) };
  });
}
export async function logout() {
  return withStateLock(async () => {
    const current = await readState('login');
    if (current && ['starting', 'waiting', 'validating'].includes(current.status)) await saveState('login', { ...current, status: 'canceled', secret: undefined, approvalUrl: undefined });
    await removeState('session'); return { authenticated: false, loggedOut: true };
  });
}
