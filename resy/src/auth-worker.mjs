import http from 'node:http';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readState, saveState, withStateLock } from './state.mjs';
import { ResyClient, checkToken } from './http.mjs';
import { loginPage } from './login-page.mjs';

function sameSecret(left, right) { return typeof left === 'string' && typeof right === 'string' && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right)); }
function send(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); }
async function body(request) {
  let text = '', bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 20000) throw new Error('Body too large'); text += chunk.toString(); }
  return JSON.parse(text);
}

export function createLoginServer({ loginId, origin, read = readState, save = saveState, lock = withStateLock, clientFactory = token => new ResyClient({ token }) }) {
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url !== `/pair/${loginId}` && request.url !== `/pair/${loginId}/complete`) return send(response, 404, { status: 'not_found' });
      if (request.headers.host !== new URL(origin()).host) return send(response, 403, { status: 'forbidden' });
      const pending = await lock(() => read('login'));
      if (pending?.loginId !== loginId || !['waiting', 'validating'].includes(pending.status) || pending.expiresAt <= Date.now()) return send(response, 410, { status: 'expired' });
      if (request.method === 'GET' && request.url === `/pair/${loginId}`) { const page = loginPage(loginId); response.writeHead(200, page.headers); return response.end(page.html); }
      if (request.method !== 'POST' || request.url !== `/pair/${loginId}/complete`) return send(response, 405, { status: 'method_not_allowed' });
      if (request.headers.origin !== origin() || !sameSecret(request.headers['x-rea-pair-key'], pending.secret) || !/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) return send(response, 403, { status: 'forbidden' });
      const payload = await body(request);
      if (Object.keys(payload).length !== 1) return send(response, 400, { status: 'invalid_request' });
      try { checkToken(payload.token); } catch { return send(response, 400, { status: 'invalid_request' }); }
      const accepted = await lock(async () => { const latest = await read('login'); if (latest?.loginId !== loginId || latest.status !== 'waiting' || latest.expiresAt <= Date.now()) return false; await save('login', { ...latest, status: 'validating' }); return true; });
      if (!accepted) return send(response, 409, { status: 'unavailable' });
      let user;
      try { user = await clientFactory(payload.token).me(); }
      catch { await lock(async () => { const latest = await read('login'); if (latest?.loginId === loginId && latest.status === 'validating') await save('login', { ...latest, status: 'failed', secret: undefined, approvalUrl: undefined, error: { code: 'LOGIN_VALIDATION_FAILED', message: 'Resy did not validate the received session. Start a new login.' } }); }); return send(response, 401, { status: 'failed' }); }
      const rawId = user?.id ?? user?.user_id;
      const id = String(rawId ?? '');
      if (!/^\d{1,30}$/.test(id) || (typeof rawId === 'number' && !Number.isSafeInteger(rawId))) { await lock(async () => { const latest = await read('login'); if (latest?.loginId === loginId && latest.status === 'validating') await save('login', { ...latest, status: 'failed', secret: undefined, approvalUrl: undefined, error: { code: 'PROTOCOL_CHANGED', message: 'Resy returned an unrecognized account response.' } }); }); return send(response, 502, { status: 'failed' }); }
      const committed = await lock(async () => {
        const latest = await read('login');
        if (latest?.loginId !== loginId || latest.status !== 'validating' || latest.expiresAt <= Date.now()) return false;
        const account = { id }; if (typeof user.first_name === 'string') account.firstName = user.first_name; if (typeof user.last_name === 'string') account.lastName = user.last_name;
        const now = new Date().toISOString(); await save('session', { version: 1, token: payload.token, account, acquiredBy: 'widget-pairing', acquiredAt: now, validatedAt: now });
        await save('login', { ...latest, status: 'authenticated', secret: undefined, approvalUrl: undefined }); return true;
      });
      return send(response, committed ? 200 : 409, { status: committed ? 'authenticated' : 'canceled' });
    } catch { if (!response.headersSent) send(response, 400, { status: 'invalid_request' }); else response.end(); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  return server;
}

export async function startTunnel(binary, port, { spawnImpl = spawn } = {}) {
  const child = spawnImpl(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tunnel timeout')), 25000); let output = '';
      const fail = () => { clearTimeout(timer); reject(new Error('Tunnel unavailable')); };
      child.once('error', fail); child.once('exit', fail);
      child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-20000); const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    });
    return { child, url };
  } catch (error) { child.kill(); throw error; }
}

export async function runWorker(loginId) {
  const pending = await withStateLock(() => readState('login'));
  if (pending?.loginId !== loginId || pending.status !== 'starting') return;
  let publicOrigin = pending.publicOrigin, tunnel, timer, stopping = false;
  const server = createLoginServer({ loginId, origin: () => publicOrigin });
  const stop = async () => { if (stopping) return; stopping = true; clearInterval(timer); server.close(); server.closeIdleConnections(); setTimeout(() => server.closeAllConnections(), 1000); tunnel?.child.kill(); };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pending.port, '127.0.0.1', resolve); });
    if (!publicOrigin) { tunnel = await startTunnel(pending.tunnelPath, server.address().port); publicOrigin = tunnel.url; }
    const ready = await withStateLock(async () => { const latest = await readState('login'); if (latest?.loginId !== loginId || latest.status !== 'starting' || latest.expiresAt <= Date.now()) return false; await saveState('login', { ...latest, status: 'waiting', publicOrigin, port: server.address().port, approvalUrl: `${publicOrigin}/pair/${loginId}#key=${latest.secret}` }); return true; });
    if (!ready) return await stop();
    const audit = async () => {
      try {
        const current = await withStateLock(() => readState('login'));
        if (current?.loginId !== loginId || !['waiting', 'validating'].includes(current.status)) return stop();
        if (current.expiresAt <= Date.now() || (tunnel && (tunnel.child.exitCode !== null || tunnel.child.signalCode !== null))) { await withStateLock(async () => { const latest = await readState('login'); if (latest?.loginId === loginId && ['waiting', 'validating'].includes(latest.status)) await saveState('login', { ...latest, status: latest.expiresAt <= Date.now() ? 'expired' : 'failed', secret: undefined, approvalUrl: undefined, error: latest.expiresAt <= Date.now() ? undefined : { code: 'TUNNEL_CLOSED', message: 'Login tunnel closed. Start a new login.' } }); }); await stop(); }
      } catch { await stop(); }
    };
    timer = setInterval(audit, 500);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await withStateLock(async () => { const latest = await readState('login'); if (latest?.loginId === loginId && ['waiting', 'validating'].includes(latest.status)) await saveState('login', { ...latest, status: 'failed', secret: undefined, approvalUrl: undefined, error: { code: 'LOGIN_WORKER_STOPPED', message: 'Login worker stopped.' } }); }); await stop(); });
  } catch {
    await withStateLock(async () => { const latest = await readState('login'); if (latest?.loginId === loginId && ['starting', 'waiting', 'validating'].includes(latest.status)) await saveState('login', { ...latest, status: 'failed', secret: undefined, approvalUrl: undefined, error: { code: 'LOGIN_START_FAILED', message: 'Could not start the login server or tunnel. Check cloudflared or reverse-proxy configuration.' } }); }); await stop();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await runWorker(process.argv[2]);
