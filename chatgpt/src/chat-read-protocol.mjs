import { ChatGptError } from './errors.mjs';

const own = (value, name) => Object.prototype.hasOwnProperty.call(value, name);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(message) {
  throw new ChatGptError('invalid_argument', message);
}

function response(value, name) {
  if (!record(value)) throw new ChatGptError('unexpected_response', `${name} must be a JSON object.`);
  return value;
}

function integer(value, name, { min = 0, max = 1000 } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function identifier(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    invalid(`${name} must be a nonempty account identifier, without path separators.`);
  }
  return value;
}

function optionalString(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${name} must be a string without control characters.`);
  return value;
}

function contextualHeaders({ projectId, ownerId }) {
  const headers = {};
  if (projectId !== undefined) headers['Chatgpt-Project-ID'] = identifier(projectId, 'projectId');
  if (ownerId !== undefined) headers['Chatgpt-Conv-Owner-ID'] = identifier(ownerId, 'ownerId');
  return headers;
}

export function accountRequest() {
  return { method: 'GET', path: 'me' };
}

export function parseAccount(value) {
  const data = response(value, 'Account');
  if (typeof data.id !== 'string' || !data.id) {
    throw new ChatGptError('unexpected_response', 'The account response has no account ID.');
  }
  return { ...data };
}

export function chatsListRequest({ offset = 0, limit = 20, order = 'updated', expand = false, archived = false } = {}) {
  integer(offset, 'offset', { max: Number.MAX_SAFE_INTEGER });
  integer(limit, 'limit', { min: 1 });
  if (!['created', 'updated'].includes(order)) invalid('order must be created or updated.');
  if (typeof expand !== 'boolean' || typeof archived !== 'boolean') invalid('expand and archived must be booleans.');
  return {
    method: 'GET', path: 'conversations',
    query: { offset, limit, order, expand, is_archived: archived },
  };
}

export function parseChatsList(value, { offset = 0, limit = 20 } = {}) {
  const data = response(value, 'Conversation list');
  integer(offset, 'offset', { max: Number.MAX_SAFE_INTEGER });
  integer(limit, 'limit', { min: 1 });
  if (own(data, 'items') && !Array.isArray(data.items)) {
    throw new ChatGptError('unexpected_response', 'Conversation list items must be an array.');
  }
  const received = data.items ?? [];
  const items = received.filter(item => record(item) && typeof item.id === 'string' && item.id.length > 0);
  const unparsedItems = received.filter(item => !record(item) || typeof item.id !== 'string' || !item.id.length);
  const total = Number.isSafeInteger(data.total) && data.total >= 0 ? data.total : null;
  const consumed = offset + received.length;
  const hasMore = total === null ? received.length >= limit : consumed < total;
  // Advance over every returned row, including a malformed row that the app's
  // tolerant list deserializer would skip. Never repeat an empty page forever.
  return {
    ...data,
    items,
    ...(unparsedItems.length ? { unparsed_items: unparsedItems } : {}),
    pagination: {
      offset, limit, total,
      cursor: typeof data.cursor === 'string' ? data.cursor : null,
      has_more: hasMore,
      next_offset: hasMore && received.length > 0 ? consumed : null,
      stalled: hasMore && received.length === 0,
    },
  };
}

export function chatRequest(conversationId, { numTurns = 50, includeMessageId, projectId, ownerId } = {}) {
  identifier(conversationId, 'conversationId');
  integer(numTurns, 'numTurns', { min: 1 });
  const query = { num_turns: numTurns };
  if (includeMessageId !== undefined) query.include_message_id = identifier(includeMessageId, 'includeMessageId');
  return {
    method: 'GET', path: `conversations/${conversationId}`, query,
    headers: contextualHeaders({ projectId, ownerId }),
  };
}

export function chatMessagesRequest(conversationId, { before, numTurns = 50, projectId, ownerId } = {}) {
  identifier(conversationId, 'conversationId');
  integer(numTurns, 'numTurns', { min: 1 });
  const query = { num_turns: numTurns };
  if (before !== undefined) query.before = identifier(before, 'before');
  return {
    method: 'GET', path: `conversations/${conversationId}/messages`, query,
    headers: contextualHeaders({ projectId, ownerId }),
  };
}

export function conversationBranch(mapping, currentNode) {
  response(mapping, 'Conversation mapping');
  if (currentNode === null || currentNode === undefined) {
    return { node_ids: [], messages: [], complete: false, termination: 'no_current_node' };
  }
  if (typeof currentNode !== 'string') {
    throw new ChatGptError('unexpected_response', 'The current conversation node must be a string or null.');
  }
  const visited = new Set();
  const nodeIds = [];
  const messages = [];
  let cursor = currentNode;
  let termination = 'root';
  while (cursor !== null && cursor !== undefined) {
    if (visited.has(cursor)) { termination = 'cycle'; break; }
    visited.add(cursor);
    if (!own(mapping, cursor) || !record(mapping[cursor])) { termination = 'missing_node'; break; }
    const node = mapping[cursor];
    nodeIds.push(cursor);
    if (record(node.message)) messages.push(node.message);
    if (node.parent !== null && node.parent !== undefined && typeof node.parent !== 'string') {
      termination = 'invalid_parent'; break;
    }
    cursor = node.parent;
  }
  return {
    node_ids: nodeIds.reverse(), messages: messages.reverse(),
    complete: termination === 'root', termination,
    ...(termination === 'missing_node' || termination === 'cycle' ? { stopped_at: cursor } : {}),
  };
}

export function parseConversation(value) {
  const data = response(value, 'Conversation');
  if (record(data.mapping)) {
    // Retain the complete graph and each original rich message. The selected
    // branch is additional navigation data, never a replacement for that graph.
    return {
      ...data,
      current_branch: { ...conversationBranch(data.mapping, data.current_node), source: 'mapping' },
    };
  }
  if (!Array.isArray(data.messages) || data.messages.some(message => !record(message))) {
    throw new ChatGptError('unexpected_response', 'The conversation response has neither a message mapping nor a native message page.');
  }
  const messages = [...data.messages];
  const messageIds = messages.filter(message => typeof message.id === 'string').map(message => message.id);
  const pageInfo = record(data.page_info) ? data.page_info : {};
  const hasPrevious = typeof pageInfo.has_previous_page === 'boolean' ? pageInfo.has_previous_page : null;
  const hasNext = typeof pageInfo.has_next_page === 'boolean' ? pageInfo.has_next_page : null;
  const currentNodePresent = typeof data.current_node === 'string' && messageIds.includes(data.current_node);
  const pageComplete = hasPrevious === false && hasNext === false;
  let termination;
  if (typeof data.current_node !== 'string') termination = 'no_current_node';
  else if (!currentNodePresent) termination = 'page_before_current_node';
  else if (hasNext === true) termination = 'next_page_available';
  else if (hasPrevious === true) termination = 'previous_page_available';
  else termination = pageComplete ? 'page_complete' : 'pagination_unknown';
  // The native endpoint returns an active-branch page, not a graph. Array
  // order must never be turned into invented parent relationships.
  const parentLinks = messages.filter(message => typeof message.id === 'string'
    && record(message.metadata) && own(message.metadata, 'parent_id')
    && (message.metadata.parent_id === null || typeof message.metadata.parent_id === 'string'))
    .map(message => ({ message_id: message.id, parent_id: message.metadata.parent_id }));
  return {
    ...data,
    messages,
    current_branch: {
      source: 'native_page', messages, message_ids: messageIds,
      parent_links: parentLinks,
      last_user_message: messages.findLast(message => message.author?.role === 'user') ?? null,
      complete: pageComplete && currentNodePresent, page_complete: pageComplete,
      current_node_in_page: currentNodePresent, termination,
      page_info: { ...pageInfo },
    },
  };
}

export function chatsSearchRequest(query, { cursor, limit = 20, queryId } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 4000) invalid('query must contain 1 to 4000 characters.');
  integer(limit, 'limit', { min: 1 });
  cursor = optionalString(cursor, 'cursor');
  queryId = optionalString(queryId, 'queryId');
  return {
    method: 'POST', path: 'global/search',
    body: { query, limit, ...(cursor === undefined ? {} : { cursor }), ...(queryId === undefined ? {} : { query_id: queryId }) },
  };
}

export function parseSearchResults(value) {
  const data = response(value, 'Search response');
  if (!Array.isArray(data.items)) {
    throw new ChatGptError('unexpected_response', 'Search response items must be an array.');
  }
  const cursor = typeof data.cursor === 'string' && data.cursor ? data.cursor : null;
  return {
    ...data,
    items: [...data.items],
    pagination: { cursor, has_more: cursor !== null },
  };
}
