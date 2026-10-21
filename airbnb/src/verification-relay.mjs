import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const MAX_BODY = 24 * 1024;
const SUCCESS = new Set(['challenge-complete', 'challenge-suppressed']);
const FAILURE = new Set(['challenge-error', 'challenge-failed']);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src https://iframe.arkoselabs.com; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const HTML = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verification</title><link rel="stylesheet" href="/style.css"></head><body><iframe title="Verification" allow="fullscreen"></iframe><script type="module" src="/client.mjs"></script></body></html>';
const STYLE = 'html,body{margin:0;width:100%;height:100%;background:white}iframe{display:block;border:0;width:100%;height:100%}';
// The original vendor iframe performs verification in the user's browser.
// This page only transfers its completed result to the owning CLI process.
const CLIENT = `const fragment=location.hash.slice(1);
const key=fragment.startsWith('key=')?new URLSearchParams(fragment).get('key'):fragment;
history.replaceState(null,'',location.pathname);
const headers={authorization:'Bearer '+key};
const response=await fetch('/config',{headers,cache:'no-store'});
if(!response.ok)throw Error('Verification link expired');
const config=await response.json(),frame=document.querySelector('iframe');
let sending=false;
window.addEventListener('message',async event=>{
 if(sending||event.origin!=='https://iframe.arkoselabs.com'||event.source!==frame.contentWindow||typeof event.data!=='string')return;
 let message;try{message=JSON.parse(event.data)}catch{return}
 if(!message||typeof message!=='object'||Array.isArray(message))return;
 const success=['challenge-complete','challenge-suppressed'].includes(message.eventId);
 const failure=['challenge-error','challenge-failed'].includes(message.eventId);
 if(!success&&!failure)return;
 if(success&&(message.publicKey!==config.publicKey||typeof message.payload?.sessionToken!=='string'||message.payload.sessionToken.length<20||message.payload.sessionToken.length>16000))return;
 if(failure&&message.publicKey!=null&&message.publicKey!==config.publicKey)return;
 sending=true;
 try{
  const result=await fetch('/result',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({eventId:message.eventId,publicKey:message.publicKey??null,payload:success?{sessionToken:message.payload.sessionToken}:{error:typeof message.payload?.error==='string'?message.payload.error.slice(0,1000):'Verification failed'}})});
  document.title=result.ok?(success?'Verification complete':'Verification failed'):'Verification expired';
 }catch{document.title='Verification connection lost'}
});
frame.src=config.frameURL;`;

async function saveResult(directory, result) {
  const temporary = path.join(directory, `.verification-result-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(result)}\n`, { flag: 'wx', mode: 0o600 });
    // Hard-link publication is atomic and refuses to replace an earlier result.
    await fs.link(temporary, path.join(directory, 'verification-result.json'));
  } finally { await fs.rm(temporary, { force: true }); }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let length = 0, settled = false;
    const fail = status => {
      if (settled) return;
      settled = true;
      const error = new Error('Invalid verification body'); error.status = status;
      reject(error);
    };
    request.on('data', chunk => {
      if (settled) return;
      length += chunk.length;
      if (length > MAX_BODY) { chunks.length = 0; fail(413); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { const error = new Error('Invalid JSON'); error.status = 400; reject(error); }
    });
    request.on('error', () => fail(400));
    request.on('aborted', () => fail(400));
  });
}

