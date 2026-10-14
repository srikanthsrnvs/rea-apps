import test from 'node:test';
import assert from 'node:assert/strict';
import { profile, membership, rewards, purchaseHistory, receipt, accountData, normalizeMembership } from '../src/account.mjs';

function fixture(response, { loggedIn = true } = {}) {
  const values = new Map(loggedIn ? [['session', { token: 'synthetic-session-token', deviceId: 'test-device' }]] : []);
  const calls = [];
  const store = {
    async readState(name) { return values.get(name) ?? null; },
    async saveState(name, data) { values.set(name, data); },
    async withStateLock(callback) { return callback(); },
  };
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return Response.json(response); };
  return { values, calls, dependencies: { store, fetchImpl } };
}
const userResponse = () => ({ error: 0, message: 'OK', token: 'DO_NOT_EXPORT_AUTH', balance: '$001.20', membership_expired: false,
  user: { _id: 'test-user', first_name: 'Alex', last_name: 'Example', email: 'alex@example.invalid', phone: '2025550100', status: 'active',
    auto_renew: 'yes', stripe_payment_method: 'DO_NOT_EXPORT_STRIPE', ecrs: { receipt: 'on' },
    address: [{ street: 'DO_NOT_EXPORT_STREET' }],
    homesome: { authToken: 'DO_NOT_EXPORT_HOMESOME', paymentMethods: [{ pmid: 'DO_NOT_EXPORT_HOME', default: true, cardBrand: 'visa', cardLast4: '1234', paymentProcessor: 'stripe', billingAddress: { street: 'DO_NOT_EXPORT_BILLING' } }],
      paymentMethod: { pmid: 'DO_NOT_EXPORT_HOME', default: true, cardBrand: 'visa', cardLast4: '1234' } } },
  paymentMethods: { id: 'DO_NOT_EXPORT_STRIPE', customer: 'DO_NOT_EXPORT_CUSTOMER', billing_details: { address: { line1: 'DO_NOT_EXPORT_BILLING' } }, card: { brand: 'visa', last4: '5678', exp_month: 9, exp_year: 2030, fingerprint: 'DO_NOT_EXPORT_FINGERPRINT' } },
});

test('profile uses authenticated GET without body and summarizes object/array payment methods', async () => {
  const f = fixture(userResponse());
  const result = await profile({}, f.dependencies);
  assert.equal(f.calls[0].url, 'https://ordersapi.enfmkt.com/v1/userprofile');
  assert.equal(f.calls[0].options.method, 'GET');
  assert.equal(Object.hasOwn(f.calls[0].options, 'body'), false);
  assert.equal(f.calls[0].options.headers.Authorization, 'Bearer synthetic-session-token');
  assert.equal(result.balance, '$001.20');
  assert.equal(result.membershipExpired, false);
  assert.equal(result.receiptPreference, 'on');
  assert.deepEqual(result.paymentMethods, [
    { source: 'stripe', brand: 'visa', last4: '5678', expiryMonth: 9, expiryYear: 2030, isDefault: true, paymentProcessor: 'stripe' },
    { source: 'homesome', brand: 'visa', last4: '1234', expiryMonth: null, expiryYear: null, isDefault: true, paymentProcessor: 'stripe' },
  ]);
  assert.equal(JSON.stringify(result).includes('DO_NOT_EXPORT'), false);
});

test('raw profile preserves account data while removing nested auth and payment credentials', async () => {
  const f = fixture(userResponse());
  const result = await profile({ raw: true }, f.dependencies);
  assert.equal(result.user.first_name, 'Alex');
  assert.equal(result.user.address[0].street, 'DO_NOT_EXPORT_STREET');
  assert.equal(result.paymentMethods.card.last4, '5678');
  for (const text of ['DO_NOT_EXPORT_AUTH', 'DO_NOT_EXPORT_HOMESOME', 'DO_NOT_EXPORT_STRIPE', 'DO_NOT_EXPORT_HOME', 'DO_NOT_EXPORT_FINGERPRINT', 'DO_NOT_EXPORT_CUSTOMER']) assert.equal(JSON.stringify(result).includes(text), false);
});

