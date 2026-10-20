import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexClient, withCodex, createCodexWebSocket } from '../src/codex-client.mjs';
import { CODEX_CLOUD_URL } from '../src/codex-protocol.mjs';

function frame(value, opcode = 1) {
  const data = opcode === 1 ? Buffer.from(JSON.stringify(value)) : Buffer.from(value);
  const prefix = data.length < 126 ? Buffer.from([0x80 | opcode, data.length])
    : Buffer.from([0x80 | opcode, 126, data.length >> 8, data.length & 255]);
  return Buffer.concat([prefix, data]);
}

async function fixture(t, handler = () => {}) {
  const received = [];
  const connections = [];
  const sockets = new Set();
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    connections.push(request.headers);
    const accept = createHash('sha1')
      .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: codex-app-server\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    const send = (message) => socket.write(frame(message));
    socket.on('data', (bytes) => {
      buffered = Buffer.concat([buffered, bytes]);
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15;
        const masked = Boolean(buffered[1] & 128);
        let length = buffered[1] & 127;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) return;
          length = buffered.readUInt16BE(2); offset = 4;
        } else if (length === 127) {
          if (buffered.length < 10) return;
          length = Number(buffered.readBigUInt64BE(2)); offset = 10;
        }
        const maskLength = masked ? 4 : 0;
        if (buffered.length < offset + maskLength + length) return;
        const mask = masked ? buffered.subarray(offset, offset + 4) : null;
        offset += maskLength;
        const payload = Buffer.from(buffered.subarray(offset, offset + length));
        buffered = buffered.subarray(offset + length);
        if (masked) for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
        if (opcode === 8) { socket.end(frame(payload, 8)); return; }
        if (opcode === 9) { socket.write(frame(payload, 10)); continue; }
        if (opcode !== 1) continue;
        const message = JSON.parse(payload.toString());
        received.push(message);
        if (message.method === 'initialize') send({ id: message.id, result: { serverVersion: 'test' } });
        else handler(message, send, socket);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `ws://127.0.0.1:${server.address().port}/`;
  const targets = [];
  return { received, connections, targets, webSocketFactory(productionUrl, init) {
    targets.push(productionUrl);
    return createCodexWebSocket(url, init);
  } };
}

test('WebSocket sends injected headers and correlates concurrent JSON-RPC responses', async (t) => {
  const requests = [];
  const f = await fixture(t, (message, send) => {
    if (!message.id) return;
    requests.push({ message, send });
    if (requests.length === 2) {
      for (const item of requests.toReversed()) item.send({ id: item.message.id, result: { method: item.message.method } });
    }
  });
  const client = new CodexClient({ headers: { Authorization: 'Bearer local-test', DPoP: 'local-proof' },
    webSocketFactory: f.webSocketFactory, url: 'wss://unexpected.invalid/' });
  t.after(() => client.close());
  await client.connect();
  assert.deepEqual(await Promise.all([client.request('thread/list', {}), client.request('model/list', {})]),
    [{ method: 'thread/list' }, { method: 'model/list' }]);
  assert.deepEqual(f.targets, [CODEX_CLOUD_URL]);
  assert.equal(f.connections[0].authorization, 'Bearer local-test');
  assert.equal(f.connections[0].dpop, 'local-proof');
  assert.equal(f.connections[0]['sec-websocket-protocol'], 'codex-app-server');
  assert.equal(f.connections[0]['sec-websocket-extensions'], undefined);
  assert.equal(f.connections[0]['sec-fetch-mode'], undefined);
  assert.equal(f.received[0].method, 'initialize');
  assert.equal(f.received[1].method, 'initialized');
  assert.deepEqual(f.received[1].params, {});
  assert.deepEqual(f.received.filter((x) => x.id).map((x) => x.id), [1, 2, 3]);
});

test('timeouts and native errors never retry a possibly accepted write', async (t) => {
  const f = await fixture(t, (message, send) => {
    if (message.method === 'thread/read') send({ id: message.id, error: { code: -1, message: 'Unknown thread' } });
  });
  const client = new CodexClient({ webSocketFactory: f.webSocketFactory, timeoutMs: 80 });
  t.after(() => client.close());
  await client.connect();
  await assert.rejects(client.request('turn/start', { threadId: 'thread-a', input: [] }), (error) => {
    assert.equal(error.code, 'CODEX_REQUEST_TIMEOUT');
    assert.equal(error.details.deliveryUnknown, true);
    assert.equal(error.details.method, 'turn/start');
    return true;
  });
  await assert.rejects(client.request('thread/read', { threadId: 'missing' }), { code: 'CODEX_REMOTE_ERROR' });
  assert.equal(f.received.filter((x) => x.method === 'turn/start').length, 1);
  assert.equal(f.connections.length, 1);
});

