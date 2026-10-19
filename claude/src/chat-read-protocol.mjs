import { ClaudeError } from './errors.mjs';

export const CLAUDE_READ_ORIGIN = 'https://claude.ai';
export const ROOT_MESSAGE_ID = '00000000-0000-4000-8000-000000000000';
export const RECENT_SURFACES = Object.freeze(['chat', 'project', 'cowork', 'code', 'cowork_chat', 'artifact', 'routine']);

function invalid(message) { throw new ClaudeError('INVALID_ARGUMENT', message); }
function schema(message) { throw new ClaudeError('UNEXPECTED_RESPONSE', message); }
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) schema(`${label} must be an object.`);
  return value;
}
function string(value, label, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.length) || /[\x00-\x1f\x7f]/.test(value)) schema(`${label} must be a string.`);
  return value;
}
function array(value, label) { if (!Array.isArray(value)) schema(`${label} must be an array.`); return value; }
function nullableString(value) { return value === undefined || value === null ? null : String(value); }
function id(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid(`${label} must be a UUID.`);
  return value;
}
function argumentString(value, label) {
  if (typeof value !== 'string' || !value.length || /[\x00-\x1f\x7f]/.test(value)) invalid(`${label} must be a nonempty string without control characters.`);
  return value;
}
function request(path, params = []) {
  const url = new URL(`/api/${path}`, CLAUDE_READ_ORIGIN);
  for (const [name, value] of params) if (value !== undefined && value !== null) url.searchParams.append(name, String(value));
  return { url: url.href, method: 'GET' };
}

export function accountRequest() { return request('account'); }

export function listChatsRequest(organizationId, { cursor, section, limit, surfaces = ['chat'] } = {}) {
  id(organizationId, 'Organization ID');
  if (cursor !== undefined) argumentString(cursor, 'Cursor');
  if (section !== undefined) argumentString(section, 'Section');
  if (cursor !== undefined && section === undefined) section = 'recents';
  limit ??= cursor === undefined ? 100 : 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('Limit must be an integer from 1 to 100.');
  if (!Array.isArray(surfaces) || !surfaces.length || surfaces.some(x => !RECENT_SURFACES.includes(x))) invalid('Surfaces must contain recognized native surface names.');
  return request(`organizations/${organizationId}/recents`, [
    ['limit', limit], ['section', section], ['cursor', cursor],
    ...surfaces.map(surface => [['cowork_chat', 'routine'].includes(surface) ? 'include' : 'surfaces', surface]),
  ]);
}

export function searchChatsRequest(organizationId, query) {
  id(organizationId, 'Organization ID'); argumentString(query, 'Search query');
  return request(`organizations/${organizationId}/conversation/search/v2`, [['query', query], ['n', 10]]);
}

export function openChatRequest(organizationId, chatId, { returnDanglingHumanMessage, maxResponseBytes } = {}) {
  id(organizationId, 'Organization ID'); id(chatId, 'Chat ID');
  if (returnDanglingHumanMessage !== undefined && typeof returnDanglingHumanMessage !== 'boolean') invalid('returnDanglingHumanMessage must be a boolean.');
  if (maxResponseBytes !== undefined && (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1)) invalid('maxResponseBytes must be a positive safe integer.');
  return request(`organizations/${organizationId}/chat_conversations/${chatId}`, [
    ['rendering_mode', 'messages'], ['render_all_mobile_tools', true],
    ['return_dangling_human_message', returnDanglingHumanMessage], ['include_extracted_content', false],
    ['max_response_bytes', maxResponseBytes],
  ]);
}

export function parseAccountResponse(payload) {
  const account = record(payload, 'Account');
  const memberships = array(account.memberships, 'Account memberships').map((membership, index) => {
    const member = record(membership, `Membership ${index}`);
    const organization = record(member.organization, `Membership ${index} organization`);
    return {
      id: string(organization.uuid, 'Organization UUID'), name: nullableString(organization.name), role: nullableString(member.role),
      capabilities: organization.capabilities === undefined ? [] : array(organization.capabilities, 'Organization capabilities'),
      plan: nullableString(organization.plan_display_name), billingType: nullableString(organization.billing_type),
    };
  });
  return {
    id: string(account.uuid, 'Account UUID'), email: nullableString(account.email_address),
    name: nullableString(account.full_name), displayName: nullableString(account.display_name),
    verified: typeof account.is_verified === 'boolean' ? account.is_verified : null,
    organizations: memberships,
  };
}

export function normalizeChatSummary(payload) {
  const chat = record(payload, 'Chat summary');
  return {
    id: string(chat.uuid, 'Chat UUID'), name: nullableString(chat.name), summary: nullableString(chat.summary),
    createdAt: nullableString(chat.created_at), updatedAt: nullableString(chat.updated_at), model: nullableString(chat.model),
    starred: typeof chat.is_starred === 'boolean' ? chat.is_starred : false,
    projectId: nullableString(chat.project_uuid), temporary: typeof chat.is_temporary === 'boolean' ? chat.is_temporary : false,
    currentLeafMessageId: nullableString(chat.current_leaf_message_uuid),
    needsInput: typeof chat.needs_input === 'boolean' ? chat.needs_input : null,
    liveStatus: chat.live_status ?? null,
  };
}

