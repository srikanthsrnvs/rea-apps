import test from 'node:test';
import assert from 'node:assert/strict';
import { listConversations, listMessages, prepareMessage, sendMessage, reconcileMessage,
  changeConversationCategory, setNotificationStatus, mailboxUrnFromMe, INBOX_QUERIES, validateUrn, getConversation, findConversationsByRecipients, setConversationRead, searchConversations } from '../src/inbox.mjs';
const mailbox = 'urn:li:fsd_profile:viewer123';
const recipient = 'urn:li:fsd_profile:recipient456';
const conversation = `urn:li:msg_conversation:(${mailbox},thread123)`;
const messageUrn = `urn:li:msg_message:(${mailbox},message123)`;
const originToken = '00000000-0000-4000-8000-000000000000';

test('native conversations finder preserves server cursor and category', async () => {
  let request;
  const client = { graphql: async spec => { request = spec; return { data: { messengerConversationsByCategory: { elements: [{ entityUrn: conversation }], metadata: { nextCursor: 'opaque,server(cursor)' }, paging: { count: 1 } } } }; } };
  const result = await listConversations(client, { mailboxUrn: mailbox, count: 1, nextCursor: 'previous+cursor=' });
  assert.equal(request.queryId, INBOX_QUERIES.conversations);
  assert.deepEqual(request.variables, { mailboxUrn: mailbox, category: 'INBOX', count: 1, nextCursor: 'previous+cursor=' });
  assert.equal(result.pagination.nextCursor, 'opaque,server(cursor)');
  assert.equal(result.pagination.hasMore, true);
  assert.equal(result.items[0].entityUrn, conversation);
});
test('normalized references resolve without losing opaque URNs', async () => {
  const client = { graphql: async () => ({ data: { messengerConversationsByCategory: { '*elements': [conversation], metadata: {} } }, included: [{ entityUrn: conversation, '*conversationParticipants': [recipient] }, { entityUrn: recipient, name: 'Example' }] }) };
  const result = await listConversations(client, { mailboxUrn: mailbox });
  assert.equal(result.items[0].conversationParticipants[0].name, 'Example');
  assert.equal(result.items[0].entityUrn, conversation);
});
test('unresolved reference and GraphQL error are not silently empty inboxes', async () => {
  await assert.rejects(listConversations({ graphql: async () => ({ data: { messengerConversationsByCategory: { elements: [null] } } }) }, { mailboxUrn: mailbox }), { code: 'INCOMPLETE_INBOX_RESPONSE' });
  await assert.rejects(listConversations({ graphql: async () => ({ errors: [{ message: 'No access' }] }) }, { mailboxUrn: mailbox }), { code: 'INBOX_API_ERROR' });
  await assert.rejects(listConversations({ graphql: async () => ({ data: {} }) }, { mailboxUrn: mailbox }), { code: 'UNSUPPORTED_INBOX_RESPONSE' });
});
test('message pagination keeps next and previous cursors distinct', async () => {
  let request;
  const client = { graphql: async spec => { request = spec; return { elements: [], metadata: { nextCursor: 'newer', prevCursor: 'older' } }; } };
  const result = await listMessages(client, { conversationUrn: conversation, prevCursor: 'old&page', count: 25 });
  assert.equal(request.queryId, INBOX_QUERIES.messages);
  assert.deepEqual(request.variables, { conversationUrn: conversation, count: 25, prevCursor: 'old&page' });
  assert.equal(result.pagination.prevCursor, 'older');
  await assert.rejects(listMessages(client, { conversationUrn: conversation, nextCursor: 'a', prevCursor: 'b' }), { code: 'INVALID_ARGUMENT' });
});
test('mailbox comes from authenticated dashEntityUrn, not public handle', () => {
  assert.equal(mailboxUrnFromMe({ miniProfile: { dashEntityUrn: mailbox } }), mailbox);
  assert.throws(() => mailboxUrnFromMe({ miniProfile: { entityUrn: 'urn:li:fs_miniProfile:123', publicIdentifier: 'example' } }), { code: 'INVALID_ARGUMENT' });
});
test('URNs reject query injection, URLs and malformed tuples', () => {
  for (const value of ['https://linkedin.com/in/example', `${conversation}&action=delete`, 'urn:li:msg_conversation:(unclosed', 'urn:li:msg_conversation:closed)']) assert.throws(() => validateUrn(value), { code: 'INVALID_ARGUMENT' });
  assert.equal(validateUrn(conversation), conversation);
});
test('reply plan retains stable origin token and native nested conversation', () => {
  const plan = prepareMessage({ mailboxUrn: mailbox, conversationUrn: conversation, text: '  Hello 🌍\n', originToken });
  assert.equal(plan.originToken, originToken);
  assert.equal(plan.request.body.message.body.text, '  Hello 🌍\n');
  assert.deepEqual(plan.request.body.message.conversation, { entityUrn: conversation });
  assert.equal(plan.request.body.message.conversationUrn, conversation);
  assert.equal(plan.request.body.dedupeByClientGeneratedToken, true);
  assert.equal(plan.request.body.trackingId.length, 16);
  assert.equal(plan.request.body.message.entityUrn, undefined);
  assert.equal(plan.request.body.message.sender, undefined);
  assert(Object.isFrozen(plan.request.body.message.body));
});
test('new conversation accepts resolved profiles, not guessed profile slugs', () => {
  const plan = prepareMessage({ mailboxUrn: mailbox, recipientUrns: [recipient], text: 'Hello', originToken });
  assert.deepEqual(plan.request.body.hostRecipientUrns, [recipient]);
  assert.equal(plan.request.body.message.conversation, undefined);
  for (const recipients of [['example-person'], [recipient, recipient], [mailbox]]) assert.throws(() => prepareMessage({ mailboxUrn: mailbox, recipientUrns: recipients, text: 'Hello' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => prepareMessage({ mailboxUrn: mailbox, conversationUrn: conversation, recipientUrns: [recipient], text: 'Hello' }), { code: 'INVALID_ARGUMENT' });
});
test('reply refuses a native conversation from another mailbox', () => {
  assert.throws(() => prepareMessage({ mailboxUrn: mailbox, conversationUrn: `urn:li:msg_conversation:(${recipient},other)`, text: 'Hello' }), { code: 'INVALID_ARGUMENT' });
});
test('send requires exact unchanged plan and cannot repeat same instance', async () => {
  let calls = 0;
  const client = { request: async spec => { calls++; assert.equal(spec.retry, false); return { value: { entityUrn: messageUrn, originToken } }; } };
  const plan = prepareMessage({ mailboxUrn: mailbox, conversationUrn: conversation, text: 'Hello', originToken });
  await assert.rejects(sendMessage(client, plan), { code: 'CONFIRMATION_REQUIRED' });
  const altered = JSON.parse(JSON.stringify(plan)); altered.request.body.message.body.text = 'Changed';
  await assert.rejects(sendMessage(client, altered, { confirm: true }), { code: 'INVALID_MESSAGE_PLAN' });
  assert.equal(calls, 0);
  const result = await sendMessage(client, plan, { confirm: true });
  assert.equal(result.status, 'accepted');
  await assert.rejects(sendMessage(client, plan, { confirm: true }), { code: 'MESSAGE_ALREADY_ATTEMPTED' });
  assert.equal(calls, 1);
});
test('transport timeout never triggers resend; reconciliation matches originToken', async () => {
  let calls = 0;
  const plan = prepareMessage({ mailboxUrn: mailbox, conversationUrn: conversation, text: 'Hello', originToken });
  await assert.rejects(sendMessage({ request: async () => { calls++; throw new Error('timeout'); } }, plan, { confirm: true }), error => error.code === 'MESSAGE_SEND_UNKNOWN' && error.details.originToken === originToken);
  assert.equal(calls, 1);
  const found = await reconcileMessage({ graphql: async () => ({ elements: [{ entityUrn: messageUrn, originToken }], metadata: {} }) }, { prepared: plan });
  assert.equal(found.status, 'found'); assert.equal(found.conclusive, true);
  const missing = await reconcileMessage({ graphql: async () => ({ elements: [], metadata: { prevCursor: 'older' } }) }, { prepared: plan });
  assert.equal(missing.status, 'not_found_in_page'); assert.equal(missing.conclusive, false);
});
test('unexpected successful send response remains uncertain', async () => {
  const plan = prepareMessage({ mailboxUrn: mailbox, recipientUrns: [recipient], text: 'Hello', originToken });
  await assert.rejects(sendMessage({ request: async () => ({ value: {} }) }, plan, { confirm: true }), { code: 'MESSAGE_SEND_UNKNOWN' });
});
test('expired authentication is reported explicitly without retrying the message', async () => {
  const plan = prepareMessage({ mailboxUrn: mailbox, recipientUrns: [recipient], text: 'Hello', originToken });
  let calls = 0;
  const client = { request: async () => { calls++; throw Object.assign(new Error('HTTP 401'), { code: 'AUTH_REQUIRED', details: { status: 401 } }); } };
  await assert.rejects(sendMessage(client, plan, { confirm: true }), error => error.code === 'MESSAGE_REJECTED' && error.details.reauthenticationRequired === true);
  await assert.rejects(sendMessage(client, plan, { confirm: true }), { code: 'MESSAGE_ALREADY_ATTEMPTED' });
  assert.equal(calls, 1);
});
test('non-connection rejection explains the recipient restriction and is not retried', async () => {
  const plan = prepareMessage({ mailboxUrn: mailbox, recipientUrns: [recipient], text: 'Hello', originToken });
  let calls = 0;
  const client = { request: async () => { calls++; throw Object.assign(new Error('HTTP 422'), { details: { status: 422, serverCode: 'RECIPIENT_NOT_FIRST_DEGREE_CONNECTION' } }); } };
  await assert.rejects(sendMessage(client, plan, { confirm: true }), error => error.code === 'MESSAGE_REJECTED'
    && error.details.serverCode === 'RECIPIENT_NOT_FIRST_DEGREE_CONNECTION' && /first-degree connection/.test(error.message));
  await assert.rejects(sendMessage(client, plan, { confirm: true }), { code: 'MESSAGE_ALREADY_ATTEMPTED' });
  assert.equal(calls, 1);
});
test('category actions and notification patch use native POST contracts', async () => {
  const requests = [];
  const client = { request: async spec => { requests.push(spec); return null; } };
  await changeConversationCategory(client, { conversationUrns: [conversation], category: 'ARCHIVE' });
  await setNotificationStatus(client, { conversationUrn: conversation, status: 'MUTE' });
  assert.deepEqual(requests[0].query, { action: 'addCategory' });
  assert.deepEqual(requests[0].body, { conversationUrns: [conversation], category: 'ARCHIVE' });
  assert.equal(requests[1].path.split('/').at(-1), encodeURIComponent(conversation));
  assert.deepEqual(requests[1].body, { patch: { $set: { notificationStatus: 'MUTE' } } });
});

test('nested GraphQL envelopes and top-level collection references resolve', async () => {
  const collectionUrn = 'urn:li:collection:example';
  const client = { graphql: async () => ({ data: { data: { '*messengerConversationsByCategory': collectionUrn } }, included: [{ entityUrn: collectionUrn, '*elements': [conversation], metadata: {} }, { entityUrn: conversation }] }) };
  const result = await listConversations(client, { mailboxUrn: mailbox });
  assert.equal(result.items[0].entityUrn, conversation);
});
test('raw server error text is excluded from structured error details', async () => {
  await assert.rejects(listConversations({ graphql: async () => ({ data: { data: { errors: [{ message: 'private diagnostic secret' }] } } }) }, { mailboxUrn: mailbox }), error => error.code === 'INBOX_API_ERROR' && error.details.errorCount === 1 && !JSON.stringify(error).includes('private diagnostic secret'));
});
test('conversation lookup uses native batch-get IDs and exact result matching', async () => {
  let request;
  const client = { graphql: async spec => { request = spec; return { data: { data: { messengerConversationsByIds: [{ entityUrn: conversation }] } } }; } };
  const result = await getConversation(client, { conversationUrn: conversation });
  assert.equal(result.entityUrn, conversation);
  assert.equal(request.queryId, INBOX_QUERIES.conversationIds);
  assert.deepEqual(request.variables, { conversationIds: [conversation] });
  await assert.rejects(getConversation({ graphql: async () => [] }, { conversationUrn: conversation }), { code: 'CONVERSATION_NOT_FOUND' });
});
test('recipient conversation finder uses resolved host profiles', async () => {
  let request;
  const client = { graphql: async spec => { request = spec; return { elements: [{ entityUrn: conversation }], metadata: {} }; } };
  const result = await findConversationsByRecipients(client, { mailboxUrn: mailbox, recipientUrns: [recipient] });
  assert.equal(result.items[0].entityUrn, conversation);
  assert.deepEqual(request.variables, { mailboxUrn: mailbox, recipients: [recipient] });
});
test('read/unread uses native conversation patch without inventing lastReadAt', async () => {
  const requests = [];
  const client = { request: async request => { requests.push(request); return null; } };
  await setConversationRead(client, { conversationUrn: conversation, read: true });
  await setConversationRead(client, { conversationUrn: conversation, read: false });
  assert.deepEqual(requests[0].body, { patch: { $set: { read: true } } });
  assert.deepEqual(requests[1].body, { patch: { $set: { read: false } } });
});

test('inbox search forwards unread false and exact cursor values', async () => {
  let request;
  const client = { graphql: async spec => { request = spec; return { elements: [], metadata: {} }; } };
  await searchConversations(client, { mailboxUrn: mailbox, keywords: 'coffee', read: false, nextCursor: 'same(cursor)', count: 10 });
  assert.equal(request.queryId, INBOX_QUERIES.search);
  assert.deepEqual(request.variables, { mailboxUrn: mailbox, keywords: 'coffee', categories: ['INBOX'], count: 10, nextCursor: 'same(cursor)', read: false });
});

test('every inbox persisted query supplies its native operation name', async () => {
  const calls = [];
  const client = { graphql: async request => {
    calls.push(request);
    return request.field === 'messengerConversationsByIds' ? [{ entityUrn: conversation }] : { elements: [], metadata: {} };
  } };
  await listConversations(client, { mailboxUrn: mailbox });
  await listMessages(client, { conversationUrn: conversation });
  await getConversation(client, { conversationUrn: conversation });
  await findConversationsByRecipients(client, { mailboxUrn: mailbox, recipientUrns: [recipient] });
  await searchConversations(client, { mailboxUrn: mailbox, keywords: 'example' });
  assert.deepEqual(calls.map(request => request.queryName), ['FindConversationsByCategory', 'GetMessagesByConversation', 'GetConversationsByIds', 'FindConversationsByRecipients', 'FindConversationsBySearchCriteria']);
});
