import { ChatGptError } from './errors.mjs';
import { conversationBranch, parseConversation } from './chat-read-protocol.mjs';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const operations = new Set(['add', 'remove', 'replace', 'append', 'truncate', 'patch']);

function fail(code, message) { throw new ChatGptError(code, message); }
function id(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) fail('INVALID_ARGUMENT', `${name} must be a nonempty identifier without path separators.`);
  return value;
}

export function chatMessageRequest({ conversationId = null, parentMessageId, messageId, text, model, createTime, timezone, timezoneOffsetMin, historyAndTrainingDisabled = false } = {}) {
  if (conversationId !== null) id(conversationId, 'conversationId');
  id(parentMessageId, 'parentMessageId');
  id(messageId, 'messageId');
  if (messageId === parentMessageId) fail('INVALID_ARGUMENT', 'The message and its parent must have different IDs.');
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 1024 * 1024) fail('INVALID_ARGUMENT', 'text must contain 1 to 1048576 UTF-8 bytes.');
  if (typeof model !== 'string' || !model || /[\u0000-\u001f\u007f]/.test(model)) fail('INVALID_ARGUMENT', 'model must be a model identifier supplied by the account.');
  if (createTime !== undefined && (!Number.isFinite(createTime) || createTime < 0)) fail('INVALID_ARGUMENT', 'createTime must be Unix seconds.');
  if (timezone !== undefined && (typeof timezone !== 'string' || !timezone || /[\u0000-\u001f\u007f]/.test(timezone))) fail('INVALID_ARGUMENT', 'timezone must be a nonempty timezone name.');
  if (timezoneOffsetMin !== undefined && (!Number.isInteger(timezoneOffsetMin) || Math.abs(timezoneOffsetMin) > 1440)) fail('INVALID_ARGUMENT', 'timezoneOffsetMin must be an integer within one day.');
  if (typeof historyAndTrainingDisabled !== 'boolean') fail('INVALID_ARGUMENT', 'historyAndTrainingDisabled must be a boolean.');
  return {
    method: 'POST', path: 'f/conversation',
    body: {
      conversation_id: conversationId, action: 'next', parent_message_id: parentMessageId,
      messages: [{
        id: messageId, author: { role: 'user' },
        content: { content_type: 'text', parts: [text] },
        ...(createTime === undefined ? {} : { create_time: createTime }),
      }],
      model, history_and_training_disabled: historyAndTrainingDisabled,
      supported_encodings: ['v1'], stream: true,
      ...(timezone === undefined ? {} : { timezone }),
      ...(timezoneOffsetMin === undefined ? {} : { timezone_offset_min: timezoneOffsetMin }),
    },
  };
}

export function chatStopRequest(conversationId) {
  return { method: 'POST', path: 'stop_conversation', body: { conversation_id: id(conversationId, 'conversationId') } };
}

function pointer(path, maxDepth) {
  if (typeof path !== 'string') fail('INVALID_DELTA', 'A delta operation has no path.');
  if (path === '' || path === '/') return [];
  const parts = (path.startsWith('/') ? path.slice(1) : path).split('/').map(value => {
    const decoded = value.replaceAll('~1', '/').replaceAll('~0', '~');
    if (/^[+-]?\d+$/.test(decoded)) {
      const number = Number(decoded);
      if (!Number.isSafeInteger(number) || number < 0) fail('INVALID_DELTA', 'A delta array index is invalid.');
      return number;
    }
    return decoded;
  });
  if (parts.length > maxDepth) fail('DELTA_TOO_LARGE', 'A delta path is too deeply nested.');
  return parts;
}

function getAt(document, parts) {
  let value = document;
  for (const part of parts) {
    if (typeof part === 'number' ? !Array.isArray(value) || part >= value.length : !object(value) || !own(value, part)) {
      fail('INVALID_DELTA', 'A delta operation refers to a missing value.');
    }
    value = value[part];
  }
  return value;
}

function setAt(document, parts, value, limits, depth = 0) {
  if (depth === parts.length) return value;
  const key = parts[depth];
  if (typeof key === 'number') {
    if (key >= limits.maxArrayLength) fail('DELTA_TOO_LARGE', 'A delta array index exceeds the configured limit.');
    const result = Array.isArray(document) ? document.slice() : [];
    while (result.length <= key) result.push(null);
    result[key] = setAt(result[key], parts, value, limits, depth + 1);
    return result;
  }
  const result = object(document) ? { ...document } : {};
  // A computed own property keeps JSON keys such as __proto__ as data.
  return { ...result, [key]: setAt(own(result, key) ? result[key] : undefined, parts, value, limits, depth + 1) };
}

