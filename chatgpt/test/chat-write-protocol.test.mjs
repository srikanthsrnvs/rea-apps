import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chatMessageRequest, chatStopRequest, applyJsonDelta,
  initialConversationStreamState, reduceConversationStream,
  reconcileConversationTurn,
} from '../src/chat-write-protocol.mjs';

const build = (extra = {}) => chatMessageRequest({ messageId: 'user-message', parentMessageId: 'root', text: 'hello', model: 'model-from-account', ...extra });
const frame = (event, value) => ({ event, data: JSON.stringify(value) });

test('basic new and existing conversation writes use one native endpoint', () => {
  const fresh = build({ createTime: 123.5, timezone: 'America/Los_Angeles', timezoneOffsetMin: 420 });
  assert.equal(fresh.path, 'f/conversation');
  assert.equal(fresh.method, 'POST');
  assert.deepEqual(fresh.body.messages, [{ id: 'user-message', author: { role: 'user' }, content: { content_type: 'text', parts: ['hello'] }, create_time: 123.5 }]);
  assert.equal(fresh.body.conversation_id, null);
  assert.equal(fresh.body.parent_message_id, 'root');
  assert.equal(fresh.body.action, 'next');
  assert.equal(fresh.body.stream, true);
  assert.deepEqual(fresh.body.supported_encodings, ['v1']);
  assert.equal(build({ conversationId: 'existing-chat' }).body.conversation_id, 'existing-chat');
  assert.deepEqual(chatStopRequest('existing-chat'), { method: 'POST', path: 'stop_conversation', body: { conversation_id: 'existing-chat' } });
});