export async function createVerificationRelay({ directory, publicKey, dataExchangeBlob = '', ttlMs = 15 * 60_000, onResult, onStop } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('An absolute private verification directory is required');
  if (typeof publicKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(publicKey)) throw new TypeError('Invalid verification public key');
  if (typeof dataExchangeBlob !== 'string' || dataExchangeBlob.length > 65536) throw new TypeError('Invalid verification data exchange');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 100 || ttlMs > 30 * 60_000) throw new RangeError('Verification lifetime must be between 100 ms and 30 minutes');
  if (onResult !== undefined && typeof onResult !== 'function') throw new TypeError('Invalid result callback');
  if (onStop !== undefined && typeof onStop !== 'function') throw new TypeError('Invalid stop callback');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('Verification directory must be a real directory');
  await fs.chmod(directory, 0o700);
  try { await fs.lstat(path.join(directory, 'verification-result.json')); throw new Error('Verification directory already contains a result'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  publicKey = publicKey.toUpperCase();
  const key = randomBytes(32).toString('base64url'), id = randomUUID(), expiresAt = Date.now() + ttlMs;
  const frame = new URL(`https://iframe.arkoselabs.com/${publicKey}/index.html`);
  frame.searchParams.set('data', dataExchangeBlob);
  frame.searchParams.set('mkt', 'en');
  let result = { status: 'waiting' }, publishing = false, closed = false, closePromise, listenPromise;
  const status = () => ({ id, status: Date.now() >= expiresAt && result.status === 'waiting' ? 'expired' : result.status, eventId: result.eventId ?? null, expiresAt });
  const server = http.createServer({ requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (request, response) => {
    const send = (code, value, type = 'application/json; charset=utf-8') => {
      if (response.destroyed) return;
      response.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': CSP });
      response.end(typeof value === 'string' ? value : JSON.stringify(value));
    };
    try {
      if (closed || Date.now() >= expiresAt) return send(410, { error: 'expired' });
      if (request.method === 'GET' && request.url === '/') return send(200, HTML, 'text/html; charset=utf-8');
      if (request.method === 'GET' && request.url === '/client.mjs') return send(200, CLIENT, 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && request.url === '/style.css') return send(200, STYLE, 'text/css; charset=utf-8');
      const supplied = Buffer.from(request.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${key}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(401, { error: 'unauthorized' });
      if (request.method === 'GET' && request.url === '/config') return send(200, { publicKey, frameURL: frame.href, expiresAt });
      if (request.method === 'GET' && request.url === '/status') return send(200, status());
      if (request.method === 'POST' && request.url === '/stop') {
        // Flush the local acknowledgement before terminating the owned tunnel.
        // The worker publishes host.status=closed only after all cleanup finishes.
        response.once('finish', () => {
          Promise.resolve().then(() => onStop ? onStop() : close()).catch(() => {});
        });
        send(200, { status: 'closing' }); return;
      }
      if (request.method !== 'POST' || request.url !== '/result') return send(404, { error: 'not_found' });
      if (publishing || result.status !== 'waiting') return send(409, { error: 'already_completed' });
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) return send(415, { error: 'json_required' });
      if (Number(request.headers['content-length']) > MAX_BODY) { request.resume(); return send(413, { error: 'too_large' }); }
      const input = await readBody(request);
      if (Date.now() >= expiresAt) return send(410, { error: 'expired' });
      if (!input || typeof input !== 'object' || Array.isArray(input)) return send(400, { error: 'invalid_result' });
      let next;
      if (SUCCESS.has(input.eventId)) {
        const token = input.payload?.sessionToken;
        if (input.publicKey !== publicKey || typeof token !== 'string' || token.length < 20 || token.length > 16000 || /[\r\n\x00]/.test(token)) return send(400, { error: 'invalid_result' });
        next = { id, status: 'completed', eventId: input.eventId, publicKey, token, receivedAt: new Date().toISOString() };
      } else if (FAILURE.has(input.eventId)) {
        if (input.publicKey != null && input.publicKey !== publicKey) return send(400, { error: 'invalid_result' });
        next = { id, status: 'failed', eventId: input.eventId, error: typeof input.payload?.error === 'string' ? input.payload.error.slice(0, 1000) : 'Verification failed', receivedAt: new Date().toISOString() };
      } else return send(400, { error: 'unexpected_event' });
      // Two bodies can finish concurrently; reserve the one-shot publication here.
      if (publishing || result.status !== 'waiting') return send(409, { error: 'already_completed' });
      publishing = true;
      try { await saveResult(directory, next); result = next; }
      finally { publishing = false; }
      send(200, { status: result.status });
      if (onResult) Promise.resolve().then(() => onResult(status())).catch(() => {});
    } catch (error) { send(error.status ?? 400, { error: error.status === 413 ? 'too_large' : 'invalid_request' }); }
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  const timer = setTimeout(() => void close(), ttlMs); timer.unref();
  function close() {
    if (closePromise) return closePromise;
    closed = true; clearTimeout(timer);
    closePromise = new Promise(resolve => {
      if (!server.listening) return resolve();
      server.close(resolve); server.closeAllConnections();
    });
    return closePromise;
  }
  return {
    id, key, expiresAt, status, close,
    listen() {
      if (closed || Date.now() >= expiresAt) return Promise.reject(new Error('Verification relay expired'));
      if (!listenPromise) listenPromise = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
      });
      return listenPromise;
    },
  };
}