function removeAt(document, parts, depth = 0) {
  if (depth === parts.length) fail('INVALID_DELTA', 'The root of a delta document cannot be removed.');
  const key = parts[depth];
  const array = typeof key === 'number';
  if (array ? !Array.isArray(document) || key >= document.length : !object(document) || !own(document, key)) {
    fail('INVALID_DELTA', 'A delta remove operation refers to a missing value.');
  }
  const result = array ? document.slice() : { ...document };
  if (depth === parts.length - 1) {
    if (array) result.splice(key, 1);
    else delete result[key];
  } else {
    result[key] = removeAt(result[key], parts, depth + 1);
  }
  return result;
}

function patchFields(input, previous = {}) {
  if (!object(input)) fail('INVALID_DELTA', 'A delta operation must be an object.');
  const result = { ...previous };
  for (const [short, long] of [['o', 'op'], ['p', 'path'], ['v', 'value'], ['f', 'from'], ['c', 'channel']]) {
    if (own(input, short)) result[long] = input[short];
    else if (own(input, long)) result[long] = input[long];
  }
  if (result.op !== undefined && result.op !== null) {
    if (typeof result.op !== 'string' || !operations.has(result.op.toLowerCase())) fail('INVALID_DELTA', 'The server sent an unknown delta operation.');
    result.op = result.op.toLowerCase();
  }
  return result;
}

function applyOperation(document, patch, limits, depth = 0) {
  if (depth > limits.maxDepth) fail('DELTA_TOO_LARGE', 'A nested delta patch is too deep.');
  const op = patch.op;
  if (!operations.has(op)) fail('INVALID_DELTA', 'A delta operation is missing.');
  const path = pointer(patch.path ?? (op === 'patch' ? '' : undefined), limits.maxDepth);
  if (op === 'remove') return removeAt(document, path);
  if (!own(patch, 'value')) fail('INVALID_DELTA', 'A delta operation is missing its value.');
  const value = patch.value;
  if (op === 'add' || op === 'replace') return setAt(document, path, clone(value), limits);
  if (op === 'truncate') {
    const current = getAt(document, path);
    if (!Number.isInteger(value) || value < 0 || !(typeof current === 'string' || Array.isArray(current)) || value > current.length) {
      fail('INVALID_DELTA', 'A delta truncate operation has an invalid length or target.');
    }
    return setAt(document, path, current.slice(0, value), limits);
  }
  if (op === 'patch') {
    const patches = Array.isArray(value) ? value : object(value) ? [value] : null;
    if (!patches || patches.length > limits.maxOperations) fail('INVALID_DELTA', 'A nested patch must contain a bounded array of operations or one operation.');
    let result = getAt(document, path);
    for (const nested of patches) result = applyOperation(result, patchFields(nested), limits, depth + 1);
    return setAt(document, path, result, limits);
  }
  let current;
  try { current = getAt(document, path); }
  catch (error) {
    if (!(error instanceof ChatGptError) || error.code !== 'INVALID_DELTA') throw error;
    current = Array.isArray(value) ? [] : object(value) ? {} : '';
  }
  let result;
  if (typeof current === 'string' && typeof value === 'string') result = current + value;
  else if (Array.isArray(current)) result = current.concat(Array.isArray(value) ? clone(value) : [clone(value)]);
  else if (object(current) && object(value)) result = { ...current, ...clone(value) };
  else if (current !== null && value !== null && !object(current) && !object(value) && !Array.isArray(current) && !Array.isArray(value) && typeof current === typeof value) result = String(current) + String(value);
  else fail('INVALID_DELTA', 'A delta append operation has incompatible values.');
  if (Array.isArray(result) && result.length > limits.maxArrayLength) fail('DELTA_TOO_LARGE', 'A delta array exceeds the configured limit.');
  if (typeof result === 'string' && Buffer.byteLength(result) > limits.maxStringBytes) fail('DELTA_TOO_LARGE', 'A delta string exceeds the configured limit.');
  return setAt(document, path, result, limits);
}

const defaults = { maxDepth: 128, maxArrayLength: 100000, maxStringBytes: 8 * 1024 * 1024, maxOperations: 10000 };

/** The Android v1 patch protocol replaces array elements for ADD as well as REPLACE. */
export function applyJsonDelta(document, input, options = {}) {
  return applyOperation(document, patchFields(input), { ...defaults, ...options });
}

