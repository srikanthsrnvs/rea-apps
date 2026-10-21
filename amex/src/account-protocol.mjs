// Source: Amex Android 7.34.1, native account/transactions contracts.
// Pure request and response handling; no network, storage or account mutation.
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function requiredText(value, name, limit = 16384) {
  if (typeof value !== 'string' || !value.length || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`Invalid ${name}`);
  return value;
}
export function calendarDate(value, name = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new TypeError(`Invalid ${name}; use YYYY-MM-DD`);
  return value;
}
const pick = (source, keys) => isObject(source) ? Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, structuredClone(source[key])])) : undefined;
const optional = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
function readRequest(path, query = {}, headers = {}) { return { method: 'GET', path, query: optional(query), headers, sensitive: true, retry: false }; }
export function responseGate(response) {
  if (!isObject(response) || !isObject(response.status) || typeof response.status.success !== 'boolean') return { phase: 'unknown', reason: 'unrecognized_response_status' };
  const status = response.status;
  for (const key of ['secondaryAuthentication', 'secondaryAuthenticationV3', 'secondaryAuthenticationV4']) {
    if (status[key] !== undefined && status[key] !== null) return { phase: 'action_required', reason: key, challenge: structuredClone(status[key]), status: structuredClone(status) };
  }
  if (status.success !== true || status.errorMessage || status.errorScreen) return { phase: 'failed', status: structuredClone(status) };
  return { phase: 'ready' };
}
export function buildAccountSummary({ sessionContext, agent, googleWallet } = {}) {
  const body = { cardArtRequest: [] };
  if (sessionContext !== undefined) body.sessionContext = requiredText(sessionContext, 'session context');
  if (agent !== undefined) { if (!isObject(agent)) throw new TypeError('Invalid native agent data'); body.agent = structuredClone(agent); }
  if (googleWallet !== undefined) { if (!isObject(googleWallet)) throw new TypeError('Invalid native Google Wallet data'); body.googleWallet = structuredClone(googleWallet); }
  return { method: 'POST', path: '/services/accountservicing/v1/summary', body, sensitive: true, retry: false };
}
export function parseAccountSummary(response) {
  const gate = responseGate(response);
  if (gate.phase !== 'ready') return gate;
  if (!isObject(response.summaryData) || !Array.isArray(response.summaryData.cardList)) return { phase: 'unknown', reason: 'missing_card_list' };
  const data = structuredClone(response.summaryData);
  const cards = data.cardList.filter(isObject).map(card => optional({
    cardId: card.cardId, sortedIndex: card.sortedIndex, productName: card.cardProductName,
    ending: card.cardEndingDisplay ?? card.maskedAccountEnding ?? card.cardLast5Digits,
    nameOnCard: card.nameOnCard, canceled: card.canceled, isDefault: card.default,
    overview: pick(card.overviewTab, ['mainBalance', 'availableCredit', 'balanceDue', 'creditLimit', 'minimumPaymentDue', 'paymentDueHeader', 'paymentDueInfo', 'paymentDueInfoV2', 'recentCharges', 'spendingLimit']),
    financial: pick(card.financialTab, ['availableCredit', 'balanceDue', 'paymentDueInfo', 'recentCharges', 'recentPaymentsAndCredits', 'spendingLimit', 'statementBalance', 'totalBalance']), dueInFull: card.dueInFull,
    flexSelect: card.flexSelect, message: card.message, messages: card.messages,
  }));
  // Bindings and data contain secrets. Store privately; print cards only by default.
  const bindings = data.cardList.filter(card => isObject(card) && typeof card.accountToken === 'string' && card.accountToken).map(card => optional({ cardId: card.cardId, sortedIndex: card.sortedIndex, accountToken: card.accountToken, cardKey: card.cardKey, accountKey: card.accountKey }));
  return { phase: 'ready', cards, bindings, data };
}
export function buildTransactionsSearchInit({ accountToken } = {}) { return readRequest('/services/transactions/v1/search/init', {}, { 'x-axp-account-token': requiredText(accountToken, 'account token') }); }
export function buildTransactionsSearch({ accountToken, description, startDate, endDate, offset = 0, sort = 'NEWEST', transactionType = 'CREDIT_DEBIT' } = {}) {
  requiredText(accountToken, 'account token');
  if (description !== undefined) requiredText(description, 'search description', 2000);
  if (startDate !== undefined) calendarDate(startDate, 'start date');
  if (endDate !== undefined) calendarDate(endDate, 'end date');
  if (startDate && endDate && startDate > endDate) throw new RangeError('Start date must not follow end date');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Invalid transaction offset');
  if (!['NEWEST', 'OLDEST', 'AMOUNT_ASCENDING', 'AMOUNT_DESCENDING'].includes(sort)) throw new TypeError('Unsupported transaction sort');
  if (!['CREDIT', 'DEBIT', 'CREDIT_DEBIT'].includes(transactionType)) throw new TypeError('Unsupported transaction type');
  return readRequest('/services/transactions/v1/search', { accountToken, description, startDate, endDate, offset, sort, transactionType });
}
export function parseTransactionsSearch(response) {
  const gate = responseGate(response);
  if (gate.phase !== 'ready') return gate;
  const data = response.data;
  if (!isObject(data) || !Array.isArray(data.transactions) || !Number.isSafeInteger(data.transactionsCount) || data.transactionsCount < 0 || (data.nextOffset !== undefined && data.nextOffset !== null && (!Number.isSafeInteger(data.nextOffset) || data.nextOffset < 0))) return { phase: 'unknown', reason: 'unrecognized_transactions_page' };
  return { phase: 'ready', transactions: structuredClone(data.transactions), count: data.transactionsCount, nextOffset: data.nextOffset ?? null, hasMore: data.nextOffset !== undefined && data.nextOffset !== null, data: structuredClone(data) };
}
export function buildStatementPeriods({ accountToken } = {}) { return readRequest(`/services/transactions/v1/statementperiods/${encodeURIComponent(requiredText(accountToken, 'account token'))}`); }
export function parseStatementPeriods(response) {
  const gate = responseGate(response); if (gate.phase !== 'ready') return gate;
  if (!isObject(response.data) || !Array.isArray(response.data.statementPeriods)) return { phase: 'unknown', reason: 'missing_statement_periods' };
  return { phase: 'ready', periods: structuredClone(response.data.statementPeriods), data: structuredClone(response.data) };
}
export function buildTransactionSummary({ accountToken, statementEndDate } = {}) {
  if (statementEndDate !== undefined) calendarDate(statementEndDate, 'statement end date');
  return readRequest(`/services/transactions/v1/summary/${encodeURIComponent(requiredText(accountToken, 'account token'))}`, { statementEndDate });
}
export function buildTransactionDetails({ accountToken, identifier, status, statementEndDate } = {}) {
  requiredText(accountToken, 'account token'); requiredText(identifier, 'transaction identifier');
  if (!['FRAUD', 'PENDING', 'POSTED'].includes(status)) throw new TypeError('Transaction status must match the source transaction');
  if (statementEndDate !== undefined) calendarDate(statementEndDate, 'statement end date');
  return readRequest('/services/transactions/v1/transactionDetails', { accountToken, identifier, status, statementEndDate });
}
export function parseTransactionDetails(response) {
  const gate = responseGate(response); if (gate.phase !== 'ready') return gate;
  if (!isObject(response.transaction)) return { phase: 'unknown', reason: 'missing_transaction' };
  return { phase: 'ready', transaction: structuredClone(response.transaction) };
}
export function buildPaymentActivity({ accountToken } = {}) { return readRequest('/services/payment/v1/activity', {}, { 'x-axp-account-token': requiredText(accountToken, 'account token') }); }
export function buildPaymentHistory({ sortedIndex } = {}) {
  if (!Number.isSafeInteger(sortedIndex) || sortedIndex < 0) throw new TypeError('A source card sortedIndex is required');
  return { method: 'POST', path: '/services/payment/v1/history', body: { sortedIndex }, sensitive: true, retry: false };
}
export function parseNativeData(response) {
  const gate = responseGate(response); if (gate.phase !== 'ready') return gate;
  if (response.data === undefined || response.data === null) return { phase: 'unknown', reason: 'missing_native_data' };
  return { phase: 'ready', data: structuredClone(response.data) };
}
