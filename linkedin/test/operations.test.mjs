import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareOperation, sendOperation, getOperation, reconcileOperation } from '../src/operations.mjs';

const mailboxUrn = 'urn:li:fsd_profile:sender';
const conversationUrn = `urn:li:msg_conversation:(${mailboxUrn},example)`;
function storeFixture() {
  const records = new Map();
  return { records, read: async key => records.has(key) ? structuredClone(records.get(key)) : null,
    save: async (key, record) => { records.set(key, structuredClone(record)); } };
}
test('durable attempted journal precedes a send and prevents another process sending the plan again', async () => {
  const store = storeFixture();
  const plan = await prepareOperation({ mailboxUrn, conversationUrn, text: 'An exact reply.' }, store);
  let calls = 0;
  const client = { session: { account: { mailboxUrn } }, request: async request => {
    assert.equal((await getOperation(plan.operationId, store)).status, 'sending');
    assert.equal(request.body.message.body.text, 'An exact reply.'); calls++;
    return { value: { entityUrn: 'urn:li:msg_message:accepted' } };
  } };
  await assert.rejects(sendOperation(client, plan.operationId, { store }), { code: 'CONFIRMATION_REQUIRED' });
  assert.equal(calls, 0);
  await sendOperation(client, plan.operationId, { confirm: true, store });
  assert.equal((await getOperation(plan.operationId, store)).status, 'accepted');
  await assert.rejects(sendOperation(client, plan.operationId, { confirm: true, store }), { code: 'MESSAGE_ALREADY_ATTEMPTED' });
  assert.equal(calls, 1);
});
test('lost response persists unknown and can be reconciled by its original token', async () => {
  const store = storeFixture();
  const plan = await prepareOperation({ mailboxUrn, conversationUrn, text: 'An exact reply.' }, store);
  const client = { session: { account: { mailboxUrn } }, request: async () => { throw Error('lost connection'); },
    graphql: async () => ({ messengerMessagesByConversation: { elements: [{ entityUrn: 'urn:li:msg_message:one', originToken: plan.originToken }], metadata: {} } }) };
  await assert.rejects(sendOperation(client, plan.operationId, { confirm: true, store }), { code: 'MESSAGE_SEND_UNKNOWN' });
  assert.equal((await getOperation(plan.operationId, store)).status, 'unknown');
  await assert.rejects(sendOperation(client, plan.operationId, { confirm: true, store }), { code: 'MESSAGE_ALREADY_ATTEMPTED' });
  assert.equal((await reconcileOperation(client, plan.operationId, {}, store)).conclusive, true);
  assert.equal((await getOperation(plan.operationId, store)).status, 'accepted');
});
test('saved operations cannot be sent under a different account', async () => {
  const store = storeFixture();
  const plan = await prepareOperation({ mailboxUrn, conversationUrn, text: 'One account only.' }, store);
  const client = { session: { account: { mailboxUrn: 'urn:li:fsd_profile:other' } }, request: async () => { throw Error('should not send'); } };
  await assert.rejects(sendOperation(client, plan.operationId, { confirm: true, store }), { code: 'ACCOUNT_CHANGED' });
});