test('server approval requests are returned to the caller without approval', async (t) => {
  const callbacks = [];
  const f = await fixture(t, (message, send) => {
    if (message.method !== 'turn/start') return;
    send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { command: 'echo example' } });
    send({ id: message.id, result: { turn: { id: 'turn-a', status: 'inProgress' } } });
  });
  const client = new CodexClient({ webSocketFactory: f.webSocketFactory, onRequest: (request) => callbacks.push(request) });
  t.after(() => client.close());
  await client.connect();
  const result = await client.request('turn/start', { threadId: 'thread-a' });
  await delay(20);
  assert.equal(result.turn.id, 'turn-a');
  assert.equal(callbacks.length, 1);
  assert.equal(client.snapshot().pendingRequests[0].id, 'approval-1');
  assert.equal(f.received.some((x) => x.id === 'approval-1'), false);
});

test('progress notifications are bounded and unknown payloads remain intact', async (t) => {
  const f = await fixture(t, (message, send) => {
    if (message.method !== 'thread/list') return;
    for (let n = 0; n < 6; n++) send({ method: 'future/event', params: { n, nested: { retained: true } } });
    send({ id: message.id, result: { data: [], unknownResultField: ['kept'] } });
  });
  const client = new CodexClient({ webSocketFactory: f.webSocketFactory, maxNotifications: 2 });
  t.after(() => client.close());
  await client.connect();
  const response = await client.requestEnvelope('thread/list');
  assert.deepEqual(response.result.unknownResultField, ['kept']);
  assert.equal(response.response.id, response.request.id);
  assert.equal(client.snapshot().notifications.length, 2);
  assert.equal(client.snapshot().droppedNotifications, 4);
  assert.deepEqual(client.snapshot().notifications[1].params, { n: 5, nested: { retained: true } });
});

test('disconnect reports an uncertain accepted write and never reconnects automatically', async (t) => {
  const f = await fixture(t, (message, _send, socket) => {
    if (message.method === 'thread/start') socket.destroy();
  });
  const client = new CodexClient({ webSocketFactory: f.webSocketFactory });
  t.after(() => client.close());
  await client.connect();
  await assert.rejects(client.request('thread/start'), (error) => {
    assert.equal(error.code, 'CODEX_DISCONNECTED');
    assert.equal(error.details.deliveryUnknown, true);
    return true;
  });
  await assert.rejects(client.request('thread/list'), { code: 'CODEX_NOT_CONNECTED' });
  await assert.rejects(client.connect(), { code: 'CODEX_CLOSED' });
  assert.equal(f.connections.length, 1);
});

test('withCodex closes after errors and does not echo private injected headers', async (t) => {
  const f = await fixture(t);
  const secret = 'local-secret-do-not-print';
  await assert.rejects(withCodex({ Authorization: `Bearer ${secret}` }, async () => {
    throw new Error('Caller failed');
  }, { webSocketFactory: f.webSocketFactory }), /Caller failed/);
  const client = new CodexClient({ headers: { Authorization: secret }, webSocketFactory() { throw new Error(secret); } });
  await assert.rejects(client.connect(), (error) => {
    assert.equal(error.code, 'CODEX_CONNECTION_ERROR');
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('HTTP upgrade rejection reports status and stops without redirect or retry', async (t) => {
  let attempts = 0;
  const server = http.createServer();
  server.on('upgrade', (_request, socket) => {
    attempts++;
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nCf-Mitigated: challenge\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new CodexClient({ webSocketFactory: (_url, init) =>
    createCodexWebSocket(`ws://127.0.0.1:${server.address().port}/`, init) });
  t.after(() => client.close());
  await assert.rejects(client.connect(), (error) => {
    assert.equal(error.code, 'CODEX_UPGRADE_REJECTED');
    assert.deepEqual(error.details, { status: 403, challenge: true });
    return true;
  });
  assert.equal(attempts, 1);
});
