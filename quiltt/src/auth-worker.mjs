import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readState, saveState, withStateLock } from './state.mjs';
import { requireConfig } from './config.mjs';
import { validateSession } from './data.mjs';
import { startTunnel } from './tunnel.mjs';
import { randomBytes } from 'node:crypto';

function sameSecret(left, right) {
  return typeof left === 'string' && typeof right === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(left)
    && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' };
function send(response, status, data, extra = {}) { response.writeHead(status, { ...headers, 'content-type': 'application/json', ...extra }); response.end(JSON.stringify(data)); }
function blank(response, title) {
  response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
  response.end(`<!doctype html><html><head><title>${title}</title></head><body></body></html>`);
}
export function beginPage(loginId) {
  if (typeof loginId !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(loginId)) throw new Error('Invalid login identifier');
  const nonce = randomBytes(24).toString('base64');
  return { headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` },
    html: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quiltt</title></head><body><script nonce="${nonce}">
const key=new URLSearchParams(location.hash.slice(1)).get('key');
history.replaceState(null,'',location.pathname);
if(key&&/^[A-Za-z0-9_-]{43}$/.test(key))fetch('/pair/${loginId}/begin',{method:'POST',headers:{'x-quiltt-pair-key':key},credentials:'same-origin'}).then(async response=>{const result=await response.json();if(response.ok)location.replace(result.url);else document.title='Connection unavailable';}).catch(()=>{document.title='Connection unavailable';});
</script></body></html>` };
}
export function callbackToken(url) {
  // Exit Redirect appends a session token. Metadata is informational only.
  // Accept one JWT-shaped value and validate it with Quiltt; no JWT is trusted
  // by decoding its claims locally or by trusting a returned Profile ID.
  const tokens = [...url.searchParams.values()].filter(value => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value) && value.length <= 16384);
  if (tokens.length !== 1) throw new Error('Missing single Quiltt session token');
  return tokens[0];
}
export function createLoginServer({ loginId, origin, read = readState, save = saveState, lock = withStateLock,
  configReader = requireConfig, validate = validateSession }) {
  const server = http.createServer(async (req, response) => {
    try {
      if (!origin() || req.headers.host !== new URL(origin()).host) return send(response, 403, { status: 'forbidden' });
      const url = new URL(req.url, origin());
      if (req.method === 'GET' && url.pathname === '/done') return blank(response, 'Connection complete');
      const pending = await lock(() => read('login'));
      if (pending?.loginId !== loginId || !['waiting', 'validating'].includes(pending.status) || pending.expiresAt <= Date.now()) return send(response, 410, { status: 'expired' });
      if (req.method === 'GET' && url.pathname === `/pair/${loginId}`) {
        const page = beginPage(loginId); response.writeHead(200, page.headers); return response.end(page.html);
      }
      if (req.method === 'POST' && url.pathname === `/pair/${loginId}/begin`) {
        if (pending.status !== 'waiting' || req.headers.origin !== origin() || !sameSecret(req.headers['x-quiltt-pair-key'], pending.secret)) return send(response, 403, { status: 'forbidden' });
        return send(response, 200, { url: `https://${pending.connectorId}.quiltt.app/` }, { 'set-cookie': `__Host-quiltt-pair=${loginId}.${pending.secret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(1, Math.floor((pending.expiresAt - Date.now()) / 1000))}` });
      }
      if (req.method !== 'GET' || url.pathname !== '/callback') return send(response, 404, { status: 'not_found' });
      const cookies = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith('__Host-quiltt-pair='));
      const expectedPrefix = `__Host-quiltt-pair=${loginId}.`;
      if (cookies.length !== 1 || !cookies[0].startsWith(expectedPrefix) || !sameSecret(cookies[0].slice(expectedPrefix.length), pending.secret)) return send(response, 403, { status: 'forbidden' });
      let token;
      try { token = callbackToken(url); }
      catch {
        await lock(async () => {
          const latest = await read('login');
          if (latest?.loginId === loginId && latest.status === 'waiting') await save('login', { ...latest,
            callback: { received: true, tokenReceived: false, queryKeys: [...url.searchParams.keys()].filter(key => /^[A-Za-z0-9_]{1,48}$/u.test(key)).slice(0, 20) },
            error: { code: 'CALLBACK_TOKEN_MISSING', message: 'The callback contained no single session token. Enable Send Token in the Connector Exit Redirect setting.' } });
        });
        return send(response, 400, { status: 'session_token_missing' });
      }
      const accepted = await lock(async () => {
        const latest = await read('login');
        if (latest?.loginId !== loginId || latest.status !== 'waiting' || latest.expiresAt <= Date.now()) return false;
        await save('login', { ...latest, status: 'validating' }); return true;
      });
      if (!accepted) return send(response, 409, { status: 'unavailable' });
      let session;
      try {
        const config = await configReader();
        if (config.connectorId !== pending.connectorId || config.environment.id !== pending.environmentId) throw new Error('Configuration changed');
        session = await validate(token, config);
        if (pending.expectedProfileId && session.profile.id !== pending.expectedProfileId) throw new Error('Profile changed');
      } catch {
        await lock(async () => { const latest = await read('login'); if (latest?.loginId === loginId && latest.status === 'validating') await save('login', { ...latest, status: 'failed', secret: undefined, approvalUrl: undefined, error: { code: 'SESSION_VALIDATION_FAILED', message: 'Quiltt did not validate a matching Sandbox session. The previous saved Profile was preserved.' } }); });
        return send(response, 401, { status: 'validation_failed' });
      }
      const committed = await lock(async () => {
        const latest = await read('login'), config = await configReader();
        if (latest?.loginId !== loginId || latest.status !== 'validating' || latest.expiresAt <= Date.now() || config.environment.id !== session.environmentId || config.connectorId !== pending.connectorId) return false;
        await save('session', session);
        await save('login', { ...latest, status: 'authenticated', secret: undefined, approvalUrl: undefined }); return true;
      });
      if (!committed) return send(response, 409, { status: 'cancelled' });
      response.writeHead(303, { ...headers, location: '/done', 'set-cookie': '__Host-quiltt-pair=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0' }); return response.end();
    } catch { if (!response.headersSent) send(response, 400, { status: 'invalid_request' }); else response.end(); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1000; return server;
}
export async function runWorker(loginId) {
  const pending = await withStateLock(() => readState('login'));
  if (pending?.loginId !== loginId || pending.status !== 'starting') return;
  let publicOrigin = pending.publicOrigin, tunnel, timer, stopping = false;
  const server = createLoginServer({ loginId, origin: () => publicOrigin });
  const stop = async () => { if (stopping) return; stopping = true; clearInterval(timer); server.close(); server.closeIdleConnections(); setTimeout(() => server.closeAllConnections(), 1000); tunnel?.child.kill(); };
  const fail = async code => withStateLock(async () => {
    const latest = await readState('login');
    if (latest?.loginId === loginId && ['starting', 'waiting', 'validating'].includes(latest.status)) await saveState('login', { ...latest, status: 'failed', secret: undefined, approvalUrl: undefined, error: { code, message: 'The temporary connection server stopped. Start a fresh login.' } });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pending.port, '127.0.0.1', resolve); });
    if (!publicOrigin) { tunnel = await startTunnel(pending.tunnelPath, server.address().port); publicOrigin = tunnel.url; }
    const ready = await withStateLock(async () => {
      const latest = await readState('login');
      if (latest?.loginId !== loginId || latest.status !== 'starting' || latest.expiresAt <= Date.now()) return false;
      await saveState('login', { ...latest, status: 'waiting', publicOrigin, port: server.address().port, approvalUrl: `${publicOrigin}/pair/${loginId}#key=${latest.secret}` }); return true;
    });
    if (!ready) return stop();
    timer = setInterval(async () => {
      try {
        const current = await withStateLock(() => readState('login'));
        if (current?.loginId !== loginId || !['waiting', 'validating'].includes(current.status)) return stop();
        if (current.expiresAt <= Date.now() || tunnel && (tunnel.child.exitCode !== null || tunnel.child.signalCode !== null)) { await fail(current.expiresAt <= Date.now() ? 'LOGIN_EXPIRED' : 'TUNNEL_CLOSED'); await stop(); }
      } catch { await stop(); }
    }, 500);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await fail('WORKER_STOPPED'); await stop(); });
  } catch { await fail('LOGIN_START_FAILED'); await stop(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await runWorker(process.argv[2]);
