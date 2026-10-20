import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_CLOUD_URL, CODEX_SUBPROTOCOL, buildCodexRequest, initializeRequest,
  listThreadsRequest, searchThreadsRequest, readThreadRequest, startThreadRequest,
  startTurnRequest, interruptTurnRequest, parseCodexMessage, parseCodexResponse,
  normalizeCodexThread, normalizeCodexPage, listTurnsRequest, listItemsRequest, listEnvironmentsRequest,
} from '../src/codex-protocol.mjs';

test('the native cloud endpoint uses the app-server WebSocket subprotocol', () => {
  assert.equal(CODEX_CLOUD_URL, 'wss://codex-cloud-backend.chatgpt.com/');
  assert.equal(CODEX_SUBPROTOCOL, 'codex-app-server');
  const hello = initializeRequest(1);
  assert.deepEqual(hello, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: true },
    clientInfo: { name: 'codex_chatgpt_android_remote', version: 'dev' },
  } });
});

test('request identifiers cannot silently collide through numeric truncation', () => {
  for (const id of [0, -1, NaN, 1.2, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.throws(() => buildCodexRequest(id, 'thread/list'), { code: 'INVALID_CODEX_ARGUMENT' });
  }
});

test('thread listing preserves opaque cursors and uses native pagination keys', () => {
  const opaque = 'a/+% cursor=é';
  const request = listThreadsRequest(2, { cursor: opaque, limit: 25, sectionId: 'pinned' });
  assert.equal(request.params.cursor, opaque);
  assert.equal(request.params.limit, 25);
  assert.equal(request.params.sectionId, 'pinned');
  assert.equal(request.params.sortKey, 'updated_at');
  assert.equal(request.params.sortDirection, 'desc');
  assert.equal(Object.hasOwn(listThreadsRequest(3).params, 'sectionId'), false);
  assert.throws(() => listThreadsRequest(1, { limit: 0 }), { code: 'INVALID_CODEX_ARGUMENT' });
  assert.throws(() => listThreadsRequest(1, { sortDirection: 'reverse' }), { code: 'INVALID_CODEX_ARGUMENT' });
});

test('search is a native server operation and does not filter a partial local page', () => {
  const request = searchThreadsRequest(3, { query: 'cloud swarm', cursor: 'next-page' });
  assert.equal(request.method, 'thread/search');
  assert.equal(request.params.searchTerm, 'cloud swarm');
  assert.equal(request.params.cursor, 'next-page');
  assert.throws(() => searchThreadsRequest(3, { query: '  ' }), { code: 'INVALID_CODEX_ARGUMENT' });
});

test('metadata reads use the cloud-supported separate turn pagination contract', () => {
  assert.deepEqual(readThreadRequest(4, { threadId: 'thread_1' }).params,
    { threadId: 'thread_1', includeTurns: false });
});

test('long task history has explicit turn and item pagination without changing cursors', () => {
  const turns = listTurnsRequest(5, { threadId: 't', cursor: 'opaque/turn', itemsView: 'full' });
  assert.equal(turns.method, 'thread/turns/list');
  assert.equal(turns.params.cursor, 'opaque/turn');
  assert.equal(turns.params.itemsView, 'full');
  const items = listItemsRequest(6, { threadId: 't', turnId: 'u', cursor: 'opaque/item', limit: 10 });
  assert.deepEqual(items.params, { threadId: 't', turnId: 'u', cursor: 'opaque/item', limit: 10, sortDirection: 'desc' });
});

test('environment configuration listing keeps its scope separate from pagination', () => {
  assert.deepEqual(listEnvironmentsRequest(7, { scope: 'all', cursor: 'next' }).params,
    { scope: 'all', cursor: 'next', limit: 100 });
  assert.equal(Object.hasOwn(listEnvironmentsRequest(8).params, 'scope'), false);
  assert.equal(Object.hasOwn(listEnvironmentsRequest(8).params, 'cursor'), false);
});

test('creating a cloud thread keeps model and environment selection separate', () => {
  const request = startThreadRequest(5, { environmentConfigId: 'env-config', model: 'example-model' });
  assert.equal(request.params.serviceName, 'codex_cloud');
  assert.equal(request.params.threadSource, 'user');
  assert.equal(request.params.environmentConfigId, 'env-config');
  assert.equal(request.params.model, 'example-model');
  assert.equal(request.params.environments.length, 1);
  assert.deepEqual(request.params.environments[0],
    { environmentId: 'managed', cwd: '/workspace', runtimeWorkspaceRoots: [], environmentConfigId: null });
});

test('a caller-supplied rich message survives without dropping unfamiliar fields', () => {
  const input = [{ type: 'text', text: 'Please inspect the failing build.', text_elements: [] },
    { type: 'image', url: 'https://example.invalid/error.png', futureField: { retained: true } }];
  const request = startTurnRequest(6, { threadId: 't', input, clientUserMessageId: 'message-a' });
  assert.deepEqual(request.params.input, input);
  assert.equal(request.params.clientUserMessageId, 'message-a');
  assert.throws(() => startTurnRequest(6, { threadId: 't', text: 'hi', input }),
    { code: 'INVALID_CODEX_ARGUMENT' });
  assert.throws(() => startTurnRequest(6, { threadId: 't', input: [] }),
    { code: 'INVALID_CODEX_ARGUMENT' });
});

test('interrupt targets the exact thread and turn', () => {
  assert.deepEqual(interruptTurnRequest(7, { threadId: 't', turnId: 'u' }).params,
    { threadId: 't', turnId: 'u' });
  assert.throws(() => interruptTurnRequest(7, { threadId: 't' }), { code: 'INVALID_CODEX_ARGUMENT' });
});

test('response correlation cannot mistake an event or a different request for success', () => {
  assert.throws(() => parseCodexResponse({ method: 'turn/completed', params: {} }, { expectedId: 2 }),
    { code: 'CODEX_RESPONSE_ID_MISMATCH' });
  assert.throws(() => parseCodexResponse({ id: 3, result: {} }, { expectedId: 2 }),
    { code: 'CODEX_RESPONSE_ID_MISMATCH' });
  assert.throws(() => parseCodexResponse({ id: 2 }, { expectedId: 2 }), { code: 'INVALID_CODEX_RESPONSE' });
});

test('protocol errors preserve the native error code and structured details', () => {
  const error = { code: -32001, message: 'Authorization expired', data: { reauth: true } };
  assert.throws(() => parseCodexResponse({ id: 9, error }, { expectedId: 9 }), (caught) => {
    assert.equal(caught.code, 'CODEX_REMOTE_ERROR');
    assert.deepEqual(caught.details, { rpcCode: -32001, data: { reauth: true } });
    return true;
  });
});

test('raw server results and notifications remain intact', () => {
  const result = { thread: { id: 'a' }, futureSchema: { retain: true } };
  assert.deepEqual(parseCodexResponse(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 10, result })),
    { expectedId: 10 }), result);
  const event = { method: 'item/agentMessage/delta', params: { delta: 'hello', unknown: [1] } };
  assert.deepEqual(parseCodexMessage(JSON.stringify(event)), event);
  assert.throws(() => parseCodexMessage('<html>blocked</html>'), { code: 'INVALID_CODEX_RESPONSE' });
});

test('normalized views retain every original item, branch and pagination token', () => {
  const raw = { id: 'a', name: 'Swarm', turns: [{ id: 'b', items: [{ type: 'futureType', data: [1] }] }],
    unknown: 'retained', status: { type: 'active' } };
  const thread = normalizeCodexThread(raw);
  assert.equal(thread.id, 'a');
  assert.equal(thread.title, 'Swarm');
  assert.equal(thread.raw, raw);
  assert.equal(thread.turns, raw.turns);
  const page = normalizeCodexPage({ data: [raw], nextCursor: 'opaque/+=', backwardsCursor: 'old' });
  assert.equal(page.items[0], raw);
  assert.equal(page.nextCursor, 'opaque/+=');
  assert.equal(page.backwardsCursor, 'old');
  assert.throws(() => normalizeCodexPage({ nextCursor: 'x' }), { code: 'INVALID_CODEX_RESPONSE' });
});
