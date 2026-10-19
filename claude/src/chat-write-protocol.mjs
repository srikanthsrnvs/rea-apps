import { ClaudeError } from './errors.mjs';

// Native SseConversationStore's first-message parent, not the all-zero UUID.
export const ROOT_MESSAGE_UUID = '00000000-0000-4000-8000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new ClaudeError('INVALID_ARGUMENT', `${label} must be a UUID.`);
  }
  return value.toLowerCase();
}

function shortString(value, label, max = 256) {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ClaudeError('INVALID_ARGUMENT', `${label} is invalid.`);
  }
  return value;
}

function path(organizationId, chatId) {
  return `https://claude.ai/api/organizations/${uuid(organizationId, 'Organization ID')}/chat_conversations/${uuid(chatId, 'Chat ID')}`;
}

export function selectReplyParent(conversation, { parentMessageId } = {}) {
  if (!conversation || !Array.isArray(conversation.messages)) {
    throw new ClaudeError('CONVERSATION_REQUIRED', 'Read the conversation before selecting a reply parent.');
  }
  const ids = new Set(conversation.messages.map(message => uuid(message.id, 'Message ID')));
  if (ids.size !== conversation.messages.length) {
    throw new ClaudeError('INVALID_CONVERSATION', 'The conversation contains duplicate message IDs.');
  }
  const selected = parentMessageId ?? conversation.currentLeafMessageId;
  if (selected == null && ids.size === 0) return ROOT_MESSAGE_UUID;
  if (selected == null) {
    throw new ClaudeError('PARENT_REQUIRED', 'The conversation has no current leaf; choose a parent message explicitly.');
  }
  const normalized = uuid(selected, 'Parent message ID');
  if (normalized === ROOT_MESSAGE_UUID) {
    if (ids.size === 0 || parentMessageId != null) return normalized;
    throw new ClaudeError('INVALID_CONVERSATION', 'The current leaf points to the root of a nonempty conversation.');
  }
  if (!ids.has(normalized)) {
    throw new ClaudeError('PARENT_NOT_FOUND', 'The selected parent is not present in the retrieved conversation.');
  }
  return normalized;
}

export function createConversationParameters({ chatId, name = '', model, projectId, temporary = false } = {}) {
  if (typeof name !== 'string' || name.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(name)) {
    throw new ClaudeError('INVALID_ARGUMENT', 'Chat name is invalid.');
  }
  if (typeof temporary !== 'boolean') throw new ClaudeError('INVALID_ARGUMENT', 'Temporary must be a boolean.');
  const json = { uuid: uuid(chatId, 'Chat ID'), name, include_conversation_preferences: true };
  if (model != null) json.model = shortString(model, 'Model');
  if (projectId != null) json.project_uuid = uuid(projectId, 'Project ID');
  if (temporary) json.is_temporary = true;
  return json;
}

/** IDs must be persisted by the caller before sending. This function never retries. */
export function buildCompletionRequest({
  organizationId, chatId, prompt, parentMessageId, timezone, model,
  completionRequestId, humanMessageId, assistantMessageId,
  bard = false, retry = false, create, effort, thinkingMode,
} = {}) {
  if (typeof prompt !== 'string' || (!retry && !prompt.trim()) || prompt.includes('\u0000')) {
    throw new ClaudeError('INVALID_ARGUMENT', 'A nonempty text prompt is required.');
  }
  if (Buffer.byteLength(prompt, 'utf8') > 1024 * 1024) {
    throw new ClaudeError('INVALID_ARGUMENT', 'The prompt exceeds the CLI limit of 1 MiB.');
  }
  if (typeof bard !== 'boolean' || typeof retry !== 'boolean') {
    throw new ClaudeError('INVALID_ARGUMENT', 'Completion mode flags must be booleans.');
  }
  shortString(timezone, 'Timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw new ClaudeError('INVALID_ARGUMENT', 'Timezone must be a valid IANA timezone.'); }
  const parent = uuid(parentMessageId, 'Parent message ID');
  const requestId = uuid(completionRequestId, 'Completion request ID');
  const assistantId = uuid(assistantMessageId, 'Assistant message ID');
  const turnIds = { assistant_message_uuid: assistantId };
  if (!retry || humanMessageId != null) turnIds.human_message_uuid = uuid(humanMessageId, 'Human message ID');
  const allIds = [requestId, assistantId, turnIds.human_message_uuid].filter(Boolean);
  if (new Set(allIds).size !== allIds.length || allIds.includes(parent)) {
    throw new ClaudeError('INVALID_ARGUMENT', 'New request and message IDs must be distinct from one another and the parent.');
  }
  const json = {
    prompt, timezone, rendering_mode: 'messages', input_mode: retry ? 'retry' : 'text',
    tools: [], parent_message_uuid: parent,
    completion_request_id: requestId, turn_message_uuids: turnIds,
  };
  // Omission preserves the server/account default instead of hardcoding a model.
  if (model != null) json.model = shortString(model, 'Model');
  if (effort != null) json.effort = shortString(effort, 'Effort');
  if (thinkingMode != null) json.thinking_mode = shortString(thinkingMode, 'Thinking mode');
  if (create != null) {
    if (retry || parent !== ROOT_MESSAGE_UUID) {
      throw new ClaudeError('INVALID_ARGUMENT', 'A new conversation must start at the root and cannot retry.');
    }
    const created = createConversationParameters({ ...create, chatId });
    if (model != null && created.model != null && model !== created.model) {
      throw new ClaudeError('INVALID_ARGUMENT', 'Conversation and completion models disagree.');
    }
    if (model != null && created.model == null) created.model = model;
    json.create_conversation_params = created;
  }
  return {
    url: `${path(organizationId, chatId)}/${retry ? 'retry_completion' : 'completion'}${bard ? '2' : ''}`,
    method: 'POST', headers: { accept: 'text/event-stream' }, json,
  };
}

export function buildStopRequest({ organizationId, chatId, completionRequestId } = {}) {
  return {
    url: `${path(organizationId, chatId)}/stop_response`, method: 'POST',
    json: { completion_request_id: uuid(completionRequestId, 'Completion request ID') },
  };
}
