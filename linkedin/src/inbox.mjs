import { createHash, randomUUID } from 'node:crypto';

// Contracts recovered from LinkedIn Android 4.1.1261; see docs/inbox-protocol.md.
export const INBOX_QUERIES = Object.freeze({
  conversations: 'voyagerMessagingDashMessengerConversations.7dc50d3efc3953190125aca9c05f0af6',
  messages: 'voyagerMessagingDashMessengerMessages.7cde5843a127bbecc3de900d3894a74a',
  conversationIds: 'voyagerMessagingDashMessengerConversations.a9b5f88bcf8f56404a2893bac1803784',
  recipients: 'voyagerMessagingDashMessengerConversations.676f7f56a71a6d38fac941d85d9fe7b1',
  search: 'voyagerMessagingDashMessengerConversations.0eab60c1f1f1e3a6d31aadd99819e2c3',
});
const CONVERSATIONS = '/voyager/api/voyagerMessagingDashMessengerConversations';
const MESSAGES = '/voyager/api/voyagerMessagingDashMessengerMessages';
export const CONVERSATION_CATEGORIES = Object.freeze([
  'INBOX', 'ARCHIVE', 'SPAM', 'PRIMARY_INBOX', 'SECONDARY_INBOX', 'INMAIL',
  'MESSAGE_REQUEST_PENDING', 'MESSAGE_REQUEST_DECLINED', 'MESSAGE_REQUEST', 'STARRED', 'JOB',
]);
export class InboxError extends Error {
  constructor(message, code, details, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'InboxError'; this.code = code;
    if (details) this.details = details;
  }
}
function invalid(message) { throw new InboxError(message, 'INVALID_ARGUMENT'); }
export function validateUrn(value, label = 'URN') {
  if (typeof value !== 'string' || value.length > 4096 ||
      !/^urn:li:[A-Za-z_][A-Za-z0-9_]*:[^\s/?#&\\]+$/u.test(value)) invalid(`${label} must be a LinkedIn URN returned by the API.`);
  let depth = 0;
  for (const c of value) { if (c === '(') depth++; if (c === ')' && --depth < 0) invalid(`${label} has unbalanced tuple delimiters.`); }
  if (depth !== 0) invalid(`${label} has unbalanced tuple delimiters.`);
  return value;
}
function profileUrn(value, label) {
  validateUrn(value, label);
  if (!/^urn:li:fsd_profile:[A-Za-z0-9_-]+$/u.test(value)) invalid(`${label} must be the profile's fsd_profile URN.`);
  return value;
}
function conversationUrn(value) {
  validateUrn(value, 'conversationUrn');
  if (!/^urn:li:(?:msg_conversation|fsd_messagingConversation|messagingConversation):/u.test(value)) invalid('Expected a conversation URN returned by the inbox.');
  return value;
}
function countValue(value = 20) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) invalid('count must be an integer from 1 to 100.');
  return n;
}
function cursor(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 16384) invalid(`${name} must be a nonempty cursor returned by LinkedIn.`);
  return value;
}
function optionalVariables(values) { return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null)); }
function checkErrors(response) {
  for (const envelope of [response, response?.data, response?.data?.data]) {
    const errors = envelope?.errors;
    if (Array.isArray(errors) && errors.length) throw new InboxError('LinkedIn returned errors for this inbox request.', 'INBOX_API_ERROR', { errorCount: errors.length });
  }
}
function resolveData(response, value) {
  const included = response?.included ?? response?.data?.included ?? response?.data?.data?.included;
  if (!Array.isArray(included)) return value;
  const entities = new Map(included.filter(x => x && typeof x.entityUrn === 'string').map(x => [x.entityUrn, x]));
  function expand(v, depth = 0, seen = new Set()) {
    if (depth > 8 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(x => expand(x, depth + 1, seen));
    const result = { ...v };
    for (const [key, item] of Object.entries(v)) {
      if (key.startsWith('*')) {
        const dereference = ref => {
          if (typeof ref !== 'string' || !entities.has(ref) || seen.has(ref)) return ref;
          return expand(entities.get(ref), depth + 1, new Set([...seen, ref]));
        };
        if (!(key.slice(1) in result)) result[key.slice(1)] = Array.isArray(item) ? item.map(dereference) : dereference(item);
      } else result[key] = expand(item, depth + 1, seen);
    }
    return result;
  }
  return expand(value);
}

function responseField(response, field) {
  for (const envelope of [response?.data?.data, response?.data, response]) {
    if (!envelope || typeof envelope !== 'object') continue;
    if (Object.hasOwn(envelope, field) || Object.hasOwn(envelope, `*${field}`)) {
      const resolved = resolveData(response, envelope);
      return resolved[field];
    }
  }
  return resolveData(response, response);
}

function collection(response, field) {
  checkErrors(response);
  const result = responseField(response, field);
  if (!result || !Array.isArray(result.elements)) throw new InboxError('LinkedIn returned an unrecognized inbox collection.', 'UNSUPPORTED_INBOX_RESPONSE', { field });
  if (result.elements.some(item => item === null || typeof item !== 'object')) throw new InboxError('The inbox collection contains unresolved or missing items.', 'INCOMPLETE_INBOX_RESPONSE', { field });
  const metadata = result.metadata ?? {};
  return {
    items: result.elements,
    pagination: {
      nextCursor: metadata.nextCursor ?? null,
      prevCursor: metadata.prevCursor ?? null,
      hasMore: Boolean(metadata.nextCursor || metadata.prevCursor),
    },
    metadata,
    paging: result.paging ?? null,
  };
}
export function mailboxUrnFromMe(me) {
  const resolved = resolveData(me, me?.data?.data ?? me?.data ?? me);
  const profile = resolved?.miniProfile ?? resolved;
  // Native VoyagerMailboxConfigProvider uses MiniProfile.dashEntityUrn directly.
  return profileUrn(profile?.dashEntityUrn, 'Authenticated mailbox');
}
export async function listConversations(client, options = {}) {
  const { mailboxUrn, category = 'INBOX', count = 20, nextCursor, lastUpdatedBefore } = options;
  profileUrn(mailboxUrn, 'mailboxUrn');
  if (!CONVERSATION_CATEGORIES.includes(category)) invalid(`Unsupported inbox category: ${category}.`);
  if (lastUpdatedBefore !== undefined && (!Number.isSafeInteger(lastUpdatedBefore) || lastUpdatedBefore < 0)) invalid('lastUpdatedBefore must be an epoch timestamp in milliseconds.');
  return collection(await client.graphql({
    queryId: INBOX_QUERIES.conversations, queryName: 'FindConversationsByCategory',
    variables: optionalVariables({ mailboxUrn, category, count: countValue(count), nextCursor: cursor(nextCursor, 'nextCursor'), lastUpdatedBefore }),
    field: 'messengerConversationsByCategory',
  }), 'messengerConversationsByCategory');
}
export async function searchConversations(client, options = {}) {
  const { mailboxUrn, keywords, categories = ['INBOX'], count = 20, nextCursor, read, firstDegreeConnections, authorUrns, hasLastMessage } = options;
  profileUrn(mailboxUrn, 'mailboxUrn');
  if (keywords !== undefined && (typeof keywords !== 'string' || !keywords.trim() || keywords.length > 1000)) invalid('keywords must be nonempty text of at most 1,000 characters.');
  if (!Array.isArray(categories) || !categories.length || categories.some(c => !CONVERSATION_CATEGORIES.includes(c))) invalid('Supply supported conversation categories.');
  for (const [key, value] of Object.entries({ read, firstDegreeConnections, hasLastMessage })) if (value !== undefined && typeof value !== 'boolean') invalid(`${key} must be a boolean.`);
  if (authorUrns !== undefined) {
    if (!Array.isArray(authorUrns) || !authorUrns.length || authorUrns.length > 50) invalid('authorUrns must contain 1 to 50 profile URNs.');
    authorUrns.forEach(value => profileUrn(value, 'authorUrn'));
  }
  return collection(await client.graphql({ queryId: INBOX_QUERIES.search, queryName: 'FindConversationsBySearchCriteria', variables: optionalVariables({ mailboxUrn, keywords, categories, count: countValue(count), nextCursor: cursor(nextCursor, 'nextCursor'), read, firstDegreeConnections, authorUrns, hasLastMessage }), field: 'messengerConversationsBySearchCriteria' }), 'messengerConversationsBySearchCriteria');
}

export async function getConversation(client, { conversationUrn: urn } = {}) {
  conversationUrn(urn);
  const response = await client.graphql({ queryId: INBOX_QUERIES.conversationIds, queryName: 'GetConversationsByIds', variables: { conversationIds: [urn] }, field: 'messengerConversationsByIds' });
  checkErrors(response);
  const values = responseField(response, 'messengerConversationsByIds');
  if (!Array.isArray(values)) throw new InboxError('LinkedIn returned an unrecognized conversation lookup.', 'UNSUPPORTED_INBOX_RESPONSE');
  const item = values.find(value => value?.entityUrn === urn);
  if (!item) throw new InboxError('This conversation was not returned for the signed-in account.', 'CONVERSATION_NOT_FOUND');
  return item;
}
export async function findConversationsByRecipients(client, { mailboxUrn, recipientUrns } = {}) {
  profileUrn(mailboxUrn, 'mailboxUrn');
  if (!Array.isArray(recipientUrns) || !recipientUrns.length || recipientUrns.length > 50) invalid('Supply 1 to 50 recipient profile URNs.');
  recipientUrns.forEach(value => profileUrn(value, 'recipientUrn'));
  return collection(await client.graphql({ queryId: INBOX_QUERIES.recipients, queryName: 'FindConversationsByRecipients', variables: { mailboxUrn, recipients: recipientUrns }, field: 'messengerConversationsByRecipients' }), 'messengerConversationsByRecipients');
}

export async function listMessages(client, options = {}) {
  const { conversationUrn: urn, count = 20, nextCursor, prevCursor } = options;
  conversationUrn(urn);
  if (nextCursor && prevCursor) invalid('Use nextCursor or prevCursor, not both.');
  return collection(await client.graphql({
    queryId: INBOX_QUERIES.messages, queryName: 'GetMessagesByConversation',
    variables: optionalVariables({ conversationUrn: urn, count: countValue(count), nextCursor: cursor(nextCursor, 'nextCursor'), prevCursor: cursor(prevCursor, 'prevCursor') }),
    field: 'messengerMessagesByConversation',
  }), 'messengerMessagesByConversation');
}

function freezeDeep(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function validateOriginToken(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) invalid('originToken must be a UUID v4; reuse the prepared token when reconciling an attempt.');
  return value;
}
export function prepareMessage(options = {}) {
  const { mailboxUrn, conversationUrn: urn, recipientUrns, text, originToken = randomUUID(), conversationTitle } = options;
  profileUrn(mailboxUrn, 'mailboxUrn');
  if (typeof text !== 'string' || !text.trim() || text.length > 20000) invalid('Message text must contain 1 to 20,000 characters.');
  validateOriginToken(originToken);
  if (Boolean(urn) === Boolean(recipientUrns?.length)) invalid('Supply exactly one of conversationUrn or recipientUrns.');
  const message = { body: { text, attributes: [] }, originToken };
  const body = { mailboxUrn, message, trackingId: Buffer.from(randomUUID().replaceAll('-', ''), 'hex').toString('latin1'), dedupeByClientGeneratedToken: true };
  if (urn) {
    conversationUrn(urn);
    if (urn.startsWith('urn:li:msg_conversation:(') && !urn.startsWith(`urn:li:msg_conversation:(${mailboxUrn},`)) invalid('This conversation belongs to a different mailbox.');
    message.conversationUrn = urn;
    message.conversation = { entityUrn: urn };
  } else {
    if (!Array.isArray(recipientUrns) || recipientUrns.length > 50) invalid('recipientUrns must contain between 1 and 50 profile URNs.');
    const recipients = recipientUrns.map(x => profileUrn(x, 'recipientUrn'));
    if (new Set(recipients).size !== recipients.length || recipients.includes(mailboxUrn)) invalid('Recipients must be unique and exclude the sender.');
    body.hostRecipientUrns = [...recipients];
    if (conversationTitle !== undefined) {
      if (typeof conversationTitle !== 'string' || !conversationTitle.trim() || conversationTitle.length > 1000) invalid('conversationTitle must be nonempty text of at most 1,000 characters.');
      body.conversationTitle = conversationTitle;
    }
  }
  const request = { path: MESSAGES, method: 'POST', query: { action: 'createMessage' }, body };
  return freezeDeep({ version: 1, operationId: randomUUID(), originToken, createdAt: new Date().toISOString(),
    preview: { mailboxUrn, conversationUrn: urn ?? null, recipientUrns: body.hostRecipientUrns ?? [], text },
    request, digest: digest(request) });
}
const attempted = new WeakSet();
export async function sendMessage(client, prepared, { confirm = false } = {}) {
  if (!confirm) throw new InboxError('Confirm the exact prepared recipient and message before sending.', 'CONFIRMATION_REQUIRED');
  if (!prepared || prepared.version !== 1 || prepared.request?.path !== MESSAGES ||
      prepared.request?.method !== 'POST' || prepared.request?.query?.action !== 'createMessage' ||
      prepared.digest !== digest(prepared.request)) throw new InboxError('The prepared message is invalid or changed.', 'INVALID_MESSAGE_PLAN');
  validateOriginToken(prepared.originToken);
  if (prepared.request.body?.message?.originToken !== prepared.originToken || prepared.request.body?.dedupeByClientGeneratedToken !== true) throw new InboxError('The prepared message lost its deduplication token.', 'INVALID_MESSAGE_PLAN');
  if (attempted.has(prepared)) throw new InboxError('This prepared message has already been attempted. Reconcile its originToken before any further action.', 'MESSAGE_ALREADY_ATTEMPTED', { originToken: prepared.originToken });
  attempted.add(prepared);
  let response;
  try { response = await client.request({ ...prepared.request, retry: false }); }
  catch (cause) {
    const status = cause?.status ?? cause?.statusCode ?? cause?.details?.status;
    const definiteRejection = Number.isInteger(status) && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
    const reauthenticationRequired = status === 401 || cause?.code === 'AUTH_REQUIRED';
    const notConnected = cause?.details?.serverCode === 'RECIPIENT_NOT_FIRST_DEGREE_CONNECTION';
    throw new InboxError(definiteRejection ? (notConnected ? 'LinkedIn cannot send a standard message to this member because they are not a first-degree connection.' : reauthenticationRequired ? 'LinkedIn rejected the message because sign-in is required. Refresh the session before preparing another attempt.' : 'LinkedIn rejected the message request.') : 'The message result is uncertain. Do not send another copy; reconcile this originToken.',
      definiteRejection ? 'MESSAGE_REJECTED' : 'MESSAGE_SEND_UNKNOWN', { operationId: prepared.operationId, originToken: prepared.originToken, status: status ?? null,
        ...(notConnected ? { serverCode: 'RECIPIENT_NOT_FIRST_DEGREE_CONNECTION' } : {}),
        ...(reauthenticationRequired ? { reauthenticationRequired: true } : {}) }, cause);
  }
  try { checkErrors(response); } catch {
    throw new InboxError('LinkedIn did not confirm the message result. Reconcile the originToken before sending again.', 'MESSAGE_SEND_UNKNOWN', { operationId: prepared.operationId, originToken: prepared.originToken });
  }
  const value = resolveData(response, response?.value ?? response?.data?.value ?? response?.data?.data?.value ?? response);
  if (!value || typeof value.entityUrn !== 'string') throw new InboxError('LinkedIn did not return a confirmed message. Reconcile the originToken before sending again.', 'MESSAGE_SEND_UNKNOWN', { operationId: prepared.operationId, originToken: prepared.originToken });
  return { status: 'accepted', operationId: prepared.operationId, originToken: prepared.originToken, message: value };
}
export async function reconcileMessage(client, { prepared, conversationUrn: urn, count = 100, nextCursor, prevCursor } = {}) {
  validateOriginToken(prepared?.originToken);
  const target = urn ?? prepared?.preview?.conversationUrn;
  if (!target) throw new InboxError('Provide the conversation returned by inbox lookup to reconcile a new conversation. A missing message is not proof that sending failed.', 'CONVERSATION_REQUIRED');
  const page = await listMessages(client, { conversationUrn: target, count, nextCursor, prevCursor });
  const matches = page.items.filter(item => item.originToken === prepared.originToken);
  return { status: matches.length ? 'found' : 'not_found_in_page', originToken: prepared.originToken, messages: matches, pagination: page.pagination,
    conclusive: matches.length > 0 };
}
export async function changeConversationCategory(client, { conversationUrns, category, remove = false } = {}) {
  if (!Array.isArray(conversationUrns) || !conversationUrns.length || conversationUrns.length > 100) invalid('Supply 1 to 100 conversation URNs.');
  conversationUrns.forEach(conversationUrn);
  if (!CONVERSATION_CATEGORIES.includes(category)) invalid('Unsupported conversation category.');
  const result = await client.request({ path: CONVERSATIONS, method: 'POST', query: { action: remove ? 'removeCategory' : 'addCategory' }, body: { conversationUrns, category }, retry: false });
  checkErrors(result);
  return { status: 'accepted', category, remove, conversationUrns, result };
}
export async function setNotificationStatus(client, { conversationUrn: urn, status } = {}) {
  conversationUrn(urn);
  if (!['ACTIVE', 'MUTE', 'ACTIVE_FOR_MENTIONS_ONLY'].includes(status)) invalid('Notification status must be ACTIVE, MUTE, or ACTIVE_FOR_MENTIONS_ONLY.');
  const result = await client.request({ path: `${CONVERSATIONS}/${encodeURIComponent(urn)}`, method: 'POST', body: { patch: { $set: { notificationStatus: status } } }, retry: false });
  checkErrors(result);
  return { status: 'accepted', conversationUrn: urn, notificationStatus: status, result };
}

export async function setConversationRead(client, { conversationUrn: urn, read = true } = {}) {
  conversationUrn(urn);
  if (typeof read !== 'boolean') invalid('read must be a boolean.');
  const result = await client.request({ path: `${CONVERSATIONS}/${encodeURIComponent(urn)}`, method: 'POST', body: { patch: { $set: { read } } }, retry: false });
  checkErrors(result);
  return { status: 'accepted', conversationUrn: urn, read, result };
}
