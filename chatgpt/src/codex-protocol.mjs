import { ChatGptError } from './errors.mjs';

// Wire contracts recovered from the Android app; see docs/codex-protocol.md.
export const CODEX_CLOUD_URL = 'wss://codex-cloud-backend.chatgpt.com/';
export const CODEX_SUBPROTOCOL = 'codex-app-server';

function fail(message) {
  throw new ChatGptError('INVALID_CODEX_ARGUMENT', message);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function string(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a nonempty string.`);
  return value;
}

function limit(value = 50) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) fail('limit must be between 1 and 100.');
  return value;
}

function cursor(value) {
  if (value == null) return null;
  return string(value, 'cursor');
}

function subset(options, keys) {
  const out = {};
  for (const key of keys) if (options[key] !== undefined) out[key] = options[key];
  return out;
}

function direction(value = 'desc') {
  if (!['asc', 'desc'].includes(value)) fail('sortDirection must be asc or desc.');
  return value;
}

export function buildCodexRequest(id, method, params = {}) {
  if (!Number.isSafeInteger(id) || id < 1) fail('Request id must be a positive safe integer.');
  string(method, 'method');
  object(params, 'params');
  return { jsonrpc: '2.0', id, method, params };
}

export function initializeRequest(id, { requestAttestation = false } = {}) {
  if (typeof requestAttestation !== 'boolean') fail('requestAttestation must be boolean.');
  return buildCodexRequest(id, 'initialize', {
    capabilities: { experimentalApi: true, requestAttestation, mcpServerOpenaiFormElicitation: true },
    clientInfo: { name: 'codex_chatgpt_android_remote', version: 'dev' },
  });
}

export function listThreadsRequest(id, options = {}) {
  const sortKey = options.sortKey ?? 'updated_at';
  if (!['updated_at', 'recency_at', 'section_position'].includes(sortKey)) fail('Unsupported thread sortKey.');
  if (options.sectionId != null) string(options.sectionId, 'sectionId');
  return buildCodexRequest(id, 'thread/list', {
    cursor: cursor(options.cursor), limit: limit(options.limit), modelProviders: null,
    sortKey, sortDirection: direction(options.sortDirection),
    ...(options.sectionId != null ? { sectionId: options.sectionId } : {}),
  });
}

export function searchThreadsRequest(id, options = {}) {
  return buildCodexRequest(id, 'thread/search', {
    searchTerm: string(options.query ?? options.searchTerm, 'query'), cursor: cursor(options.cursor),
    limit: limit(options.limit), sortKey: 'updated_at', sortDirection: direction(options.sortDirection),
  });
}

export function readThreadRequest(id, { threadId, includeTurns = false } = {}) {
  if (typeof includeTurns !== 'boolean') fail('includeTurns must be boolean.');
  return buildCodexRequest(id, 'thread/read', { threadId: string(threadId, 'threadId'), includeTurns });
}

export function listEnvironmentsRequest(id, options = {}) {
  if (options.scope != null) string(options.scope, 'scope');
  return buildCodexRequest(id, 'environment/config/list', {
    ...(options.scope != null ? { scope: options.scope } : {}),
    ...(options.cursor != null ? { cursor: cursor(options.cursor) } : {}),
    limit: limit(options.limit ?? 100),
  });
}

export function listTurnsRequest(id, options = {}) {
  return buildCodexRequest(id, 'thread/turns/list', {
    threadId: string(options.threadId, 'threadId'), cursor: cursor(options.cursor),
    limit: limit(options.limit), sortDirection: direction(options.sortDirection),
    ...subset(options, ['itemsView']),
  });
}

export function listItemsRequest(id, options = {}) {
  return buildCodexRequest(id, 'thread/items/list', {
    threadId: string(options.threadId, 'threadId'), turnId: string(options.turnId, 'turnId'),
    cursor: cursor(options.cursor), limit: limit(options.limit), sortDirection: direction(options.sortDirection),
  });
}

export function listModelsRequest(id, options = {}) {
  return buildCodexRequest(id, 'model/list', subset(options, ['cursor', 'limit']));
}

export function listProjectsRequest(id, options = {}) {
  return buildCodexRequest(id, 'project/list', subset(options, ['cursor', 'limit']));
}

export function startThreadRequest(id, options = {}) {
  const environmentConfigId = options.environmentConfigId ?? options.environmentId;
  if (environmentConfigId != null) string(environmentConfigId, 'environmentConfigId');
  const params = {
    serviceName: 'codex_cloud', threadSource: 'user',
    ...subset(options, ['cwd', 'model', 'modelProvider', 'serviceTier', 'approvalPolicy',
      'approvalsReviewer', 'sandbox', 'config', 'projectId', 'persistExtendedHistory', 'historyMode']),
  };
  if (environmentConfigId != null) params.environmentConfigId = environmentConfigId;
  // With an environment config selected, the native app asks for a new managed workspace.
  // The config is selected separately; it is not an already-running environment ID.
  if (options.environments !== undefined) {
    if (!Array.isArray(options.environments)) fail('environments must be an array.');
    for (const environment of options.environments) object(environment, 'environment');
    params.environments = options.environments;
  } else if (environmentConfigId != null) {
    params.environments = [{ environmentId: 'managed', cwd: '/workspace', runtimeWorkspaceRoots: [], environmentConfigId: null }];
  }
  return buildCodexRequest(id, 'thread/start', params);
}

export function startTurnRequest(id, options = {}) {
  const threadId = string(options.threadId, 'threadId');
  if (options.text !== undefined && options.input !== undefined) fail('Supply text or input, not both.');
  let input = options.input;
  if (input === undefined) input = [{ type: 'text', text: string(options.text, 'text') }];
  if (!Array.isArray(input) || input.length === 0) fail('input must be a nonempty array.');
  for (const item of input) {
    object(item, 'input item');
    string(item.type, 'input item type');
    if (item.type === 'text') string(item.text, 'input text');
  }
  if (options.clientUserMessageId !== undefined) string(options.clientUserMessageId, 'clientUserMessageId');
  return buildCodexRequest(id, 'turn/start', {
    threadId, input,
    ...subset(options, ['clientUserMessageId', 'model', 'effort', 'serviceTier', 'cwd', 'summary',
      'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy', 'collaborationMode', 'outputSchema']),
  });
}

export function interruptTurnRequest(id, { threadId, turnId } = {}) {
  return buildCodexRequest(id, 'turn/interrupt', {
    threadId: string(threadId, 'threadId'), turnId: string(turnId, 'turnId'),
  });
}

export function parseCodexMessage(raw) {
  let value = raw;
  if (typeof raw === 'string' || Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    try { value = JSON.parse(Buffer.isBuffer(raw) || raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : raw); }
    catch { throw new ChatGptError('INVALID_CODEX_RESPONSE', 'Codex returned invalid JSON.'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value.jsonrpc !== undefined && value.jsonrpc !== '2.0')) {
    throw new ChatGptError('INVALID_CODEX_RESPONSE', 'Codex returned an invalid JSON-RPC message.');
  }
  return value;
}

export function parseCodexResponse(raw, { expectedId } = {}) {
  const message = parseCodexMessage(raw);
  if (!Object.hasOwn(message, 'id') || (expectedId !== undefined && message.id !== expectedId)) {
    throw new ChatGptError('CODEX_RESPONSE_ID_MISMATCH', 'Codex response does not match the pending request.');
  }
  if (message.error != null) {
    const error = message.error;
    throw new ChatGptError('CODEX_REMOTE_ERROR',
      typeof error.message === 'string' ? error.message : 'Codex rejected the request.',
      { rpcCode: error.code ?? null, data: error.data ?? null });
  }
  if (!Object.hasOwn(message, 'result')) {
    throw new ChatGptError('INVALID_CODEX_RESPONSE', 'Codex response has no result.');
  }
  // Return the original result, including unknown fields, rather than a lossy projection.
  return message.result;
}

export function normalizeCodexThread(value) {
  object(value, 'Codex thread');
  const id = value.id ?? value.threadId;
  string(id, 'Codex thread id');
  return {
    id, title: value.name ?? value.title ?? null, preview: value.preview ?? null,
    createdAt: value.createdAt ?? null, updatedAt: value.updatedAt ?? null,
    status: value.status ?? null, cwd: value.cwd ?? null,
    turns: Array.isArray(value.turns) ? value.turns : [], raw: value,
  };
}

export function normalizeCodexPage(value) {
  object(value, 'Codex page');
  if (!Array.isArray(value.data)) {
    throw new ChatGptError('INVALID_CODEX_RESPONSE', 'Codex page has no data array.');
  }
  return {
    items: value.data, nextCursor: value.nextCursor ?? null,
    backwardsCursor: value.backwardsCursor ?? null, raw: value,
  };
}
