import { createHash, randomUUID } from 'node:crypto';
import { LinkedInError } from './errors.mjs';
import { readState, saveState } from './state.mjs';

const route = '/voyager/api/voyagerRelationshipsDashMemberRelationships';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const profile = /^urn:li:fsd_profile:[A-Za-z0-9_-]+$/;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function key(id) {
  if (!uuid.test(id ?? '')) throw new LinkedInError('INVALID_ARGUMENT', 'Provide the operationId returned by connection.prepare.');
  return `invitation-${id}`;
}
const store = { read: readState, save: saveState };
export async function prepareInvitation({ mailboxUrn, recipientUrn, note }, state = store) {
  if (!profile.test(mailboxUrn ?? '') || !profile.test(recipientUrn ?? '') || mailboxUrn === recipientUrn) throw new LinkedInError('INVALID_ARGUMENT', 'Use a resolved recipient fsd_profile URN distinct from the sender.');
  if (typeof note !== 'string' || !note.trim() || [...note].length > 200) throw new LinkedInError('INVALID_ARGUMENT', 'Supply an exact invitation note of 1 to 200 characters.');
  const request = { path: route, method: 'POST', query: { action: 'verifyQuotaAndCreateV2', decorationId: 'com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-1' },
    body: { invitee: { inviteeUnion: { memberProfile: recipientUrn } }, customMessage: note } };
  const operationId = randomUUID();
  await state.save(key(operationId), { version: 1, status: 'prepared', operationId, createdAt: new Date().toISOString(),
    preview: { mailboxUrn, recipientUrn, note }, request, digest: digest(request) });
  return { operationId, status: 'prepared', preview: { mailboxUrn, recipientUrn, note }, nextCommand: `linkedin connection send --operation ${operationId} --confirm` };
}
export async function invitationStatus(id, state = store) {
  const record = await state.read(key(id));
  if (!record) throw new LinkedInError('OPERATION_NOT_FOUND', 'No saved connection invitation has this operationId.');
  return record;
}
// The CLI holds its process lock across the journal write and network request.
// No server-side idempotency contract is assumed for this native action.
export async function sendInvitation(client, id, { confirm = false, state = store } = {}) {
  if (!confirm) throw new LinkedInError('CONFIRMATION_REQUIRED', 'Confirm the exact saved recipient and note with --confirm.');
  const record = await invitationStatus(id, state);
  if (record.preview.mailboxUrn !== client.session.account.mailboxUrn) throw new LinkedInError('ACCOUNT_CHANGED', 'This invitation was prepared for a different account.');
  if (record.status !== 'prepared') throw new LinkedInError('INVITATION_ALREADY_ATTEMPTED', 'This invitation was already attempted. Check its status and the server relationship before preparing any replacement.', { operationId: id, status: record.status });
  if (record.version !== 1 || record.request?.path !== route || record.request?.method !== 'POST'
    || record.request?.query?.action !== 'verifyQuotaAndCreateV2' || record.digest !== digest(record.request)
    || record.request.body?.invitee?.inviteeUnion?.memberProfile !== record.preview.recipientUrn
    || record.request.body?.customMessage !== record.preview.note) throw new LinkedInError('INVALID_INVITATION_PLAN', 'The saved invitation is invalid or changed.');
  record.status = 'sending'; record.attemptedAt = new Date().toISOString();
  await state.save(key(id), record);
  let response;
  try { response = await client.request(record.request); }
  catch (cause) {
    const status = cause?.details?.status;
    const rejected = Number.isInteger(status) && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
    record.status = rejected ? 'rejected' : 'unknown';
    record.errorCode = rejected ? 'INVITATION_REJECTED' : 'INVITATION_SEND_UNKNOWN';
    await state.save(key(id), record);
    throw new LinkedInError(record.errorCode, rejected ? 'LinkedIn rejected the connection invitation.' : 'Invitation delivery is uncertain. Do not send another copy; check the saved status and server relationship.', { operationId: id, status: status ?? null });
  }
  const index = new Map((response?.included ?? response?.data?.included ?? []).map(item => [item.entityUrn, item]));
  const resolve = value => typeof value === 'string' ? index.get(value) ?? value : value;
  const value = resolve(response?.value ?? response?.data?.value ?? response?.data?.data?.value);
  const invitation = resolve(value?.invitation ?? value?.['*invitation']);
  const invitationUrn = value?.invitationUrn ?? invitation?.entityUrn ?? value?.['*invitation'];
  if ((response?.errors ?? response?.data?.errors)?.length || !/^urn:li:[A-Za-z_]*[Ii]nvitation:/.test(invitationUrn ?? '')) {
    record.status = 'unknown'; record.errorCode = 'INVITATION_SEND_UNKNOWN';
    await state.save(key(id), record);
    throw new LinkedInError('INVITATION_SEND_UNKNOWN', 'LinkedIn returned no recognized invitation confirmation. Check the server relationship before attempting any replacement.', { operationId: id });
  }
  record.status = 'accepted';
  record.result = { status: 'accepted', operationId: id, invitationUrn, invitationState: invitation?.invitationState ?? null,
    recipientUrn: record.preview.recipientUrn, note: record.preview.note };
  await state.save(key(id), record);
  return record.result;
}
