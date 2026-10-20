import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { accountHeaders, authorizedSession } from './auth.mjs';
import { withCodex } from './codex-client.mjs';
import { stateDirectory, readState, saveState, withStateLock } from './state.mjs';
import { listThreadsRequest, searchThreadsRequest, readThreadRequest, listEnvironmentsRequest,
  listModelsRequest, listProjectsRequest, startThreadRequest, startTurnRequest,
  interruptTurnRequest, normalizeCodexPage, listTurnsRequest } from './codex-protocol.mjs';
import { ChatGptError } from './errors.mjs';

const builders = { list: listThreadsRequest, search: searchThreadsRequest, get: readThreadRequest,
  environments: listEnvironmentsRequest, models: listModelsRequest, projects: listProjectsRequest };

export async function readCodexThread(client, options = {}) {
  const read = readThreadRequest(1, { threadId: options.threadId });
  const metadata = await client.request(read.method, read.params);
  if (!metadata?.thread || metadata.thread.id !== options.threadId) {
    throw new ChatGptError('INVALID_CODEX_RESPONSE', 'Codex did not return the requested thread.');
  }
  let cursor = options.cursor, pages = 0, pageMetadata = {};
  const turns = [], cursors = new Set(cursor ? [cursor] : []);
  do {
    const request = listTurnsRequest(1, { threadId: options.threadId, cursor,
      limit: options.limit ?? 3, sortDirection: 'asc', itemsView: 'full' });
    const result = await client.request(request.method, request.params);
    const page = normalizeCodexPage(result);
    turns.push(...page.items);
    const { data: _data, ...extra } = result;
    pageMetadata = extra;
    pages++;
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) {
      throw new ChatGptError('PAGINATION_STALLED', 'Codex returned a repeated turn cursor.');
    }
    if (cursor) cursors.add(cursor);
  } while (options.all && cursor && pages < 1000);
  return {
    result: { ...metadata, thread: { ...metadata.thread, turns } },
    pagination: { ...pageMetadata, pages, nextCursor: cursor, complete: !cursor, sortDirection: 'asc' },
    events: client.snapshot(),
  };
}

export async function readCodex(kind, options = {}) {
  const builder = builders[kind];
  if (!builder) throw new ChatGptError('INVALID_ARGUMENT', 'Unknown Codex read operation.');
  const session = await authorizedSession();
  return withCodex((url, method) => accountHeaders(session, url, method), async client => {
    if (kind === 'get') return readCodexThread(client, options);
    let cursor = options.cursor, pages = 0, result;
    const items = [], cursors = new Set();
    do {
      const request = builder(1, { ...options, cursor });
      result = await client.request(request.method, request.params);
      pages++;
      if (!options.all || !['list', 'search'].includes(kind)) return { result, events: client.snapshot() };
      const page = normalizeCodexPage(result);
      items.push(...page.items);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new ChatGptError('PAGINATION_STALLED', 'Codex returned a repeated page cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor && pages < 1000);
    return { items, pagination: { pages, nextCursor: cursor, complete: !cursor }, events: client.snapshot() };
  });
}

export async function mutateCodex(kind, options = {}) {
  const operationId = options.operationId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId ?? '')) {
    throw new ChatGptError('INVALID_ARGUMENT', 'Provide a UUID operation ID before changing a Codex task.');
  }
  if (!['new', 'reply', 'stop'].includes(kind)) throw new ChatGptError('INVALID_ARGUMENT', 'Unknown Codex operation.');
  if (kind !== 'stop' && (typeof options.prompt !== 'string' || !options.prompt.trim())) {
    throw new ChatGptError('INVALID_ARGUMENT', 'A prompt is required.');
  }
  if (kind === 'new' && !options.environmentId) throw new ChatGptError('INVALID_ARGUMENT', 'Select an environment from codex environments first.');
  const session = await authorizedSession();
  const recordName = `codex-${operationId}`;
  return withStateLock(async () => {
    const old = await readState(recordName);
    if (old) {
      if (old.generation !== session.generation || old.kind !== kind || JSON.stringify(old.options) !== JSON.stringify(options)) {
        throw new ChatGptError('OPERATION_MISMATCH', 'This operation ID already belongs to a different request or account.');
      }
      return { ...old.receipt, operationId, phase: old.phase, replayed: false,
        ...(old.phase !== 'complete' ? { message: 'The earlier request was not repeated. Inspect this task before submitting another operation.' } : {}) };
    }
    const record = { kind, options, generation: session.generation, phase: 'prepared', createdAt: new Date().toISOString(),
      receipt: { threadId: options.threadId ?? null, clientUserMessageId: randomUUID() } };
    await saveState(recordName, record);
    return withCodex((url, method) => accountHeaders(session, url, method), async client => {
      const send = async request => client.request(request.method, request.params);
      if (kind === 'new') {
        const request = startThreadRequest(1, { environmentId: options.environmentId, model: options.model });
        record.phase = 'creating_thread';
        await saveState(recordName, record);
        const created = await send(request);
        const threadId = created?.thread?.id ?? created?.thread?.threadId ?? created?.id;
        if (typeof threadId !== 'string' || !threadId) throw new ChatGptError('INVALID_CODEX_RESPONSE', 'Codex did not return the new thread ID.');
        record.receipt.threadId = threadId;
        record.receipt.created = created;
        record.phase = 'thread_created';
        await saveState(recordName, record);
      }
      const request = kind === 'stop'
        ? interruptTurnRequest(1, options)
        : startTurnRequest(1, { threadId: record.receipt.threadId, text: options.prompt, model: options.model,
          effort: options.effort, clientUserMessageId: record.receipt.clientUserMessageId });
      record.phase = kind === 'stop' ? 'stopping' : 'sending_turn';
      await saveState(recordName, record);
      record.receipt.result = await send(request);
      record.receipt.events = client.snapshot();
      record.phase = 'complete';
      record.completedAt = new Date().toISOString();
      await saveState(recordName, record);
      return { operationId, phase: record.phase, ...record.receipt };
    });
  }, { directory: path.join(stateDirectory, 'operations', operationId) });
}

export async function codexOperationStatus(operationId) {
  if (!/^[0-9a-f-]{36}$/i.test(operationId ?? '')) throw new ChatGptError('INVALID_ARGUMENT', 'Provide a valid operation ID.');
  const session = await authorizedSession();
  const record = await readState(`codex-${operationId}`);
  if (!record || record.generation !== session.generation) throw new ChatGptError('OPERATION_NOT_FOUND', 'No operation with that ID exists for this account session.');
  const current = record.receipt.threadId ? await readCodex('get', { threadId: record.receipt.threadId }) : null;
  return { operationId, phase: record.phase, receipt: record.receipt, current, replayed: false };
}
