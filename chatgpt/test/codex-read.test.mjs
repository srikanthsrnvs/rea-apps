import test from 'node:test';
import assert from 'node:assert/strict';
import { readCodexThread } from '../src/codex.mjs';

test('thread reads hydrate one bounded full-items page and retain continuation metadata', async () => {
  const calls = [];
  const rawTurn = { id: 'turn-1', items: [{ type: 'agentMessage', text: 'Answer', futureField: ['keep'] }], itemsView: 'full' };
  const client = { snapshot: () => ({ notifications: [] }), async request(method, params) {
    calls.push({ method, params });
    return method === 'thread/read'
      ? { thread: { id: 'thread-1', name: 'Example', turns: [] }, extra: 1 }
      : { data: [rawTurn], nextCursor: 'opaque/next', backwardsCursor: 'opaque/back', extraPageField: true };
  } };
  const result = await readCodexThread(client, { threadId: 'thread-1' });
  assert.equal(calls[0].params.includeTurns, false);
  assert.equal(calls[1].method, 'thread/turns/list');
  assert.equal(calls[1].params.limit, 3);
  assert.equal(calls[1].params.itemsView, 'full');
  assert.equal(result.result.thread.turns[0], rawTurn);
  assert.equal(result.result.extra, 1);
  assert.equal(result.pagination.extraPageField, true);
  assert.equal(result.pagination.nextCursor, 'opaque/next');
  assert.equal(result.pagination.complete, false);
  assert.equal(calls.length, 2);
});

test('explicit all follows turn cursors while preserving unrecognized items', async () => {
  const cursors = [];
  const client = { snapshot: () => ({}), async request(method, params) {
    if (method === 'thread/read') return { thread: { id: 't' } };
    cursors.push(params.cursor);
    return params.cursor === null ? { data: [{ id: 'a', items: [] }], nextCursor: 'next' }
      : { data: [{ id: 'b', items: [{ type: 'future-type' }] }], nextCursor: null };
  } };
  const result = await readCodexThread(client, { threadId: 't', all: true });
  assert.deepEqual(cursors, [null, 'next']);
  assert.equal(result.result.thread.turns[1].items[0].type, 'future-type');
  assert.equal(result.pagination.complete, true);
});

test('repeated turn cursors stop instead of returning an incomplete conversation as complete', async () => {
  const client = { snapshot: () => ({}), async request(method) {
    return method === 'thread/read' ? { thread: { id: 't' } } : { data: [], nextCursor: 'same' };
  } };
  await assert.rejects(readCodexThread(client, { threadId: 't', cursor: 'same', all: true }),
    { code: 'PAGINATION_STALLED' });
});
