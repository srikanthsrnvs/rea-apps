import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/cli.mjs';
import { listChats } from '../src/chats.mjs';

test('the CLI exposes schemas and rejects unknown, duplicate and misplaced options', async () => {
  const { tools } = await dispatch(['tools']);
  assert.equal(tools.length, 25);
  assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
  for (const args of [['unknown'], ['account', '--prompt', 'hi'], ['login', '--email', 'a', '--email', 'b'], ['auth', 'complete']]) {
    await assert.rejects(dispatch(args));
  }
});

test('all-chat pagination follows actual consumed rows and stops on empty pages', async () => {
  const offsets = [];
  const client = { request: async request => {
    offsets.push(request.query.offset);
    return request.query.offset === 0
      ? { items: [{ id: 'a' }, { id: 'b' }], total: 5 }
      : request.query.offset === 2 ? { items: [{ id: 'b' }, { id: 'c' }], total: 5 }
        : { items: [], total: 5 };
  } };
  const result = await listChats({ all: true, limit: 2 }, client);
  assert.deepEqual(offsets, [0, 2, 4]);
  assert.deepEqual(result.items.map(item => item.id), ['a', 'b', 'c']);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.stalled, true);
});