export function parseChatsPage(payload) {
  const response = record(payload, 'Recents response');
  const degradedSurfaces = array(response.degraded_surfaces ?? [], 'Degraded surfaces');
  const incompleteSurfaces = array(response.incomplete_surfaces ?? [], 'Incomplete surfaces');
  const sections = array(response.sections, 'Recents sections').map((value, index) => {
    const section = record(value, `Section ${index}`);
    const rows = array(section.data, 'Section data');
    const chats = [];
    const otherRows = [];
    for (const row of rows) {
      record(row, 'Recent row');
      if (row.type === 'chat') chats.push(normalizeChatSummary(row));
      else otherRows.push(structuredClone(row));
    }
    if (section.next_cursor !== null && section.next_cursor !== undefined) string(section.next_cursor, 'Next cursor');
    return {
      id: string(section.id, 'Section ID'), title: nullableString(section.title), chats, otherRows,
      nextCursor: section.next_cursor ?? null,
    };
  });
  const byId = new Map();
  for (const chat of sections.flatMap(section => section.chats)) {
    const previous = byId.get(chat.id);
    byId.set(chat.id, previous ? { ...chat, starred: previous.starred || chat.starred } : chat);
  }
  const chats = [...byId.values()];
  const continuations = sections.filter(section => section.nextCursor !== null).map(section => ({ section: section.id, cursor: section.nextCursor }));
  return {
    chats, sections, pagination: { continuations, hasMore: continuations.length > 0 }, degradedSurfaces, incompleteSurfaces,
    complete: continuations.length === 0 && degradedSurfaces.length === 0 && incompleteSurfaces.length === 0,
  };
}

export function parseSearchResults(payload) {
  const response = record(payload, 'Conversation search response');
  const hits = array(response.data, 'Search data').map(hit => {
    record(hit, 'Search hit');
    return {
      chat: normalizeChatSummary(hit.conversation), matchedSnippet: structuredClone(hit.matched_snippet ?? null),
      titleMatches: structuredClone(hit.title_matches ?? []),
    };
  });
  if (response.next_page_token !== undefined && response.next_page_token !== null) string(response.next_page_token, 'Next page token');
  return {
    hits, searchId: nullableString(response.search_id), executedMode: nullableString(response.executed_mode),
    pagination: { nextPageToken: response.next_page_token ?? null, continuationSupported: false },
  };
}

export function parseChatResponse(payload, { expectedChatId } = {}) {
  const chat = record(payload, 'Chat');
  const summary = normalizeChatSummary(chat);
  if (expectedChatId !== undefined && summary.id !== expectedChatId) schema('Returned chat does not match the requested chat.');
  const messages = array(chat.chat_messages, 'Chat messages').map((value, index) => {
    const message = record(value, `Message ${index}`);
    if (message.content !== undefined && !Array.isArray(message.content)) schema('Message content must be an array.');
    return {
      id: string(message.uuid, 'Message UUID'), parentMessageId: nullableString(message.parent_message_uuid),
      index: Number.isInteger(message.index) ? message.index : null, sender: nullableString(message.sender),
      text: message.content?.some(block=>block.type==='text')?message.content.filter(block=>block.type==='text').map(block=>typeof block.text==='string'?block.text:'').join(''):typeof message.text === 'string' ? message.text : null,
      content: structuredClone(message.content ?? []), attachments: structuredClone(message.attachments ?? []),
      files: structuredClone(message.files ?? []), createdAt: nullableString(message.created_at), updatedAt: nullableString(message.updated_at),
      inputMode: nullableString(message.input_mode), edited: typeof message.is_edited === 'boolean' ? message.is_edited : false,
      stopReason: nullableString(message.stop_reason),
    };
  });
  const byId = new Map();
  for (const message of messages) {
    if (byId.has(message.id)) schema('Chat response contains duplicate message IDs.');
    byId.set(message.id, message);
  }
  const referenced = new Set(messages.map(message => message.parentMessageId));
  const leafMessageIds = messages.filter(message => !referenced.has(message.id)).map(message => message.id);
  const activeMessageIds = [];
  let cursor = summary.currentLeafMessageId;
  let activePathComplete = cursor === null ? messages.length === 0 : true;
  const seen = new Set();
  while (cursor && cursor !== ROOT_MESSAGE_ID) {
    if (seen.has(cursor)) schema('Chat active message branch contains a cycle.');
    seen.add(cursor);
    const message = byId.get(cursor);
    if (!message) { activePathComplete = false; break; }
    activeMessageIds.unshift(message.id);
    cursor = message.parentMessageId;
  }
  return { ...summary, settings: structuredClone(chat.settings ?? null), messages,
    branches: { leafMessageIds, activeMessageIds, activePathComplete } };
}