export function initialConversationStreamState() {
  return { encoding: null, previous_patch: {}, channels: {}, conversation_id: null, messages: {}, message_order: [], main_stream_complete: false, message_stream_complete: false, error: null, events_seen: 0, last_event: null };
}

function observeData(state, data) {
  if (!object(data)) return state;
  const next = { ...state, last_event: data };
  if (typeof data.conversation_id === 'string' && data.conversation_id) {
    if (next.conversation_id && next.conversation_id !== data.conversation_id) fail('STREAM_ID_MISMATCH', 'The stream changed conversation IDs.');
    next.conversation_id = data.conversation_id;
  }
  if (data.error !== null && data.error !== undefined) next.error = clone(data.error);
  if (data.type === 'main_stream_complete') {
    next.main_stream_complete = true;
    next.alternate_response_expected = data.alternate_response_expected ?? null;
    next.turn_exchange_id = data.turn_exchange_id ?? null;
  }
  if (data.type === 'message_stream_complete') next.message_stream_complete = true;
  if (object(data.message) && typeof data.message.id === 'string' && data.message.id) {
    const key = data.message.id;
    next.messages = { ...next.messages, [key]: clone(data.message) };
    if (!own(state.messages, key)) next.message_order = [...state.message_order, key];
  }
  return next;
}

export function reduceConversationStream(state, frame, options = {}) {
  if (!object(state) || !object(frame) || typeof frame.data !== 'string') fail('INVALID_STREAM', 'Expected stream state and an SSE data frame.');
  let next = { ...state, events_seen: state.events_seen + 1 };
  if (frame.event === 'delta_encoding') {
    const encoding = frame.data.replace(/^"|"$/g, '');
    if (encoding !== 'v1') fail('UNSUPPORTED_STREAM_ENCODING', `Unsupported stream encoding: ${encoding}`);
    return { ...next, encoding };
  }
  if (frame.data === '[DONE]') return { ...next, transport_done: true };
  let data;
  try { data = JSON.parse(frame.data); }
  catch { fail('INVALID_STREAM', 'An SSE data frame is not valid JSON.'); }
  if (frame.event === 'delta' && state.encoding === 'v1') {
    const patch = patchFields(data, state.previous_patch);
    const channel = patch.channel ?? 0;
    if (!Number.isInteger(channel) || channel < 0 || channel > 1024) fail('INVALID_DELTA', 'A delta channel is invalid.');
    const key = String(channel);
    const current = own(state.channels, key) ? state.channels[key] : {};
    const document = applyOperation(current, patch, { ...defaults, ...options });
    next = { ...next, previous_patch: patch, channels: { ...state.channels, [key]: document } };
    return observeData(next, document);
  }
  return observeData(next, data);
}

export function messageText(message) {
  return Array.isArray(message?.content?.parts) ? message.content.parts.filter(part => typeof part === 'string').join('') : '';
}

function visibleAssistantReply(message) {
  return message.author?.role === 'assistant'
    && (message.channel === undefined || message.channel === null || message.channel === 'final')
    && message.metadata?.is_visually_hidden_from_conversation !== true;
}

function nativeParentEvidence(messages, candidateIndex, submittedIndex) {
  const positions = new Map(messages.map((message, index) => [message.id, index]));
  const visited = new Set();
  let index = candidateIndex;
  while (index !== submittedIndex) {
    if (visited.has(index)) return 'contradictory_parent_chain';
    visited.add(index);
    const message = messages[index];
    if (!object(message.metadata) || !own(message.metadata, 'parent_id')) return 'native_active_page_order';
    const parent = message.metadata.parent_id;
    if (parent === null) return 'contradictory_parent_chain';
    if (typeof parent !== 'string') return 'contradictory_parent_chain';
    const parentIndex = positions.get(parent);
    if (parentIndex === undefined) return 'native_active_page_order';
    if (parentIndex < submittedIndex || parentIndex >= index) return 'contradictory_parent_chain';
    index = parentIndex;
  }
  return 'explicit_parent_chain';
}

