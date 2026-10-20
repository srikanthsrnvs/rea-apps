import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountRequest, parseAccount, chatsListRequest, parseChatsList,
  chatRequest, chatMessagesRequest, conversationBranch, parseConversation,
  chatsSearchRequest, parseSearchResults,
} from '../src/chat-read-protocol.mjs';

test('read builders use the recovered native routes and snake_case names', () => {
  assert.deepEqual(accountRequest(), { method: 'GET', path: 'me' });
  assert.deepEqual(chatsListRequest({ offset: 20, limit: 10, archived: true }), {
    method: 'GET', path: 'conversations', query: { offset: 20, limit: 10, order: 'updated', expand: false, is_archived: true },
  });
  assert.deepEqual(chatRequest('conv-1', { includeMessageId: 'node-2', numTurns: 3, projectId: 'project-1', ownerId: 'user-1' }), {
    method: 'GET', path: 'conversations/conv-1', query: { num_turns: 3, include_message_id: 'node-2' },
    headers: { 'Chatgpt-Project-ID': 'project-1', 'Chatgpt-Conv-Owner-ID': 'user-1' },
  });
  assert.deepEqual(chatMessagesRequest('conv-1', { before: 'node-2', numTurns: 7 }), {
    method: 'GET', path: 'conversations/conv-1/messages', query: { num_turns: 7, before: 'node-2' }, headers: {},
  });
});

test('identifiers, integer bounds, and booleans fail before creating requests', () => {
  for (const bad of ['../me', 'abc?x=1', '', 'a/b', 'a\n']) assert.throws(() => chatRequest(bad), { code: 'invalid_argument' });
  for (const offset of [-1, 1.5, NaN]) assert.throws(() => chatsListRequest({ offset }), { code: 'invalid_argument' });
  assert.throws(() => chatsListRequest({ limit: 0 }), { code: 'invalid_argument' });
  assert.throws(() => chatsListRequest({ archived: 'true' }), { code: 'invalid_argument' });
  assert.throws(() => chatsListRequest({ order: 'recent' }), { code: 'invalid_argument' });
});

test('list pagination counts malformed rows without losing their contents', () => {
  const extra = { attachment: { mime_type: 'application/x-example' } };
  const page = parseChatsList({ items: [{ id: 'c1', extra }, { title: 'Malformed but retained' }], total: 5, cursor: 'opaque', future_field: 9 }, { offset: 1, limit: 2 });
  assert.equal(page.items[0].extra, extra);
  assert.equal(page.unparsed_items[0].title, 'Malformed but retained');
  assert.equal(page.pagination.next_offset, 3);
  assert.equal(page.pagination.has_more, true);
  assert.equal(page.pagination.cursor, 'opaque');
  assert.equal(page.future_field, 9);
  assert.equal(parseChatsList({ items: [{ id: 'last' }], total: 5 }, { offset: 4, limit: 2 }).pagination.next_offset, null);
});

test('empty or unknown-total pages terminate without inventing an offset', () => {
  const page = parseChatsList({ items: [], total: 10 });
  assert.equal(page.pagination.stalled, true);
  assert.equal(page.pagination.next_offset, null);
  assert.equal(parseChatsList({ items: [] }).pagination.has_more, false);
  assert.throws(() => parseChatsList({ items: {} }), { code: 'unexpected_response' });
});

test('conversation parsing follows the selected branch and preserves alternate rich messages', () => {
  const image = { id: 'image-message', author: { role: 'assistant' }, content: { content_type: 'multimodal_text', parts: [{ image_asset_pointer: 'file-1' }] } };
  const data = {
    id: 'conv-1', current_node: 'selected', extra_server_metadata: { retained: true },
    mapping: {
      root: { id: 'root', parent: null, children: ['question'], message: null },
      question: { id: 'question', parent: 'root', children: ['selected', 'alternate'], message: { author: { role: 'user' }, content: { parts: ['A question'] } } },
      selected: { id: 'selected', parent: 'question', children: [], message: image },
      alternate: { id: 'alternate', parent: 'question', children: [], message: { author: { role: 'assistant' }, content: { parts: ['Alternate answer'] } } },
    },
  };
  const parsed = parseConversation(data);
  assert.deepEqual(parsed.current_branch.node_ids, ['root', 'question', 'selected']);
  assert.equal(parsed.current_branch.messages[1], image);
  assert.equal(parsed.current_branch.complete, true);
  assert.equal(parsed.mapping.alternate.message.content.parts[0], 'Alternate answer');
  assert.equal(parsed.extra_server_metadata, data.extra_server_metadata);
  assert.equal(data.current_branch, undefined);
});

