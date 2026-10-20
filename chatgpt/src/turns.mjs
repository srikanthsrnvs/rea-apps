import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createClient } from './client.mjs';
import { getChat } from './chats.mjs';
import { chatMessageRequest, chatStopRequest, initialConversationStreamState,
  reduceConversationStream, reconcileConversationTurn } from './chat-write-protocol.mjs';
import { parseSSE } from './sse.mjs';
import { readState, saveState, stateDirectory, withStateLock } from './state.mjs';
import { ChatGptError } from './errors.mjs';
import { chatRequirementsRequest, parseChatRequirements, sentinelHeaders } from './sentinel-protocol.mjs';

function recordName(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id ?? '')) {
    throw new ChatGptError('INVALID_ARGUMENT', 'Provide a UUID operation ID for this turn.');
  }
  return `turn-${id}`;
}

async function saveTurn(record) {
  const name = recordName(record.operationId);
  return withStateLock(async () => {
    const latest = await readState(name);
    if (latest?.stream?.events_seen > record.stream?.events_seen) record.stream = latest.stream;
    if (latest?.phase === 'complete') {
      record.phase = 'complete';
      record.reconciliation = latest.reconciliation;
    }
    if (latest?.stopPhase === 'acknowledged' || latest?.stopPhase && !record.stopPhase) record.stopPhase = latest.stopPhase;
    if (record.reconciliation?.completed) delete record.error;
    await saveState(name, record);
  }, { directory: path.join(stateDirectory, 'turn-checkpoints', record.operationId) });
}

export async function getModels(client) {
  client ??= await createClient();
  return client.request({ method: 'GET', path: 'models', query: { iim: false, supports_model_picker_upgrade_presets: true } });
}

function receipt(record) {
  return { operationId: record.operationId, phase: record.phase,
    conversationId: record.stream?.conversation_id ?? record.request.body.conversation_id,
    messageId: record.request.body.messages[0].id, model: record.request.body.model,
    ...(record.reconciliation ? { reconciliation: record.reconciliation } : {}),
    ...(record.error ? { error: record.error } : {}) };
}

async function reconcile(record, client) {
  const conversationId = record.stream?.conversation_id ?? record.request.body.conversation_id;
  if (!conversationId) return { ...receipt(record), reconciliation: { confirmed: false, reason: 'conversation_id_not_received' } };
  const conversation = await getChat(conversationId, { includeMessageId: record.request.body.messages[0].id }, client);
  record.reconciliation = reconcileConversationTurn({ request: record.request, stream: record.stream, conversation });
  if (record.reconciliation.completed) record.phase = 'complete';
  else if (record.reconciliation.confirmed) record.phase = 'submitted';
  await saveTurn(record);
  return receipt(record);
}

export async function sendTurn({ operationId, chatId, prompt, model, timezone, parentMessageId } = {}) {
  const name = recordName(operationId);
  const client = await createClient();
  return withStateLock(async () => {
    const previous = await readState(name);
    if (previous) {
      if (previous.generation !== client.session.generation || previous.prompt !== prompt || previous.chatId !== chatId) {
        throw new ChatGptError('OPERATION_MISMATCH', 'This operation ID belongs to a different prompt or account.');
      }
      return reconcile(previous, client);
    }
    if (typeof prompt !== 'string' || !prompt.trim()) throw new ChatGptError('INVALID_ARGUMENT', 'Provide a prompt.');
    let conversation;
    if (chatId) conversation = await getChat(chatId, {}, client);
    model ??= conversation?.default_model_slug;
    if (!model) model = (await getModels(client)).default_model_slug;
    if (!model) throw new ChatGptError('MODEL_REQUIRED', 'Choose a model from the models command.');
    parentMessageId ??= conversation?.current_node ?? (chatId ? null : randomUUID());
    if (!parentMessageId) throw new ChatGptError('PARENT_REQUIRED', 'The conversation has no current node. Read its branches before replying.');
    const request = chatMessageRequest({ conversationId: chatId ?? null, parentMessageId,
      messageId: randomUUID(), text: prompt, model, createTime: Date.now() / 1000,
      timezone: timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezoneOffsetMin: new Date().getTimezoneOffset() });
    const verificationHeaders = sentinelHeaders(parseChatRequirements(await client.request(chatRequirementsRequest())));
    const record = { operationId, prompt, chatId, request, generation: client.session.generation,
      phase: 'submitting', createdAt: new Date().toISOString(), stream: initialConversationStreamState() };
    await saveTurn(record);
    try {
      const response = await client.request({ ...request, headers: verificationHeaders }, { stream: true, timeoutMs: 180_000 });
      if (!response.headers.get('content-type')?.startsWith('text/event-stream')) {
        await response.body?.cancel();
        throw new ChatGptError('INVALID_STREAM', 'ChatGPT did not return a conversation stream.');
      }
      let lastSave = 0;
      for await (const frame of parseSSE(response.body)) {
        const oldId = record.stream.conversation_id;
        record.stream = reduceConversationStream(record.stream, frame);
        record.phase = 'streaming';
        if (Buffer.byteLength(JSON.stringify(record.stream)) > 32 * 1024 * 1024) throw new ChatGptError('STREAM_TOO_LARGE', 'The conversation stream exceeds the configured limit.');
        if (oldId !== record.stream.conversation_id || Date.now() - lastSave >= 1000) {
          await saveTurn(record);
          lastSave = Date.now();
        }
      }
      record.phase = 'reconciling';
    } catch (error) {
      record.phase = 'outcome_unknown';
      record.error = { code: error instanceof ChatGptError ? error.code : 'STREAM_ERROR',
        message: error instanceof ChatGptError ? error.message : 'The conversation stream ended unexpectedly.' };
    }
    await saveTurn(record);
    return reconcile(record, client);
  }, { directory: path.join(stateDirectory, 'operations', operationId), timeoutMs: 200_000 });
}

export async function turnStatus({ operationId } = {}) {
  const record = await readState(recordName(operationId));
  const client = await createClient();
  if (!record || record.generation !== client.session.generation) throw new ChatGptError('OPERATION_NOT_FOUND', 'No turn with that ID exists for this account session.');
  return reconcile(record, client);
}

export async function stopTurn({ operationId } = {}) {
  const name = recordName(operationId), record = await readState(name), client = await createClient();
  if (!record || record.generation !== client.session.generation) throw new ChatGptError('OPERATION_NOT_FOUND', 'No turn with that ID exists for this account session.');
  const conversationId = record.stream?.conversation_id ?? record.request.body.conversation_id;
  if (!conversationId) throw new ChatGptError('CONVERSATION_UNKNOWN', 'The server has not returned a conversation ID, so this turn cannot yet be stopped.');
  const current = await getChat(conversationId, {}, client);
  const latestUser = current.current_branch.messages.findLast(message => message.author?.role === 'user');
  if (latestUser?.id !== record.request.body.messages[0].id) throw new ChatGptError('TURN_CHANGED', 'The active conversation now belongs to a different user turn.');
  if (record.stopPhase) return reconcile(record, client);
  record.stopPhase = 'requested';
  await saveTurn(record);
  const stopResult = await client.request(chatStopRequest(conversationId));
  record.stopPhase = 'acknowledged';
  await saveTurn(record);
  return { stopResult, ...await reconcile(record, client) };
}