function reconcileNativePage(submitted, conversation, conversationId) {
  const branch = parseConversation(conversation).current_branch;
  const messages = branch.messages;
  const submittedIndex = messages.findIndex(message => message.id === submitted.id);
  const base = { conversation_id: conversationId, source: 'native_page' };
  if (submittedIndex < 0) return { ...base, confirmed: false, completed: false, reason: 'submitted_message_not_observed' };
  const actual = messages[submittedIndex];
  if (actual.author?.role !== 'user' || messageText(actual) !== messageText(submitted)) {
    return { ...base, confirmed: false, completed: false, reason: 'submitted_message_mismatch' };
  }
  const confirmed = { ...base, confirmed: true, completed: false, submitted_node_id: actual.id };
  if (!branch.current_node_in_page) return { ...confirmed, reason: 'current_node_not_in_page' };
  if (conversation.page_info?.has_next_page !== false) return { ...confirmed, reason: 'active_page_end_not_confirmed' };
  const currentIndex = messages.findIndex(message => message.id === conversation.current_node);
  if (currentIndex <= submittedIndex) return { ...confirmed, reason: 'server_message_still_pending' };
  const following = messages.slice(submittedIndex + 1, currentIndex + 1);
  if (following.some(message => message.author?.role === 'user')) return { ...confirmed, reason: 'another_user_turn_follows' };
  const finalReply = messages[currentIndex];
  if (!visibleAssistantReply(finalReply)) return { ...confirmed, reason: 'server_message_still_pending' };
  const relationEvidence = nativeParentEvidence(messages, currentIndex, submittedIndex);
  if (relationEvidence === 'contradictory_parent_chain') return { ...confirmed, reason: relationEvidence };
  const assistants = following.filter(visibleAssistantReply);
  const terminal = finalReply.end_turn === true && ['finished_successfully', 'finished_partial_completion'].includes(finalReply.status);
  return {
    ...confirmed, completed: terminal && finalReply.status === 'finished_successfully', terminal,
    reason: terminal ? finalReply.status === 'finished_successfully' ? 'server_message_finished' : 'server_message_partial' : 'server_message_still_pending',
    relation_evidence: relationEvidence, assistant_messages: assistants,
    ...(terminal ? { terminal_message_id: finalReply.id, terminal_status: finalReply.status } : {}),
  };
}

/** Reconcile a submitted ID and text against an independently fetched active branch. */
export function reconcileConversationTurn({ request, stream, conversation }) {
  const body = request?.body ?? request;
  const submitted = body?.messages?.[0];
  if (!object(submitted) || typeof submitted.id !== 'string') fail('INVALID_ARGUMENT', 'The submitted request has no message ID.');
  if (!object(conversation)) fail('UNEXPECTED_RESPONSE', 'The independent conversation read must be an object.');
  const conversationId = conversation.id ?? conversation.conversation_id ?? null;
  const expectedId = body.conversation_id ?? stream?.conversation_id ?? null;
  if (expectedId && conversationId !== expectedId) fail('STREAM_ID_MISMATCH', 'The independent read belongs to another conversation.');
  if (!object(conversation.mapping)) {
    if (!Array.isArray(conversation.messages)) fail('UNEXPECTED_RESPONSE', 'The independent conversation read has neither mapping nor native messages.');
    return reconcileNativePage(submitted, conversation, conversationId);
  }
  const entries = Object.entries(conversation.mapping);
  const submittedNode = entries.find(([, node]) => node?.message?.id === submitted.id);
  if (!submittedNode) return { confirmed: false, completed: false, reason: 'submitted_message_not_observed', conversation_id: conversationId };
  const actual = submittedNode[1].message;
  if (actual.author?.role !== 'user' || messageText(actual) !== messageText(submitted)) {
    return { confirmed: false, completed: false, reason: 'submitted_message_mismatch', conversation_id: conversationId };
  }
  const branch = conversationBranch(conversation.mapping, conversation.current_node);
  const index = branch.node_ids.indexOf(submittedNode[0]);
  if (index < 0) return { confirmed: true, completed: false, reason: 'submitted_message_on_another_branch', conversation_id: conversationId, submitted_node_id: submittedNode[0] };
  const descendants = branch.node_ids.slice(index + 1).map(key => conversation.mapping[key]?.message).filter(object);
  const assistants = descendants.filter(visibleAssistantReply);
  const terminal = assistants.findLast(message => message.end_turn === true && ['finished_successfully', 'finished_partial_completion'].includes(message.status));
  return {
    confirmed: true, completed: terminal?.status === 'finished_successfully', terminal: Boolean(terminal),
    reason: terminal ? terminal.status === 'finished_successfully' ? 'server_message_finished' : 'server_message_partial' : 'server_message_still_pending',
    conversation_id: conversationId, submitted_node_id: submittedNode[0],
    assistant_messages: assistants,
    ...(terminal ? { terminal_message_id: terminal.id, terminal_status: terminal.status } : {}),
  };
}
