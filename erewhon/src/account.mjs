import { authenticatedRequest, ApiError } from './http.mjs';

function invalid(message) { throw new ApiError('INVALID_ARGUMENT', message); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function pageNumber(page) {
  if (!Number.isSafeInteger(page) || page < 1) invalid('Page must be a positive integer.');
  return page;
}
function identifier(value, label) {
  if (!['string', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value) || !String(value).trim() || /[\r\n]/.test(String(value))) invalid(`Supply the ${label} returned by Erewhon.`);
  return value;
}

// Raw output is still not a credential export. Payment instrument identifiers
// are useful internally to checkout, but account inspection returns card labels.
const credentialKeys = new Set([
  'token', 'authtoken', 'accesstoken', 'refreshtoken', 'authorization', 'cookie', 'cookies',
  'password', 'secret', 'clientsecret', 'apikey', 'otp', 'otpcode', 'verificationcode',
  'cardtoken', 'stripepaymentmethod', 'pmid', 'paymentmethodid', 'sharedpaymentgrantedtoken',
  'fingerprint', 'cardnumber', 'cvc', 'cvv', 'stripecustomerid',
]);
const billingKeys = new Set(['billingaddress', 'billingdetails', 'billing', 'billtoemail']);
const keyName = key => key.toLowerCase().replace(/[^a-z0-9]/g, '');

export function accountData(value, { raw = false } = {}, path = []) {
  if (Array.isArray(value)) return value.map(item => accountData(item, { raw }, path));
  if (!record(value)) return value;
  const paymentContext = path.some(key => ['paymentmethods', 'paymentmethod', 'card', 'wallet'].includes(keyName(key)));
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const normalized = keyName(key);
    if (credentialKeys.has(normalized) || paymentContext && ['id', 'number', 'customer', 'customeraccount', 'metadata', 'generatedfrom', 'checks'].includes(normalized) || !raw && billingKeys.has(normalized)) return [];
    return [[key, accountData(item, { raw }, [...path, key])]];
  }));
}

function cards(response) {
  const user = response.user, home = user.homesome;
  const result = [], seen = new Set();
  function add(method, source) {
    if (!record(method)) return;
    const card = record(method.card) ? method.card : method;
    const last4 = card.last4 ?? card.cardLast4;
    if (typeof last4 !== 'string' || !/^\d{4}$/.test(last4)) return;
    const brand = card.display_brand ?? card.brand ?? card.cardBrand ?? null;
    const identity = method.id ?? method.pmid;
    const unique = `${source}:${identity ?? JSON.stringify([brand, last4, card.exp_month, card.exp_year])}`;
    if (seen.has(unique)) return;
    seen.add(unique);
    result.push({ source, brand, last4, expiryMonth: card.exp_month ?? null, expiryYear: card.exp_year ?? null,
      isDefault: typeof method.default === 'boolean' ? method.default : identity && user.stripe_payment_method ? identity === user.stripe_payment_method : null,
      paymentProcessor: method.paymentProcessor ?? (source === 'stripe' ? 'stripe' : null) });
  }
  for (const method of Array.isArray(response.paymentMethods) ? response.paymentMethods : [response.paymentMethods]) add(method, 'stripe');
  if (record(home)) {
    for (const method of Array.isArray(home.paymentMethods) ? home.paymentMethods : []) add(method, 'homesome');
    add(home.paymentMethod, 'homesome');
  }
  return result;
}

export function normalizeProfile(response, { raw = false } = {}) {
  if (!record(response?.user)) throw new ApiError('INVALID_RESPONSE', 'Erewhon did not return a user profile.');
  if (raw) return accountData(response, { raw });
  const user = response.user, ecrs = record(user.ecrs) ? user.ecrs : {};
  return {
    id: user._id ?? null, firstName: user.first_name ?? null, lastName: user.last_name ?? null,
    email: user.email ?? null, phone: user.phone ?? null, status: user.status ?? null,
    membershipType: response.membership_type ?? user.membership_type ?? ecrs.membership_type ?? null,
    balance: response.balance ?? user.balance ?? ecrs.balance ?? null,
    displayBalance: response.display_balance ?? null, balanceLabel: response.balance_label ?? null,
    membershipExpired: response.membership_expired ?? ecrs.membership_expired ?? null,
    autoRenew: user.auto_renew ?? null, receiptPreference: ecrs.receipt ?? null,
    paymentMethods: cards(response),
  };
}