test('write validation occurs before a request can be sent', () => {
  assert.throws(() => build({ messageId: 'root' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => build({ text: '' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => build({ model: undefined }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => build({ conversationId: '../../other' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => build({ timezoneOffsetMin: Infinity }), { code: 'INVALID_ARGUMENT' });
});

test('native JSON delta operations preserve immutable state and replace array slots', () => {
  const original = { values: ['first', 'second'], metadata: { title: 'abc' } };
  const added = applyJsonDelta(original, { op: 'add', path: '/values/1', value: 'replacement' });
  assert.deepEqual(added.values, ['first', 'replacement']);
  assert.deepEqual(original.values, ['first', 'second']);
  const appended = applyJsonDelta(added, { o: 'append', p: '/values', v: ['third'] });
  assert.deepEqual(appended.values, ['first', 'replacement', 'third']);
  const truncated = applyJsonDelta(appended, { op: 'truncate', path: '/metadata/title', value: 2 });
  assert.equal(truncated.metadata.title, 'ab');
  assert.deepEqual(applyJsonDelta(truncated, { op: 'remove', path: '/values/0' }).values, ['replacement', 'third']);
  assert.deepEqual(applyJsonDelta({}, { op: 'replace', path: '/new/2/name', value: 'new item' }), { new: [null, null, { name: 'new item' }] });
});

test('nested patches, pointer escaping, null values, and bounds are explicit', () => {
  const value = applyJsonDelta({ nested: { 'slash/name': 'old' } }, { op: 'patch', path: '/nested', value: [
    { op: 'replace', path: '/slash~1name', value: null },
    { op: 'add', path: '/tilde~0name', value: 'ok' },
  ] });
  assert.deepEqual(value.nested, { 'slash/name': null, 'tilde~name': 'ok' });
  assert.throws(() => applyJsonDelta({}, { op: 'remove', path: '' }), { code: 'INVALID_DELTA' });
  assert.throws(() => applyJsonDelta({}, { op: 'replace', path: '/999999999', value: true }), { code: 'DELTA_TOO_LARGE' });
  assert.throws(() => applyJsonDelta({ title: 'a' }, { op: 'truncate', path: '/title', value: 2 }), { code: 'INVALID_DELTA' });
  const prototypeKey = applyJsonDelta({}, { op: 'replace', path: '/__proto__/polluted', value: true });
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.hasOwn(prototypeKey, '__proto__'), true);
});

test('compact v1 deltas inherit previous fields while retaining separate channels', () => {
  const initial = initialConversationStreamState();
  let state = reduceConversationStream(initial, frame('delta_encoding', 'v1'));
  state = reduceConversationStream(state, frame('delta', { o: 'add', p: '', c: 0, v: { conversation_id: 'chat', message: { id: 'assistant-1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Hi'] } } } }));
  state = reduceConversationStream(state, frame('delta', { o: 'append', p: '/message/content/parts/0', v: ' there' }));
  state = reduceConversationStream(state, frame('delta', { v: '!' }));
  assert.equal(state.messages['assistant-1'].content.parts[0], 'Hi there!');
  state = reduceConversationStream(state, frame('delta', { o: 'replace', p: '', c: 1, v: { conversation_id: 'chat', type: 'main_stream_complete', alternate_response_expected: false } }));
  assert.equal(state.main_stream_complete, true);
  assert.equal(state.channels['0'].message.content.parts[0], 'Hi there!');
  assert.equal(initial.events_seen, 0);
  assert.deepEqual(initial.channels, {});
  assert.throws(() => reduceConversationStream(state, frame('delta', { o: 'move', p: '/' })), { code: 'INVALID_DELTA' });
});

test('stream transport completion is not confused with completed generation', () => {
  let state = initialConversationStreamState();
  state = reduceConversationStream(state, { event: 'message', data: '[DONE]' });
  assert.equal(state.transport_done, true);
  assert.equal(state.main_stream_complete, false);
  state = reduceConversationStream(state, frame('message', { type: 'message_stream_complete', conversation_id: 'chat' }));
  assert.equal(state.message_stream_complete, true);
  assert.equal(state.main_stream_complete, false);
  assert.throws(() => reduceConversationStream(state, frame('message', { conversation_id: 'different' })), { code: 'STREAM_ID_MISMATCH' });
  const unknown = reduceConversationStream(state, frame('message', { type: 'future_metadata', payload: { keep: 'this' } }));
  assert.deepEqual(unknown.last_event.payload, { keep: 'this' });
});

test('independent server graph confirms the exact submitted message and terminal branch', () => {
  const request = build({ conversationId: 'chat' });
  const conversation = { id: 'chat', current_node: 'answer', mapping: {
    root: { parent: null, message: null },
    question: { parent: 'root', message: { ...request.body.messages[0], status: 'finished_successfully' } },
    answer: { parent: 'question', message: { id: 'assistant', author: { role: 'assistant' }, end_turn: true, status: 'finished_successfully', content: { parts: ['Hello.'] } } },
  } };
  const result = reconcileConversationTurn({ request, stream: initialConversationStreamState(), conversation });
  assert.equal(result.confirmed, true);
  assert.equal(result.completed, true);
  assert.equal(result.terminal_message_id, 'assistant');
  assert.equal(result.assistant_messages[0], conversation.mapping.answer.message);
  const changed = structuredClone(conversation);
  changed.mapping.question.message.content.parts = ['Different text'];
  assert.equal(reconcileConversationTurn({ request, conversation: changed }).reason, 'submitted_message_mismatch');
  const partial = structuredClone(conversation);
  partial.mapping.answer.message.status = 'finished_partial_completion';
  assert.equal(reconcileConversationTurn({ request, conversation: partial }).completed, false);
  assert.equal(reconcileConversationTurn({ request, conversation: partial }).terminal, true);
  assert.equal(reconcileConversationTurn({ request, conversation: partial }).reason, 'server_message_partial');
});

test('uncertain, alternate, and unfinished turns cannot become success from an SSE marker', () => {
  const request = build({ conversationId: 'chat' });
  const conversation = { id: 'chat', current_node: 'root', mapping: { root: { parent: null, message: null } } };
  const stream = { ...initialConversationStreamState(), main_stream_complete: true };
  assert.equal(reconcileConversationTurn({ request, stream, conversation }).confirmed, false);
  conversation.mapping.question = { parent: 'root', message: request.body.messages[0] };
  assert.equal(reconcileConversationTurn({ request, stream, conversation }).reason, 'submitted_message_on_another_branch');
  conversation.current_node = 'question';
  assert.equal(reconcileConversationTurn({ request, stream, conversation }).completed, false);
  conversation.id = 'other-chat';
  assert.throws(() => reconcileConversationTurn({ request, stream, conversation }), { code: 'STREAM_ID_MISMATCH' });
});

test('native active pages reconcile explicit parent links without requiring full history', () => {
  const request = build({ conversationId: 'chat' });
  const final = { id: 'reply', author: { role: 'assistant' }, channel: 'final', metadata: { parent_id: 'tool' }, content: { parts: ['Example reply'] }, end_turn: true, status: 'finished_successfully' };
  const conversation = {
    conversation_id: 'chat', current_node: 'reply',
    page_info: { has_previous_page: true, has_next_page: false },
    messages: [request.body.messages[0],
      { id: 'aux', author: { role: 'assistant' }, channel: 'analysis' },
      { id: 'tool', author: { role: 'tool' }, metadata: { parent_id: 'user-message' } }, final],
  };
  const result = reconcileConversationTurn({ request, conversation });
  assert.equal(result.source, 'native_page');
  assert.equal(result.confirmed, true);
  assert.equal(result.completed, true);
  assert.equal(result.relation_evidence, 'explicit_parent_chain');
  assert.deepEqual(result.assistant_messages, [final]);
  assert.equal(conversation.mapping, undefined);
});

test('native active page order can establish a turn when optional parent IDs are omitted', () => {
  const request = build({ conversationId: 'chat' });
  const final = { id: 'reply', author: { role: 'assistant' }, content: { parts: ['Example reply'] }, end_turn: true, status: 'finished_successfully' };
  const conversation = { conversation_id: 'chat', current_node: 'reply', messages: [request.body.messages[0], { id: 'tool', author: { role: 'tool' } }, final], page_info: { has_previous_page: false, has_next_page: false } };
  const result = reconcileConversationTurn({ request, conversation });
  assert.equal(result.completed, true);
  assert.equal(result.relation_evidence, 'native_active_page_order');
  final.status = 'finished_partial_completion';
  const partial = reconcileConversationTurn({ request, conversation });
  assert.equal(partial.completed, false);
  assert.equal(partial.terminal, true);
  assert.equal(partial.reason, 'server_message_partial');
});

test('native page gaps, conflicting parent IDs, and a later user turn never confirm success', () => {
  const request = build({ conversationId: 'chat' });
  const final = { id: 'reply', author: { role: 'assistant' }, content: { parts: ['Example reply'] }, end_turn: true, status: 'finished_successfully', metadata: { parent_id: 'old-message' } };
  const conversation = { conversation_id: 'chat', current_node: 'reply', messages: [{ id: 'old-message', author: { role: 'user' } }, request.body.messages[0], final], page_info: { has_previous_page: true, has_next_page: false } };
  assert.equal(reconcileConversationTurn({ request, conversation }).reason, 'contradictory_parent_chain');
  delete final.metadata;
  conversation.current_node = 'not-on-this-page';
  assert.equal(reconcileConversationTurn({ request, conversation }).reason, 'current_node_not_in_page');
  conversation.current_node = 'reply';
  conversation.page_info.has_next_page = true;
  assert.equal(reconcileConversationTurn({ request, conversation }).reason, 'active_page_end_not_confirmed');
  conversation.page_info.has_next_page = false;
  conversation.messages.splice(2, 0, { id: 'another-user', author: { role: 'user' } });
  assert.equal(reconcileConversationTurn({ request, conversation }).reason, 'another_user_turn_follows');
  conversation.messages.splice(2, 1);
  conversation.messages[1] = { ...request.body.messages[0], content: { parts: ['Other input'] } };
  assert.equal(reconcileConversationTurn({ request, conversation }).reason, 'submitted_message_mismatch');
});
