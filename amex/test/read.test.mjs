import test from 'node:test';
import assert from 'node:assert/strict';
import { createReaders } from '../src/read.mjs';

const clone = value => structuredClone(value);
const session = ownerId => ({ validated: true, validatedAt: '2026-10-21T18:00:00Z', ownerId,
  sessionContext: `test-session-${ownerId}`, jsonWebToken: { rawToken: `test-jwt-${ownerId}` } });
function cards() {
  return [
    { cardId: 'test-native-card-A', accountToken: 'test-private-token-A', sortedIndex: 3,
      cardProductName: 'Test Card A', maskedAccountEnding: '••10001', default: true,
      overviewTab: { mainBalance: { label: 'Balance', value: '$25.00' }, paymentCTA: { ssoToken: 'test-action-secret' } } },
    { cardId: 'test-native-card-B', accountToken: 'test-private-token-B', sortedIndex: 5,
      cardProductName: 'Test Card B', maskedAccountEnding: '••10002', default: false },
  ];
}
function harness({ nativeCards = cards(), handle } = {}) {
  const state = new Map([['session', session('owner-A')]]);
  let clock = Date.parse('2026-10-21T18:00:00Z');
  let serial = 0;
  const requests = [];
  const tools = createReaders({
    read: async name => clone(state.get(name) ?? null),
    save: async (name, value) => { state.set(name, clone(value)); },
    lock: async operation => operation(), now: () => clock,
    uuid: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`,
    clientFactory: async ({ session: snapshot }) => ({ request: async spec => {
      requests.push({ ...clone(spec), sessionOwner: snapshot.ownerId });
      if (spec.path === '/services/accountservicing/v1/summary') return { status: { success: true }, summaryData: { cardList: clone(nativeCards) } };
      return handle ? handle(spec, state) : { status: { success: true }, data: {} };
    } }),
  });
  return { tools, state, requests, nativeCards, advance: duration => { clock += duration; } };
}

test('accounts expose stable local aliases across reordering and keep full bindings private', async () => {
  const h = harness();
  const first = await h.tools.readAccounts();
  assert.equal(first.phase, 'ready'); assert.equal(first.cards.length, 2);
  assert.match(first.cards[0].id, /^card-[a-f0-9]{24}$/u);
  const visible = JSON.stringify(first);
  for (const secret of ['test-native-card-A', 'test-private-token-A', 'test-action-secret', 'accountToken', 'cardKey', 'sortedIndex']) assert.equal(visible.includes(secret), false);
  assert.equal(h.state.get('account-cache').records[0].binding.accountToken, 'test-private-token-A');
  assert.equal(h.state.get('account-cache').data.cardList[0].accountToken, 'test-private-token-A');
  h.nativeCards.reverse();
  const second = await h.tools.readAccounts();
  assert.equal(second.cards.find(card => card.productName === 'Test Card A').id, first.cards[0].id);
});

test('owner-bound aliases cannot be used by another account', async () => {
  const h = harness();
  const accountA = await h.tools.readAccounts();
  h.state.set('session', session('owner-B'));
  const accountB = await h.tools.readAccounts();
  assert.notEqual(accountB.cards[0].id, accountA.cards[0].id);
  await assert.rejects(h.tools.resolveCard(accountA.cards[0].id), { code: 'AMEX_CARD_SELECTION_REQUIRED' });
  assert.equal(h.state.get('account-cache').ownerId, 'owner-B');
});

test('unvalidated sessions and ambiguous source bindings are rejected before use', async () => {
  const h = harness(); h.state.set('session', { ownerId: 'owner-A' });
  await assert.rejects(h.tools.readAccounts(), { code: 'AMEX_AUTH_REQUIRED' }); assert.equal(h.requests.length, 0);
  const duplicate = cards(); duplicate[1].cardId = duplicate[0].cardId;
  const ambiguous = harness({ nativeCards: duplicate });
  await assert.rejects(ambiguous.tools.readAccounts(), { code: 'AMEX_AMBIGUOUS_CARD_BINDING' });
  assert.equal(ambiguous.state.has('account-cache'), false);
  const fallback = cards(); delete fallback[0].cardId; delete fallback[1].cardId;
  const valid = harness({ nativeCards: fallback });
  const resolved = await valid.tools.resolveCard(); assert.equal(resolved.binding.sortedIndex, 3);
});

test('resolve reuses a recent cache and refreshes after expiry or new session context', async () => {
  const h = harness();
  await h.tools.resolveCard(); await h.tools.resolveCard(); assert.equal(h.requests.length, 1);
  h.advance(30_001); await h.tools.resolveCard(); assert.equal(h.requests.length, 2);
  h.state.get('session').sessionContext = 'test-fresh-same-account-session';
  await h.tools.resolveCard(); assert.equal(h.requests.length, 3);
});

test('opaque cursor alone inherits the exact account, card, dates, query and filters', async () => {
  const h = harness({ handle: spec => ({ status: { success: true }, data: {
    transactions: [{ identifier: `test-transaction-${spec.query.offset}`, description: 'Test coffee', amount: { amount: '4.25', currency: 'USD' }, accountToken: 'test-private-token-A', cardId: 'test-native-card-A' }],
    transactionsCount: 3, nextOffset: spec.query.offset === 0 ? 2 : null,
  } }) });
  const first = await h.tools.readTransactions({ description: 'coffee', startDate: '2026-10-01', endDate: '2026-10-21', sort: 'OLDEST', transactionType: 'DEBIT' });
  assert.equal(first.transactions.length, 1); assert.equal(first.hasMore, true); assert.match(first.cursor, /^amex-transactions:/u);
  assert.equal(JSON.stringify(first).includes('test-private-token-A'), false);
  assert.equal(JSON.stringify(first).includes('test-native-card-A'), false);
  const next = await h.tools.readTransactions({ cursor: first.cursor });
  assert.equal(next.transactions[0].identifier, 'test-transaction-2'); assert.equal(next.cursor, null); assert.equal(next.hasMore, false);
  const searches = h.requests.filter(spec => spec.path.endsWith('/search'));
  assert.equal(searches.length, 2);
  assert.deepEqual(searches[1].query, { accountToken: 'test-private-token-A', description: 'coffee', startDate: '2026-10-01', endDate: '2026-10-21', offset: 2, sort: 'OLDEST', transactionType: 'DEBIT' });
  const stored = [...h.state.entries()].find(([key]) => key.startsWith('transaction-cursor-'))[1];
  assert.equal(stored.ownerId, 'owner-A'); assert.equal(stored.card, first.card.id); assert.equal(stored.offset, 2);
});

test('cursor expiry, owner, card and filter changes fail before another request', async () => {
  const h = harness({ handle: () => ({ status: { success: true }, data: { transactions: [], transactionsCount: 2, nextOffset: 1 } }) });
  const first = await h.tools.readTransactions({ description: 'coffee' });
  const before = h.requests.length;
  await assert.rejects(h.tools.readTransactions({ cursor: first.cursor, description: 'different' }), { code: 'AMEX_CURSOR_CONTEXT_MISMATCH' });
  const otherCard = h.state.get('account-cache').records[1].id;
  await assert.rejects(h.tools.readTransactions({ cursor: first.cursor, card: otherCard }), { code: 'AMEX_CURSOR_CONTEXT_MISMATCH' });
  h.advance(3_600_001);
  await assert.rejects(h.tools.readTransactions({ cursor: first.cursor }), { code: 'AMEX_CURSOR_EXPIRED' });
  assert.equal(h.requests.length, before);
  h.state.set('session', session('owner-B'));
  await assert.rejects(h.tools.readTransactions({ cursor: first.cursor }), { code: 'AMEX_CURSOR_ACCOUNT_MISMATCH' });
  assert.equal(h.requests.length, before);
});

test('an account change while a read is in flight never returns or caches its data', async () => {
  const h = harness({ handle: (spec, state) => {
    state.set('session', session('owner-B'));
    return { status: { success: true }, data: { transactions: [{ identifier: 'test-account-A-data' }], transactionsCount: 1, nextOffset: null } };
  } });
  await assert.rejects(h.tools.readTransactions({}), { code: 'AMEX_ACCOUNT_CHANGED' });
  assert.equal([...h.state.keys()].some(name => name.startsWith('transactions-')), false);
});

test('nonadvancing pages and partial responses remain unknown rather than empty success', async () => {
  const h = harness({ handle: () => ({ status: { success: true }, data: { transactions: [{ identifier: 'test-one' }], transactionsCount: 1, nextOffset: 0 } }) });
  const result = await h.tools.readTransactions({});
  assert.equal(result.phase, 'unknown'); assert.equal(result.reason, 'nonadvancing_transaction_cursor'); assert.equal(result.cursor, null);
  const partial = harness({ handle: () => ({ status: { success: true }, data: {} }) });
  assert.equal((await partial.tools.readStatementPeriods({})).phase, 'unknown');
  const blocked = harness({ handle: () => ({ status: { success: true, secondaryAuthenticationV4: { type: 'OTP' } } }) });
  assert.equal((await blocked.tools.readPaymentActivity({})).phase, 'action_required');
});

test('details and payment reads take account bindings from the selected source card', async () => {
  const h = harness({ handle: spec => {
    if (spec.path.endsWith('/transactionDetails')) return { status: { success: true }, transaction: { identifier: 'test-id', status: 'POSTED', description: 'Test charge', accountToken: 'test-private-token-A' } };
    return { status: { success: true }, data: { items: [{ paymentID: 'test-payment' }] } };
  } });
  const detail = await h.tools.readTransactionDetails({ identifier: 'test-id', status: 'POSTED' });
  assert.equal(detail.phase, 'ready'); assert.equal(detail.transaction.identifier, 'test-id'); assert.equal(detail.transaction.accountToken, undefined);
  assert.deepEqual(h.requests.at(-1).query, { accountToken: 'test-private-token-A', identifier: 'test-id', status: 'POSTED' });
  await h.tools.readPaymentHistory({}); assert.deepEqual(h.requests.at(-1).body, { sortedIndex: 3 });
  await h.tools.readPaymentActivity({}); assert.equal(h.requests.at(-1).headers['x-axp-account-token'], 'test-private-token-A');
});