test('membership keeps benefits/native fields and exact money strings with unknown expiration', async () => {
  const f = fixture({ error: 0, message: 'OK', ecrs_data: { balance: '$0009.90', membership_expired: null, exp_date_ymd: '2031-03-04', stripe_customer_id: 'DO_NOT_EXPORT_BILLING_ID' },
    current_tier: { name: 'Example Tier', tiers_id: 'test-tier' }, membership_data: { membership_status: 'Current', progressbar_spend_amount: 87.4 },
    member_benefits: [{ name: 'Example benefit', is_locked: false }], progressbar_arr: [{ current_tier: true }] });
  const result = await membership({}, f.dependencies);
  assert.equal(f.calls[0].url, 'https://ordersapi.enfmkt.com/v2/myerewhon');
  assert.equal(f.calls[0].options.method, 'POST');
  assert.equal(Object.hasOwn(f.calls[0].options, 'body'), false);
  assert.deepEqual(result.summary, { tier: 'Example Tier', membershipType: null, status: 'Current', balance: '$0009.90', expiresOn: '2031-03-04', expired: null });
  assert.equal(result.member_benefits[0].is_locked, false);
  assert.equal(result.membership_data.progressbar_spend_amount, 87.4);
  assert.equal(JSON.stringify(result).includes('DO_NOT_EXPORT'), false);
});

test('nullable membership does not fabricate a free tier, zero balance, or active status', () => {
  const result = normalizeMembership({ error: 0, message: 'OK', ecrs_data: null, current_tier: null, membership_data: null, tier_card_obj: null });
  assert.deepEqual(result.summary, { tier: null, membershipType: null, status: null, balance: null, expiresOn: null, expired: null });
});

test('redemption is a read of paginated history and keeps formatted amounts', async () => {
  const rows = Array.from({ length: 11 }, () => ({ TRN_DATE: '2030-01-02', LOL_Amount_TXT: '$02.00', STO_Name: 'Example Store' }));
  const f = fixture({ error: 0, message: 'OK', activity_data: rows });
  const result = await rewards({ type: 'redemption', page: 2 }, f.dependencies);
  assert.equal(f.calls[0].url, 'https://ordersapi.enfmkt.com/v2/activitylog');
  assert.equal(f.calls[0].options.body, 'type=redemption&page=2');
  assert.equal(result.type, 'redemption'); assert.equal(result.page, 2);
  assert.equal(result.mayHaveMore, true); assert.equal(result.nextPage, 3);
  assert.deepEqual(result.items[0], { date: '2030-01-02', amount: '$02.00', store: 'Example Store' });
});

test('rewards exposes the source paging boundary without inventing a server total', async () => {
  for (const length of [0, 10]) {
    const f = fixture({ error: 0, message: 'OK', activity_data: Array.from({ length }, () => ({})) });
    const result = await rewards({}, f.dependencies);
    assert.equal(result.mayHaveMore, false); assert.equal(result.nextPage, null);
    assert.equal(Object.hasOwn(result, 'total'), false);
  }
});

test('invalid rewards enum/pages are rejected before requesting the account', async () => {
  const f = fixture();
  for (const options of [{ type: 'redeem' }, { page: 0 }, { page: 1.5 }, { page: NaN }, { page: Number.MAX_SAFE_INTEGER + 1 }]) await assert.rejects(rewards(options, f.dependencies), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.calls.length, 0);
});

test('in-store history encodes exact filters and returns receipt keys with filter metadata', async () => {
  const f = fixture({ error: 0, message: 'OK', data: [{ TRN_CPK: 'cpk-test', TRN_PK: 17, TRN_DATE1: '2030-03-04', STO_Name: 'Test Store', TRN_NetSales: '0012.80', points_earned: 1.28 }], date_range: [{ key: 'month' }], order_method: [{ key: 'pos' }] });
  const result = await purchaseHistory({ page: 3, dateKey: 'this month', methodKeys: ['pos', 'pickup'] }, f.dependencies);
  assert.equal(f.calls[0].url, 'https://ordersapi.enfmkt.com/v1/myorders');
  assert.equal(f.calls[0].options.body, 'type=instore&pageno=3&date_key=this+month&order_method_key=pos%2Cpickup');
  assert.equal(new URLSearchParams(f.calls[0].options.body).has('client_id'), false);
  assert.equal(result.nextPage, 4);
  assert.deepEqual(result.items[0], { trnCpk: 'cpk-test', trnPk: 17, date: '2030-03-04', store: 'Test Store', amount: '0012.80', pointsEarned: 1.28 });
  assert.deepEqual(result.dateFilters, [{ key: 'month' }]);
});