test('partial mappings and cycles are explicit, bounded outcomes', () => {
  const partial = conversationBranch({ leaf: { parent: 'not-in-page', message: { id: 'm' } } }, 'leaf');
  assert.equal(partial.complete, false);
  assert.equal(partial.termination, 'missing_node');
  assert.equal(partial.stopped_at, 'not-in-page');
  assert.deepEqual(partial.node_ids, ['leaf']);
  const cyclic = conversationBranch({ a: { parent: 'b' }, b: { parent: 'a' } }, 'a');
  assert.equal(cyclic.termination, 'cycle');
  assert.equal(cyclic.node_ids.length, 2);
  assert.equal(conversationBranch({}, null).termination, 'no_current_node');
  assert.throws(() => parseConversation({}), { code: 'unexpected_response' });
});

test('native active-branch pages retain rich messages without inventing parent links', () => {
  const user = { id: 'question', author: { role: 'user' }, content: { content_type: 'text', parts: ['An example question'] } };
  const tool = { id: 'tool-result', author: { role: 'tool' }, content: { content_type: 'multimodal_text', parts: [{ asset_pointer: 'example-file' }] } };
  const answer = { id: 'answer', author: { role: 'assistant' }, metadata: { parent_id: 'question', future: true }, content: { content_type: 'text', parts: ['An example answer'] } };
  const data = { conversation_id: 'conv-1', title: 'Example', current_node: 'answer', messages: [user, tool, answer], page_info: { start_cursor: 'first', end_cursor: 'last', has_previous_page: false, has_next_page: false }, extra: { retained: true } };
  const parsed = parseConversation(data);
  assert.equal(parsed.current_branch.source, 'native_page');
  assert.equal(parsed.current_branch.complete, true);
  assert.equal(parsed.current_branch.current_node_in_page, true);
  assert.equal(parsed.current_branch.last_user_message, user);
  assert.deepEqual(parsed.current_branch.message_ids, ['question', 'tool-result', 'answer']);
  assert.deepEqual(parsed.current_branch.parent_links, [{ message_id: 'answer', parent_id: 'question' }]);
  assert.equal(parsed.current_branch.messages[1], tool);
  assert.equal(parsed.mapping, undefined);
  assert.equal(parsed.current_branch.node_ids, undefined);
  assert.equal(parsed.extra, data.extra);
  assert.equal(data.current_branch, undefined);
});

test('native page completeness reflects pagination and missing current node', () => {
  const base = { conversation_id: 'conv-1', current_node: 'latest', messages: [{ id: 'latest', author: { role: 'assistant' } }] };
  const partial = parseConversation({ ...base, page_info: { has_previous_page: true, has_next_page: false, start_cursor: 'opaque-previous' } });
  assert.equal(partial.current_branch.complete, false);
  assert.equal(partial.current_branch.termination, 'previous_page_available');
  assert.equal(partial.current_branch.page_info.start_cursor, 'opaque-previous');
  const beforeCurrent = parseConversation({ ...base, messages: [{ id: 'older' }], page_info: { has_previous_page: false, has_next_page: true } });
  assert.equal(beforeCurrent.current_branch.current_node_in_page, false);
  assert.equal(beforeCurrent.current_branch.termination, 'page_before_current_node');
  assert.equal(beforeCurrent.current_branch.complete, false);
  const unknown = parseConversation(base);
  assert.equal(unknown.current_branch.complete, false);
  assert.equal(unknown.current_branch.termination, 'pagination_unknown');
  assert.equal(parseConversation({ ...base, page_info: { has_previous_page: false, has_next_page: false }, current_node: 'not-returned' }).current_branch.complete, false);
  assert.throws(() => parseConversation({ messages: [null] }), { code: 'unexpected_response' });
});

test('search preserves mixed result data and uses an opaque server cursor', () => {
  assert.deepEqual(chatsSearchRequest('flight notes', { cursor: 'opaque/+==', queryId: 'q-1' }), {
    method: 'POST', path: 'global/search', body: { query: 'flight notes', limit: 20, cursor: 'opaque/+==', query_id: 'q-1' },
  });
  const item = { id: 'result', kind: 'future_kind', data: { opaque: ['unchanged'] } };
  const parsed = parseSearchResults({ items: [item], cursor: 'next', partial_results: true, source_statuses: [{ source: 'example' }] });
  assert.equal(parsed.items[0], item);
  assert.equal(parsed.partial_results, true);
  assert.equal(parsed.pagination.has_more, true);
  assert.equal(parseSearchResults({ items: [], cursor: '' }).pagination.has_more, false);
  assert.throws(() => chatsSearchRequest('   '), { code: 'invalid_argument' });
  assert.throws(() => chatsSearchRequest('ok', { cursor: 'bad\n' }), { code: 'invalid_argument' });
});

test('account verification requires an ID and keeps provider fields intact', () => {
  const account = { id: 'user-1', email: 'test@example.invalid', unknown: { flag: true } };
  assert.deepEqual(parseAccount(account), account);
  assert.throws(() => parseAccount({ email: 'test@example.invalid' }), { code: 'unexpected_response' });
  assert.throws(() => parseAccount([]), { code: 'unexpected_response' });
});
