import { LinkedInError } from './errors.mjs';
import { prepareMessage, sendMessage, reconcileMessage } from './inbox.mjs';
import { readState, saveState } from './state.mjs';

function key(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id ?? '')) throw new LinkedInError('INVALID_ARGUMENT', 'Provide the operationId returned by message.prepare.');
  return `message-${id}`;
}
export async function prepareOperation(options, store = { save: saveState }) {
  const prepared = prepareMessage(options);
  await store.save(key(prepared.operationId), { version: 1, status: 'prepared', prepared });
  return { operationId: prepared.operationId, originToken: prepared.originToken, status: 'prepared', preview: prepared.preview,
    nextCommand: `linkedin message send --operation ${prepared.operationId} --confirm` };
}
export async function getOperation(id, store = { read: readState }) {
  const record = await store.read(key(id));
  if (!record) throw new LinkedInError('OPERATION_NOT_FOUND', 'No prepared message has this operationId.');
  return record;
}
// Caller holds the process-safe state lock across journal and send.
export async function sendOperation(client, id, { confirm = false, store = { read: readState, save: saveState } } = {}) {
  if (!confirm) throw new LinkedInError('CONFIRMATION_REQUIRED', 'Use --confirm to send the exact saved message and recipients.');
  const record = await getOperation(id, store);
  if (record.prepared.preview.mailboxUrn !== client.session.account.mailboxUrn) throw new LinkedInError('ACCOUNT_CHANGED', 'This message was prepared for a different LinkedIn account.');
  if (record.status !== 'prepared') throw new LinkedInError('MESSAGE_ALREADY_ATTEMPTED', 'This message was already attempted. Check its status and reconcile it before preparing any replacement.', { operationId: id, status: record.status });
  record.status = 'sending'; record.attemptedAt = new Date().toISOString();
  await store.save(key(id), record);
  try {
    const result = await sendMessage(client, record.prepared, { confirm: true });
    record.status = 'accepted'; record.result = result;
    await store.save(key(id), record);
    return result;
  } catch (error) {
    record.status = error.code === 'MESSAGE_REJECTED' ? 'rejected' : 'unknown';
    record.errorCode = error.code ?? 'UNKNOWN_ERROR';
    await store.save(key(id), record);
    throw error;
  }
}
export async function reconcileOperation(client, id, options = {}, store = { read: readState, save: saveState }) {
  const record = await getOperation(id, store);
  if (record.prepared.preview.mailboxUrn !== client.session.account.mailboxUrn) throw new LinkedInError('ACCOUNT_CHANGED', 'This message belongs to a different LinkedIn account.');
  const result = await reconcileMessage(client, { ...options, prepared: record.prepared });
  if (result.conclusive) { record.status = 'accepted'; record.reconciliation = result; await store.save(key(id), record); }
  return result;
}