test('an empty purchase history page stops paging and empty method filters are omitted', async () => {
  const f = fixture({ error: 0, message: 'OK', data: [] });
  const result = await purchaseHistory({ page: 2, methodKeys: [] }, f.dependencies);
  assert.equal(result.nextPage, null); assert.deepEqual(result.items, []);
  assert.equal(f.calls[0].options.body, 'type=instore&pageno=2');
});

test('history filters reject structured or empty values before transport', async () => {
  const f = fixture();
  for (const options of [{ page: -1 }, { dateKey: {} }, { dateKey: '' }, { methodKeys: 'pickup' }, { methodKeys: [''] }]) await assert.rejects(purchaseHistory(options, f.dependencies), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.calls.length, 0);
});

test('receipt uses both transaction keys without confusing receipt preference with a document', async () => {
  const f = fixture({ error: 0, message: 'OK', data: { header: { receipt_number: 'TEST-17', receipt_total: '$18.00' }, items: [{ number: 2, name: 'Test item' }], billingAddress: { street: 'DO_NOT_EXPORT_STREET' }, card: { number: 'DO_NOT_EXPORT_PAN', last4: '1234' }, token: 'DO_NOT_EXPORT_TOKEN' } });
  const result = await receipt({ trnCpk: 'cpk-test', trnPk: 17 }, f.dependencies);
  assert.equal(f.calls[0].url, 'https://ordersapi.enfmkt.com/v1/transaction_detail');
  assert.equal(f.calls[0].options.body, 'trn_cpk=cpk-test&trn_pk=17');
  assert.equal(result.header.receipt_number, 'TEST-17');
  assert.equal(result.items[0].number, 2);
  assert.equal(result.card.last4, '1234');
  assert.equal(JSON.stringify(result).includes('DO_NOT_EXPORT'), false);
});

test('receipt requires a valid pair of transaction keys before transport', async () => {
  const f = fixture();
  for (const options of [{}, { trnCpk: 'on', trnPk: undefined }, { trnCpk: {}, trnPk: 1 }, { trnCpk: 'x', trnPk: NaN }]) await assert.rejects(receipt(options, f.dependencies), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.calls.length, 0);
});

test('membership and history tools reject malformed success payloads', async () => {
  for (const operation of [profile, membership, rewards, purchaseHistory]) {
    const f = fixture({ error: 0, message: 'OK' });
    await assert.rejects(operation({}, f.dependencies), { code: 'INVALID_RESPONSE' });
    assert.equal(f.calls.length, 1);
  }
  const f = fixture({ error: 0, message: 'OK', data: null });
  await assert.rejects(receipt({ trnCpk: 'x', trnPk: 1 }, f.dependencies), { code: 'INVALID_RESPONSE' });
});

test('all account reads require login before fetch and honor server error3', async () => {
  for (const operation of [profile, membership, rewards, purchaseHistory]) {
    const missing = fixture({}, { loggedIn: false });
    await assert.rejects(operation({}, missing.dependencies), { code: 'AUTH_REQUIRED' });
    assert.equal(missing.calls.length, 0);
    const rejected = fixture({ error: 3, message: 'test' });
    await assert.rejects(operation({}, rejected.dependencies), { code: 'AUTH_REQUIRED' });
    assert.equal(rejected.calls.length, 1);
    assert.equal(rejected.values.get('session').token, 'synthetic-session-token');
  }
  const missing = fixture({}, { loggedIn: false });
  await assert.rejects(receipt({ trnCpk: 'x', trnPk: 1 }, missing.dependencies), { code: 'AUTH_REQUIRED' });
  assert.equal(missing.calls.length, 0);
});

test('invalid native objects or null history rows are rejected as structured response errors', async () => {
  for (const [operation, response] of [
    [membership, { error: 0, message: 'OK', ecrs_data: 'unrecognized' }],
    [rewards, { error: 0, message: 'OK', activity_data: [null] }],
    [purchaseHistory, { error: 0, message: 'OK', data: [null] }],
  ]) {
    const f = fixture(response);
    await assert.rejects(operation({}, f.dependencies), { code: 'INVALID_RESPONSE' });
  }
});

test('sanitization retains zero/false/null and nested receipt data without full billing', () => {
  const result = accountData({ amount: 0, confirmed: false, unknown: null, data: [{ paymentMethods: [{ id: 'DO_NOT_EXPORT_ID', card: { last4: '1234' }, billing_details: { name: 'DO_NOT_EXPORT_NAME' } }] }] });
  assert.deepEqual(result, { amount: 0, confirmed: false, unknown: null, data: [{ paymentMethods: [{ card: { last4: '1234' } }] }] });
});