export function normalizeMembership(response, { raw = false } = {}) {
  const fields = ['ecrs_data', 'current_tier', 'membership_data', 'tier_card_obj'];
  if (!record(response) || !fields.some(key => Object.hasOwn(response, key)) || fields.some(key => Object.hasOwn(response, key) && response[key] !== null && !record(response[key]))) throw new ApiError('INVALID_RESPONSE', 'Erewhon did not return a membership response.');
  const safe = accountData(response, { raw });
  if (raw) return safe;
  const ecrs = record(response.ecrs_data) ? response.ecrs_data : {};
  const card = record(response.tier_card_obj) ? response.tier_card_obj : {};
  const details = record(response.membership_data) ? response.membership_data : {};
  return {
    summary: {
      tier: response.current_tier?.name ?? ecrs.tiers_name ?? card.name ?? null,
      membershipType: details.membership_type ?? ecrs.membership_type ?? null,
      status: details.membership_status ?? ecrs.status ?? card.membership_status_text ?? null,
      balance: ecrs.balance ?? card.balance ?? null,
      expiresOn: ecrs.exp_date_ymd ?? ecrs.exp_date ?? details.exp_date ?? null,
      expired: ecrs.membership_expired ?? null,
    },
    ...safe,
  };
}

export async function profile(options = {}, dependencies = {}) {
  const response = await authenticatedRequest('/v1/userprofile', { method: 'GET', readOnly: true }, dependencies);
  return normalizeProfile(response, options);
}

export async function membership(options = {}, dependencies = {}) {
  const response = await authenticatedRequest('/v2/myerewhon', { readOnly: true }, dependencies);
  return normalizeMembership(response, options);
}

export async function rewards({ type = 'accrual', page = 1, raw = false } = {}, dependencies = {}) {
  if (!['accrual', 'redemption'].includes(type)) invalid('Choose accrual or redemption history.');
  pageNumber(page);
  const response = await authenticatedRequest('/v2/activitylog', { form: { type, page }, readOnly: true }, dependencies);
  if (!Array.isArray(response.activity_data) || !response.activity_data.every(record)) throw new ApiError('INVALID_RESPONSE', 'Erewhon did not return rewards activity.');
  if (raw) return accountData(response, { raw });
  // The source UI uses this page's row count > 10; the API has no total/cursor.
  const mayHaveMore = response.activity_data.length > 10;
  return { type, page, mayHaveMore, nextPage: mayHaveMore ? page + 1 : null,
    items: response.activity_data.map(row => ({ date: row.TRN_DATE ?? null, amount: row.LOL_Amount_TXT ?? null, store: row.STO_Name ?? null })) };
}

export async function purchaseHistory({ page = 1, dateKey, methodKeys, raw = false } = {}, dependencies = {}) {
  pageNumber(page);
  const form = { type: 'instore', pageno: page };
  if (dateKey !== undefined) form.date_key = identifier(dateKey, 'date filter');
  if (methodKeys !== undefined) {
    if (!Array.isArray(methodKeys)) invalid('Supply method keys as an array of server-provided filter keys.');
    if (methodKeys.length) form.order_method_key = methodKeys.map(key => identifier(key, 'order method filter')).join(',');
  }
  const response = await authenticatedRequest('/v1/myorders', { form, readOnly: true }, dependencies);
  if (!Array.isArray(response.data) || !response.data.every(record)) throw new ApiError('INVALID_RESPONSE', 'Erewhon did not return in-store purchase history.');
  if (raw) return accountData(response, { raw });
  return { page, nextPage: response.data.length ? page + 1 : null,
    dateFilters: accountData(response.date_range ?? []), methodFilters: accountData(response.order_method ?? []),
    items: response.data.map(row => ({ trnCpk: row.TRN_CPK ?? null, trnPk: row.TRN_PK ?? null,
      date: row.TRN_DATE1 ?? null, store: row.STO_Name ?? null, amount: row.TRN_NetSales ?? null, pointsEarned: row.points_earned ?? null })) };
}

export async function receipt({ trnCpk, trnPk, raw = false } = {}, dependencies = {}) {
  identifier(trnCpk, 'transaction CPK'); identifier(trnPk, 'transaction PK');
  const response = await authenticatedRequest('/v1/transaction_detail', { form: { trn_cpk: trnCpk, trn_pk: trnPk }, readOnly: true }, dependencies);
  if (!Object.hasOwn(response, 'data') || response.data === null || typeof response.data !== 'object') throw new ApiError('INVALID_RESPONSE', 'Erewhon did not return a transaction receipt.');
  return raw ? accountData(response, { raw }) : accountData(response.data);
}
