import { createHash, randomUUID } from 'node:crypto';
import { readState, saveState, withStateLock } from './state.mjs';
import { AmexError } from './errors.mjs';
import {
  buildAccountSummary, parseAccountSummary, buildTransactionsSearch,
  parseTransactionsSearch, buildStatementPeriods, parseStatementPeriods,
  buildTransactionDetails, parseTransactionDetails, buildPaymentHistory,
  buildPaymentActivity, parseNativeData,
} from './account-protocol.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const FILTERS = ['description', 'startDate', 'endDate', 'sort', 'transactionType'];
const CURSOR_PREFIX = 'amex-transactions:';
const CACHE_TTL = 30_000;
const CURSOR_TTL = 3_600_000;
const validSession = session => session?.validated === true && typeof session.ownerId === 'string' && session.ownerId.length > 0;
function requireSession(session) {
  if (!validSession(session)) throw new AmexError('AMEX_AUTH_REQUIRED', 'A validated Amex session is required. Run amex login.');
  return session;
}
function sessionKey(session) { return hash([session.ownerId, session.sessionContext, session.jsonWebToken?.rawToken]); }
function maskedEnding(card) { return card.cardEndingDisplay ?? card.maskedAccountEnding ?? card.cardLast5Digits; }
function nativeKey(card) {
  if (typeof card.cardId === 'string' && card.cardId.length) return ['cardId', card.cardId];
  const ending = maskedEnding(card);
  if (Number.isSafeInteger(card.sortedIndex) && card.sortedIndex >= 0 && typeof ending === 'string' && ending.length) return ['sortedIndexAndEnding', card.sortedIndex, ending];
  throw new AmexError('AMEX_CARD_BINDING_UNKNOWN', 'Amex returned a card without a stable supported identity.');
}
function secretValues(session, cache) {
  return [session.jsonWebToken?.rawToken, session.gateKeeperCookie, session.cupcake,
    session.sessionContext, session.riskToken, ...(cache?.records ?? []).flatMap(record => Object.values(record.binding))]
    .filter(value => typeof value === 'string' && value.length);
}
function displayData(value, secrets = []) {
  if (Array.isArray(value)) return value.map(item => displayData(item, secrets) ?? null);
  if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:token|cardid|cardkey|accountkey|sessioncontext|gatekeeper|cupcake|additionalheaders|authorization|password)/iu.test(key)
    && !/^(?:sso|url|link|action|actions|callToAction|__proto__|constructor|prototype)$/iu.test(key))
    .map(([key, item]) => [key, displayData(item, secrets)]).filter(([, item]) => item !== undefined));
  if (typeof value === 'string' && secrets.some(secret => value === secret || (secret.length >= 8 && value.includes(secret)))) return undefined;
  return value;
}
function makeCache(parsed, session, now) {
  const source = parsed.data.cardList.filter(object);
  const seenKeys = new Set();
  const records = [];
  for (let index = 0; index < source.length; index++) {
    const card = source[index];
    if (typeof card.accountToken !== 'string' || !card.accountToken.length) continue;
    const key = nativeKey(card);
    const identity = JSON.stringify(key);
    if (seenKeys.has(identity)) throw new AmexError('AMEX_AMBIGUOUS_CARD_BINDING', 'Amex returned ambiguous card identities. No card was selected.');
    seenKeys.add(identity);
    const id = `card-${hash([session.ownerId, key]).slice(0, 24)}`;
    if (records.some(record => record.id === id)) throw new AmexError('AMEX_AMBIGUOUS_CARD_BINDING', 'Local card identities collide.');
    const binding = Object.fromEntries(['cardId', 'sortedIndex', 'accountToken', 'cardKey', 'accountKey'].filter(name => card[name] !== undefined).map(name => [name, card[name]]));
    const publicCard = structuredClone(parsed.cards[index]);
    delete publicCard.cardId; delete publicCard.sortedIndex;
    records.push({ id, card: { id, ...publicCard }, binding });
  }
  return { version: 1, ownerId: session.ownerId, sessionKey: sessionKey(session), fetchedAt: now,
    expiresAt: now + CACHE_TTL, records, data: parsed.data };
}
function checkCache(cache, session, now) {
  return cache?.version === 1 && cache.ownerId === session.ownerId && cache.sessionKey === sessionKey(session)
    && Number.isFinite(cache.expiresAt) && cache.expiresAt > now && Array.isArray(cache.records) && cache.records.length > 0;
}

