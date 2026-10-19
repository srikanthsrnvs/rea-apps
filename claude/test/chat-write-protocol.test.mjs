import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOT_MESSAGE_UUID, buildCompletionRequest, buildStopRequest, createConversationParameters, selectReplyParent } from '../src/chat-write-protocol.mjs';

const org = '11111111-1111-4111-8111-111111111111';
const chat = '22222222-2222-4222-8222-222222222222';
const parent = '33333333-3333-4333-8333-333333333333';
const request = '44444444-4444-4444-8444-444444444444';
const human = '55555555-5555-4555-8555-555555555555';
const assistant = '66666666-6666-4666-8666-666666666666';
const defaults = {
  organizationId: org, chatId: chat, parentMessageId: parent,
  completionRequestId: request, humanMessageId: human, assistantMessageId: assistant,
  prompt: 'Explain a solar eclipse.', timezone: 'America/Los_Angeles',
};

test('a reply preserves branch parent and journalled message IDs without hardcoded model', () => {
  const result = buildCompletionRequest(defaults);
  assert.equal(result.url, `https://claude.ai/api/organizations/${org}/chat_conversations/${chat}/completion`);
  assert.equal(result.method, 'POST');
  assert.equal(result.headers.accept, 'text/event-stream');
  assert.equal(result.json.parent_message_uuid, parent);
  assert.equal(result.json.completion_request_id, request);
  assert.deepEqual(result.json.turn_message_uuids, { assistant_message_uuid: assistant, human_message_uuid: human });
  assert.equal(result.json.input_mode, 'text');
  assert.equal(result.json.rendering_mode, 'messages');
  assert.deepEqual(result.json.tools, []);
  assert.ok(!('model' in result.json));
});

test('first completion creates the chat atomically using native root and embedded parameters', () => {
  const result = buildCompletionRequest({ ...defaults, parentMessageId: ROOT_MESSAGE_UUID, create: { name: 'Sky', temporary: true, model: 'account-model' } });
  assert.deepEqual(result.json.create_conversation_params, { uuid: chat, name: 'Sky', include_conversation_preferences: true, is_temporary: true, model: 'account-model' });
  assert.throws(() => buildCompletionRequest({ ...defaults, create: {} }), { code: 'INVALID_ARGUMENT' });
});

test('endpoint feature selection and retry are explicit rather than automatic fallback', () => {
  const result = buildCompletionRequest({ ...defaults, bard: true, retry: true, humanMessageId: undefined, prompt: '' });
  assert.ok(result.url.endsWith('/retry_completion2'));
  assert.equal(result.json.input_mode, 'retry');
  assert.deepEqual(result.json.turn_message_uuids, { assistant_message_uuid: assistant });
});

test('invalid identifiers, duplicate new IDs and timezones fail before any network', () => {
  for (const override of [
    { chatId: '../other' }, { parentMessageId: undefined }, { timezone: 'arbitrary' },
    { assistantMessageId: human }, { completionRequestId: parent }, { prompt: '\u0000' },
    { prompt: '  ' }, { humanMessageId: undefined }, { bard: 'false' },
  ]) assert.throws(() => buildCompletionRequest({ ...defaults, ...override }), { code: 'INVALID_ARGUMENT' });
});

test('selection uses the server leaf even when a different branch is last in the array', () => {
  const conversation = { currentLeafMessageId: parent, messages: [{ id: parent }, { id: human }] };
  assert.equal(selectReplyParent(conversation), parent);
  assert.equal(selectReplyParent(conversation, { parentMessageId: human }), human);
  assert.throws(() => selectReplyParent(conversation, { parentMessageId: assistant }), { code: 'PARENT_NOT_FOUND' });
});

test('missing leaf does not silently choose a branch; truly empty chat uses native root', () => {
  assert.throws(() => selectReplyParent({ messages: [{ id: parent }, { id: human }] }), { code: 'PARENT_REQUIRED' });
  assert.equal(selectReplyParent({ messages: [] }), ROOT_MESSAGE_UUID);
  assert.throws(() => selectReplyParent({ currentLeafMessageId: ROOT_MESSAGE_UUID, messages: [{ id: human }] }), { code: 'INVALID_CONVERSATION' });
});

test('stop targets a specific completion and new-chat parameters keep explicit project', () => {
  assert.deepEqual(buildStopRequest({ organizationId: org, chatId: chat, completionRequestId: request }), {
    url: `https://claude.ai/api/organizations/${org}/chat_conversations/${chat}/stop_response`, method: 'POST', json: { completion_request_id: request },
  });
  assert.deepEqual(createConversationParameters({ chatId: chat, projectId: org }), { uuid: chat, name: '', include_conversation_preferences: true, project_uuid: org });
});
