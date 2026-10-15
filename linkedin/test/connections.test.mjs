import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareInvitation, invitationStatus, sendInvitation } from '../src/connections.mjs';

const mailboxUrn = 'urn:li:fsd_profile:sender';
const recipientUrn = 'urn:li:fsd_profile:recipient';
function fixture() {
  const records = new Map();
  return { read: async key => records.has(key) ? structuredClone(records.get(key)) : null,
    save: async (key, value) => records.set(key, structuredClone(value)) };
}
test('invitation preserves the exact note and journals before a single native V2 request', async () => {
  const state = fixture();
  const plan = await prepareInvitation({ mailboxUrn, recipientUrn, note: 'A specific note.' }, state);
  let calls = 0;
  const client = { session: { account: { mailboxUrn } }, request: async request => {
    calls++;
    assert.equal((await invitationStatus(plan.operationId, state)).status, 'sending');
    assert.equal(request.path, '/voyager/api/voyagerRelationshipsDashMemberRelationships');
    assert.equal(request.method, 'POST');
    assert.equal(request.query.action, 'verifyQuotaAndCreateV2');
    assert.deepEqual(request.body, { invitee: { inviteeUnion: { memberProfile: recipientUrn } }, customMessage: 'A specific note.' });
    return { value: { invitationUrn: 'urn:li:fsd_invitation:example', invitation: { invitationState: 'PENDING' } } };
  } };
  await assert.rejects(sendInvitation(client, plan.operationId, { state }), { code: 'CONFIRMATION_REQUIRED' });
  assert.equal(calls, 0);
  const result = await sendInvitation(client, plan.operationId, { state, confirm: true });
  assert.equal(result.invitationState, 'PENDING');
  assert.equal(result.note, 'A specific note.');
  assert.equal((await invitationStatus(plan.operationId, state)).status, 'accepted');
  await assert.rejects(sendInvitation(client, plan.operationId, { state, confirm: true }), { code: 'INVITATION_ALREADY_ATTEMPTED' });
  assert.equal(calls, 1);
});
test('lost or unrecognized invitation responses remain unknown across process instances', async () => {
  for (const response of [new Error('lost response'), { value: {} }]) {
    const state = fixture();
    const plan = await prepareInvitation({ mailboxUrn, recipientUrn, note: 'Exact note.' }, state);
    let calls = 0;
    const client = { session: { account: { mailboxUrn } }, request: async () => { calls++; if (response instanceof Error) throw response; return response; } };
    await assert.rejects(sendInvitation(client, plan.operationId, { state, confirm: true }), { code: 'INVITATION_SEND_UNKNOWN' });
    assert.equal((await invitationStatus(plan.operationId, state)).status, 'unknown');
    await assert.rejects(sendInvitation({ ...client }, plan.operationId, { state, confirm: true }), { code: 'INVITATION_ALREADY_ATTEMPTED' });
    assert.equal(calls, 1);
  }
});
test('wrong account, changed plan and invalid recipients cannot send an invitation', async () => {
  const state = fixture();
  for (const options of [{ mailboxUrn, recipientUrn: mailboxUrn, note: 'Hello' }, { mailboxUrn, recipientUrn: 'someone', note: 'Hello' }, { mailboxUrn, recipientUrn, note: 'x'.repeat(201) }]) {
    await assert.rejects(prepareInvitation(options, state), { code: 'INVALID_ARGUMENT' });
  }
  const plan = await prepareInvitation({ mailboxUrn, recipientUrn, note: 'Hello' }, state);
  const client = { session: { account: { mailboxUrn: recipientUrn } }, request: async () => assert.fail('must not send') };
  await assert.rejects(sendInvitation(client, plan.operationId, { state, confirm: true }), { code: 'ACCOUNT_CHANGED' });
  client.session.account.mailboxUrn = mailboxUrn;
  const record = await invitationStatus(plan.operationId, state); record.request.body.customMessage = 'Changed';
  await state.save(`invitation-${plan.operationId}`, record);
  await assert.rejects(sendInvitation(client, plan.operationId, { state, confirm: true }), { code: 'INVALID_INVITATION_PLAN' });
});
test('definite invitation rejection is retained and normalized references confirm acceptance', async () => {
  const state = fixture();
  const plan = await prepareInvitation({ mailboxUrn, recipientUrn, note: 'Hello' }, state);
  const client = { session: { account: { mailboxUrn } }, request: async () => { throw Object.assign(Error('Rejected'), { details: { status: 422 } }); } };
  await assert.rejects(sendInvitation(client, plan.operationId, { state, confirm: true }), { code: 'INVITATION_REJECTED' });
  assert.equal((await invitationStatus(plan.operationId, state)).status, 'rejected');
  const second = await prepareInvitation({ mailboxUrn, recipientUrn, note: 'A different recipient test fixture.' }, state);
  client.request = async () => ({ value: { '*invitation': 'urn:li:fsd_invitation:example' }, included: [{ entityUrn: 'urn:li:fsd_invitation:example', invitationState: 'PENDING' }] });
  assert.equal((await sendInvitation(client, second.operationId, { state, confirm: true })).invitationState, 'PENDING');
});