// Dependency injection keeps account/cursor race tests completely offline.
export function createReaders({ read = readState, save = saveState, lock = withStateLock,
  now = Date.now, uuid = randomUUID, clientFactory = async options => (await import('./client.mjs')).createClient(options) } = {}) {
  const snapshot = () => lock(async () => requireSession(await read('session')));
  async function sameOwner(session) {
    const current = requireSession(await read('session'));
    if (current.ownerId !== session.ownerId) throw new AmexError('AMEX_ACCOUNT_CHANGED', 'The signed-in Amex account changed. Run the command again.');
    return current;
  }
  async function saveResponse(session, name, response, extra = {}) {
    await lock(async () => { await sameOwner(session); await save(name, { version: 1, ownerId: session.ownerId, fetchedAt: now(), ...extra, response }); });
  }
  async function refreshAccounts(session) {
    const client = await clientFactory({ session });
    const response = await client.request(buildAccountSummary({ sessionContext: session.sessionContext }));
    const parsed = parseAccountSummary(response);
    if (parsed.phase !== 'ready') {
      await saveResponse(session, 'account-response', response);
      return { result: displayData(parsed, secretValues(session)) };
    }
    const cache = makeCache(parsed, session, now());
    await lock(async () => { await sameOwner(session); await save('account-cache', cache); });
    if (!cache.records.length) return { result: { phase: 'action_required', reason: 'no_supported_cards', message: 'Amex returned no selectable card account.' } };
    return { cache };
  }
  async function readAccounts() {
    const session = await snapshot();
    const { cache, result } = await refreshAccounts(session);
    return result ?? { phase: 'ready', cards: cache.records.map(record => displayData(record.card, secretValues(session, cache))) };
  }
  async function resolveCard(cardId) {
    const session = await snapshot();
    let cache = await lock(() => read('account-cache'));
    if (!checkCache(cache, session, now())) {
      const refreshed = await refreshAccounts(session);
      if (refreshed.result) return { session, result: refreshed.result };
      cache = refreshed.cache;
    }
    let matches;
    if (cardId !== undefined && cardId !== null) {
      if (typeof cardId !== 'string' || !/^card-[a-f0-9]{24}$/u.test(cardId)) throw new AmexError('AMEX_CARD_ID_INVALID', 'Use a local card ID from amex accounts.');
      matches = cache.records.filter(record => record.id === cardId);
    } else {
      matches = cache.records.filter(record => record.card.isDefault === true);
      if (!matches.length && cache.records.length === 1) matches = cache.records;
    }
    if (matches.length !== 1) throw new AmexError('AMEX_CARD_SELECTION_REQUIRED', 'Choose one current card ID from amex accounts.');
    await lock(() => sameOwner(session));
    const selected = matches[0];
    return { session, card: displayData(selected.card, secretValues(session, cache)), binding: structuredClone(selected.binding) };
  }
  async function selectedRead(cardId, name, builder, parser, options = {}) {
    const selected = await resolveCard(cardId);
    if (selected.result) return selected.result;
    const { session, card, binding } = selected;
    const client = await clientFactory({ session });
    const response = await client.request(builder({ ...options, ...binding }));
    await saveResponse(session, `${name}-${card.id}`, response, { card: card.id });
    return { ...displayData(parser(response), secretValues(session, { records: [{ binding }] })), card };
  }
  async function readTransactions(options = {}) {
    if (!object(options)) throw new TypeError('Transaction options must be an object');
    let context;
    let cursorId;
    const startingSession = await snapshot();
    if (options.cursor !== undefined) {
      if (typeof options.cursor !== 'string' || !options.cursor.startsWith(CURSOR_PREFIX)) throw new AmexError('AMEX_CURSOR_INVALID', 'Use a transaction cursor returned by this CLI.');
      cursorId = options.cursor.slice(CURSOR_PREFIX.length);
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(cursorId)) throw new AmexError('AMEX_CURSOR_INVALID', 'Invalid transaction cursor.');
      context = await lock(() => read(`transaction-cursor-${cursorId}`));
      if (context?.version !== 1 || context.ownerId !== startingSession.ownerId) throw new AmexError('AMEX_CURSOR_ACCOUNT_MISMATCH', 'This cursor does not belong to the signed-in account.');
      if (!object(context.filters) || typeof context.card !== 'string' || !/^card-[a-f0-9]{24}$/u.test(context.card) || !Number.isSafeInteger(context.offset) || context.offset <= 0) throw new AmexError('AMEX_CURSOR_INVALID', 'The stored transaction cursor is invalid.');
      if (!Number.isFinite(context.expiresAt) || context.expiresAt <= now()) throw new AmexError('AMEX_CURSOR_EXPIRED', 'This transaction cursor expired. Start a new search.');
      if (options.card !== undefined && options.card !== context.card) throw new AmexError('AMEX_CURSOR_CONTEXT_MISMATCH', 'The cursor belongs to a different card.');
      for (const key of FILTERS) if (options[key] !== undefined && options[key] !== context.filters[key]) throw new AmexError('AMEX_CURSOR_CONTEXT_MISMATCH', `The cursor belongs to a different ${key}.`);
    }
    const cardId = context?.card ?? options.card;
    const selected = await resolveCard(cardId);
    if (selected.result) return selected.result;
    const { session, card, binding } = selected;
    if (startingSession.ownerId !== session.ownerId) throw new AmexError('AMEX_ACCOUNT_CHANGED', 'The signed-in Amex account changed.');
    const filters = context?.filters ?? Object.fromEntries(FILTERS.filter(key => options[key] !== undefined).map(key => [key, options[key]]));
    const offset = context?.offset ?? 0;
    const spec = buildTransactionsSearch({ ...filters, offset, accountToken: binding.accountToken });
    const client = await clientFactory({ session });
    const response = await client.request(spec);
    const parsed = parseTransactionsSearch(response);
    const result = { ...displayData(parsed, secretValues(session, { records: [{ binding }] })), card };
    // The opaque cursor is the public continuation; upstream offsets stay private.
    delete result.data; delete result.nextOffset;
    if (parsed.phase === 'ready' && parsed.hasMore && parsed.nextOffset <= offset) {
      result.phase = 'unknown'; result.reason = 'nonadvancing_transaction_cursor'; result.hasMore = null;
    }
    await lock(async () => {
      await sameOwner(session);
      await save(`transactions-${card.id}`, { version: 1, ownerId: session.ownerId, card: card.id, fetchedAt: now(), filters: spec.query, response });
      if (result.phase === 'ready' && parsed.hasMore) {
        const nextId = uuid();
        await save(`transaction-cursor-${nextId}`, { version: 1, ownerId: session.ownerId, card: card.id,
          filters: Object.fromEntries(FILTERS.filter(key => spec.query[key] !== undefined).map(key => [key, spec.query[key]])),
          offset: parsed.nextOffset, createdAt: now(), expiresAt: context?.expiresAt ?? now() + CURSOR_TTL });
        result.cursor = `${CURSOR_PREFIX}${nextId}`;
      } else result.cursor = null;
    });
    return result;
  }
  const readStatementPeriods = ({ card } = {}) => selectedRead(card, 'statement-periods', buildStatementPeriods, parseStatementPeriods);
  const readTransactionDetails = ({ card, identifier, status, statementEndDate } = {}) => selectedRead(card, 'transaction-detail', buildTransactionDetails, parseTransactionDetails, { identifier, status, statementEndDate });
  const readPaymentHistory = ({ card } = {}) => selectedRead(card, 'payment-history', buildPaymentHistory, parseNativeData);
  const readPaymentActivity = ({ card } = {}) => selectedRead(card, 'payment-activity', buildPaymentActivity, parseNativeData);
  return { readAccounts, resolveCard, readTransactions, readStatementPeriods, readTransactionDetails, readPaymentHistory, readPaymentActivity };
}
export const { readAccounts, resolveCard, readTransactions, readStatementPeriods, readTransactionDetails,
  readPaymentHistory, readPaymentActivity } = createReaders();
