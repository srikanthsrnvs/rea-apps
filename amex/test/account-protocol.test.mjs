import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAccountSummary, parseAccountSummary, buildTransactionsSearch, buildTransactionsSearchInit, parseTransactionsSearch, buildStatementPeriods, parseStatementPeriods, buildTransactionDetails, parseTransactionDetails, buildPaymentActivity, buildPaymentHistory, responseGate } from '../src/account-protocol.mjs';

test('account summary uses native body and keeps token bindings outside display cards', () => {
  assert.deepEqual(buildAccountSummary({ sessionContext: 'test-session' }), { method: 'POST', path: '/services/accountservicing/v1/summary', body: { cardArtRequest: [], sessionContext: 'test-session' }, sensitive: true, retry: false });
  const parsed = parseAccountSummary({ status: { success: true }, summaryData: { cardList: [{ cardId: 'test-card', accountToken: 'test-secret', cardProductName: 'Test Card', cardEndingDisplay: '••12345', sortedIndex: 1, overviewTab: { mainBalance: { label: 'Balance', value: '$12.30' } } }] } });
  assert.equal(parsed.phase, 'ready'); assert.equal(parsed.bindings[0].accountToken, 'test-secret');
  assert.equal(JSON.stringify(parsed.cards).includes('test-secret'), false);
  assert.equal(parsed.cards[0].productName, 'Test Card');
});
test('no successful envelope bypasses an outstanding step-up or error', () => {
  for (const field of ['secondaryAuthentication', 'secondaryAuthenticationV3', 'secondaryAuthenticationV4']) assert.equal(responseGate({ status: { success: true, [field]: { type: 'OTP' } } }).phase, 'action_required');
  assert.equal(responseGate({ status: { success: true, errorMessage: { title: 'Error' } } }).phase, 'failed');
  assert.equal(parseAccountSummary({ status: { success: true }, summaryData: {} }).phase, 'unknown');
});
test('transactions search binds dates, filters and exact offset without inventing pagination', () => {
  const request = buildTransactionsSearch({ accountToken: 'test-account', description: 'coffee', startDate: '2026-10-01', endDate: '2026-10-21', offset: 20, sort: 'OLDEST', transactionType: 'DEBIT' });
  assert.equal(buildTransactionsSearchInit({ accountToken: 'test-account' }).headers['x-axp-account-token'], 'test-account');
  assert.equal(request.method, 'GET'); assert.equal(request.query.offset, 20); assert.equal(request.query.accountToken, 'test-account');
  assert.throws(() => buildTransactionsSearch({ accountToken: 'test', startDate: '2026-02-30' }));
  assert.throws(() => buildTransactionsSearch({ accountToken: 'test', startDate: '2026-10-21', endDate: '2026-10-01' }));
  assert.throws(() => buildTransactionsSearch({ accountToken: 'test', offset: -1 }));
  assert.throws(() => buildTransactionsSearch({ accountToken: 'test', sort: 'SURPRISE' }));
  const source = { status: { success: true }, data: { transactions: [{ identifier: 'test-transaction' }], transactionsCount: 31, nextOffset: 20 } };
  const parsed = parseTransactionsSearch(source); assert.equal(parsed.hasMore, true); assert.equal(parsed.nextOffset, 20);
  parsed.transactions[0].identifier = 'changed'; assert.equal(source.data.transactions[0].identifier, 'test-transaction');
  assert.equal(parseTransactionsSearch({ status: { success: true }, data: { transactions: [], transactionsCount: 0, nextOffset: null } }).hasMore, false);
  assert.equal(parseTransactionsSearch({ status: { success: true }, data: { transactions: [], transactionsCount: 0, nextOffset: '20' } }).phase, 'unknown');
});
test('statement periods and details preserve native identity and reject mismatched status names', () => {
  assert.equal(buildStatementPeriods({ accountToken: 'test/a' }).path, '/services/transactions/v1/statementperiods/test%2Fa');
  assert.equal(parseStatementPeriods({ status: { success: true }, data: { statementPeriods: [{ index: 1, endDate: '2026-09-30', label: 'September' }] } }).periods.length, 1);
  const request = buildTransactionDetails({ accountToken: 'test-account', identifier: 'test-transaction', status: 'PENDING' });
  assert.equal(request.query.status, 'PENDING'); assert.equal(request.query.identifier, 'test-transaction');
  assert.throws(() => buildTransactionDetails({ accountToken: 'test-account', identifier: 'test-transaction', status: 'completed' }));
  assert.equal(parseTransactionDetails({ status: { success: true }, transaction: { identifier: 'test-transaction' } }).phase, 'ready');
});
test('payment activity read and payment history POST are exact source-backed reads', () => {
  assert.deepEqual(buildPaymentActivity({ accountToken: 'test-account' }).headers, { 'x-axp-account-token': 'test-account' });
  assert.deepEqual(buildPaymentHistory({ sortedIndex: 3 }).body, { sortedIndex: 3 });
  assert.throws(() => buildPaymentHistory({ sortedIndex: '3' }));
});
