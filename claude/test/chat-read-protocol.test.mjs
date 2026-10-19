import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROOT_MESSAGE_ID, accountRequest, listChatsRequest, searchChatsRequest, openChatRequest,
  parseAccountResponse, parseChatsPage, parseSearchResults, parseChatResponse,
} from '../src/chat-read-protocol.mjs';

const org = '11111111-1111-4111-8111-111111111111';
const chat = '22222222-2222-4222-8222-222222222222';
const one = '33333333-3333-4333-8333-333333333333';
const two = '44444444-4444-4444-8444-444444444444';
const alt = '55555555-5555-4555-8555-555555555555';
const summary = { uuid: chat, name: 'A saved conversation', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' };

test('account and native sectioned recents use the source route and real opaque cursor', () => {
  assert.deepEqual(accountRequest(), { method: 'GET', url: 'https://claude.ai/api/account' });
  const first = new URL(listChatsRequest(org).url);
  assert.equal(first.pathname, `/api/organizations/${org}/recents`);
  assert.equal(first.searchParams.get('limit'), '100');
  assert.equal(first.searchParams.get('surfaces'), 'chat');
  assert.equal(first.searchParams.has('cursor'), false);
  const next = new URL(listChatsRequest(org, { cursor: 'opaque+/= token' }).url);
  assert.equal(next.searchParams.get('cursor'), 'opaque+/= token');
  assert.equal(next.searchParams.get('section'), 'recents');
  assert.equal(next.searchParams.get('limit'), '30');
  const included = new URL(listChatsRequest(org, { surfaces: ['chat', 'cowork_chat', 'routine'] }).url);
  assert.deepEqual(included.searchParams.getAll('include'), ['cowork_chat', 'routine']);
  assert.deepEqual(included.searchParams.getAll('surfaces'), ['chat']);
});

test('search uses native v2 route and fixed ten hits, without inventing cursor parameters', () => {
  const request = searchChatsRequest(org, 'unicode café & work');
  const url = new URL(request.url);
  assert.equal(url.pathname, `/api/organizations/${org}/conversation/search/v2`);
  assert.deepEqual([...url.searchParams], [['query', 'unicode café & work'], ['n', '10']]);
});

test('open requests full nested messages and omits a response byte cap by default', () => {
  const url = new URL(openChatRequest(org, chat).url);
  assert.deepEqual([...url.searchParams], [['rendering_mode', 'messages'], ['render_all_mobile_tools', 'true'], ['include_extracted_content', 'false']]);
  const capped = new URL(openChatRequest(org, chat, { returnDanglingHumanMessage: true, maxResponseBytes: 10000 }).url);
  assert.equal(capped.searchParams.get('return_dangling_human_message'), 'true');
  assert.equal(capped.searchParams.get('max_response_bytes'), '10000');
  assert.throws(() => openChatRequest(org, '../account'), /UUID/);
});

test('account bootstrap extracts explicit memberships and keeps organization selection separate', () => {
  const account = parseAccountResponse({ uuid: one, email_address: 'test@example.invalid', full_name: 'Test', memberships: [
    { organization: { uuid: org, name: 'Personal', capabilities: ['chat'], plan_display_name: 'Pro' }, role: 'owner' },
    { organization: { uuid: chat, name: 'Team', capabilities: ['chat'] }, role: 'member' },
  ] });
  assert.equal(account.id, one);
  assert.equal(account.organizations.length, 2);
  assert.equal(account.organizations[0].id, org);
  assert.equal(account.organizations[0].plan, 'Pro');
  assert.throws(() => parseAccountResponse({ uuid: one }), /memberships/);
});

test('recents preserves independent section cursors, deduplicates chats and reports degradation', () => {
  const result = parseChatsPage({ sections: [
    { id: 'starred', title: 'Starred', data: [{ ...summary, type: 'chat', is_starred: true }], next_cursor: null },
    { id: 'recents', title: 'Recent', data: [{ ...summary, type: 'chat' }, { type: 'future_kind', opaque: { x: 1 } }], next_cursor: 'opaque-cursor' },
  ], degraded_surfaces: ['chat'], incomplete_surfaces: [] });
  assert.equal(result.chats.length, 1);
  assert.equal(result.chats[0].starred, true);
  assert.deepEqual(result.pagination.continuations, [{ section: 'recents', cursor: 'opaque-cursor' }]);
  assert.equal(result.sections[1].otherRows[0].type, 'future_kind');
  assert.equal(result.complete, false);
  assert.deepEqual(result.degradedSurfaces, ['chat']);
  assert.equal(parseChatsPage({ sections: [{ id: 'recents', data: [], next_cursor: null }] }).complete, true);
  assert.throws(() => parseChatsPage({ sections: [{ id: 'recents' }] }), /Section data/);
});

test('search preserves structured snippets and acknowledges unsupported native continuation', () => {
  const result = parseSearchResults({ data: [{ conversation: summary, matched_snippet: { text: 'A match', highlights: [[2, 5]] }, title_matches: [0] }], next_page_token: 'next', search_id: 'search-1', executed_mode: 'lexical' });
  assert.equal(result.hits[0].chat.id, chat);
  assert.equal(result.hits[0].matchedSnippet.text, 'A match');
  assert.equal(result.pagination.nextPageToken, 'next');
  assert.equal(result.pagination.continuationSupported, false);
});

test('chat read keeps all branches and rich unknown block structures without flattening', () => {
  const payload = { ...summary, current_leaf_message_uuid: two, chat_messages: [
    { uuid: one, parent_message_uuid: ROOT_MESSAGE_ID, sender: 'human', text: 'Question', content: [{ type: 'text', text: 'Question' }] },
    { uuid: two, parent_message_uuid: one, sender: 'assistant', content: [{ type: 'future_tool', payload: { value: 42 } }], files: [{ uuid: 'file' }] },
    { uuid: alt, parent_message_uuid: one, sender: 'assistant', text: 'Alternative answer' },
  ] };
  const result = parseChatResponse(payload, { expectedChatId: chat });
  assert.equal(result.messages.length, 3);
  assert.deepEqual(result.branches.activeMessageIds, [one, two]);
  assert.deepEqual(result.branches.leafMessageIds, [two, alt]);
  assert.equal(result.branches.activePathComplete, true);
  assert.equal(result.messages[1].content[0].payload.value, 42);
  payload.chat_messages[1].content[0].payload.value = 0;
  assert.equal(result.messages[1].content[0].payload.value, 42);
});

test('missing branch ancestry is visible and inconsistent chat identities or cycles fail', () => {
  const partial = parseChatResponse({ ...summary, current_leaf_message_uuid: two, chat_messages: [{ uuid: two, parent_message_uuid: one }] });
  assert.equal(partial.branches.activePathComplete, false);
  assert.throws(() => parseChatResponse({ ...summary, chat_messages: [] }, { expectedChatId: one }), /does not match/);
  assert.throws(() => parseChatResponse({ ...summary, current_leaf_message_uuid: one, chat_messages: [{ uuid: one, parent_message_uuid: one }] }), /cycle/);
  assert.throws(() => parseChatResponse({ ...summary, chat_messages: [{ uuid: one }, { uuid: one }] }), /duplicate/);
});
