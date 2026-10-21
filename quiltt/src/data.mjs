import { randomUUID } from 'node:crypto';
import { graphql, request, checkToken } from './http.mjs';
import { requireConfig } from './config.mjs';
import { readState, saveState, withStateLock } from './state.mjs';
import { QuilttError } from './errors.mjs';

const profileQuery = 'query { profile { id email } }';
const cursorPrefix = 'quiltt-transactions:';
export async function validateSession(token, config, { requestImpl = request, query = graphql } = {}) {
  checkToken(token);
  const session = await requestImpl('session', { token });
  if (session.environmentId !== config.environment.id || !/^p_[A-Za-z0-9]+$/u.test(session.userId ?? '')
    || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) throw new QuilttError('SESSION_MISMATCH', 'The authenticated Quiltt session does not match this Sandbox environment.');
  const data = await query(profileQuery, {}, { token });
  if (data.profile?.id !== session.userId) throw new QuilttError('SESSION_MISMATCH', 'Quiltt did not independently confirm the same Profile.');
  return { version: 1, token, profile: { id: session.userId, email: data.profile.email ?? null },
    environmentId: session.environmentId, expiresAt: session.expiresAt, validated: true, validatedAt: new Date().toISOString() };
}
export async function savedContext() {
  return withStateLock(async () => {
    const config = await requireConfig(), session = await readState('session');
    if (session?.validated !== true || session.environmentId !== config.environment.id || !/^p_[A-Za-z0-9]+$/u.test(session.profile?.id ?? '') || !Number.isFinite(Date.parse(session.expiresAt))) throw new QuilttError('AUTH_REQUIRED', 'Run quiltt login and finish bank linking first.');
    if (!config.secret && Date.parse(session.expiresAt) <= Date.now()) throw new QuilttError('AUTH_EXPIRED', 'The Quiltt session expired. Run quiltt login, or configure a private Sandbox API secret for persistent server access.');
    return { config, session };
  });
}
function credentials({ config, session }) {
  return config.secret ? { authorization: `Basic ${Buffer.from(`${session.profile.id}:${config.secret}`).toString('base64')}` } : { token: session.token };
}
async function sameProfile(context) {
  const current = await readState('session'), config = await requireConfig();
  if (current?.validated !== true || current.profile?.id !== context.session.profile.id || config.environment.id !== context.config.environment.id) throw new QuilttError('ACCOUNT_CHANGED', 'The signed-in Quiltt Profile changed. Run the command again.');
}
export const accountFields = 'id name kind currencyCode institution { name } connection { id provider } balance { id at current available limit }';
export function createDataTools({ context = savedContext, query = graphql, lock = withStateLock,
  read = readState, save = saveState, assertProfile = sameProfile, now = Date.now, uuid = randomUUID } = {}) {
  async function execute(document, selected) {
    const active = selected ?? await context();
    const data = await query(document, {}, credentials(active));
    await lock(() => assertProfile(active));
    return { data, active };
  }
  async function accounts() {
    const { data } = await execute(`query { accounts { ${accountFields} } }`);
    if (!Array.isArray(data.accounts)) throw new QuilttError('INVALID_RESPONSE', 'Quiltt did not return an account list.');
    return { environment: 'SANDBOX', accounts: data.accounts };
  }
  async function balances() {
    const result = await accounts();
    return { environment: 'SANDBOX', balances: result.accounts.map(({ id, name, kind, currencyCode, institution, balance }) => ({ accountId: id, name, kind, currencyCode, institution, balance })) };
  }
  async function connections() {
    const { data } = await execute('query { connections { id status provider institution { name } } }');
    if (!Array.isArray(data.connections)) throw new QuilttError('INVALID_RESPONSE', 'Quiltt did not return a connection list.');
    return { environment: 'SANDBOX', connections: data.connections };
  }
  async function transactions(options = {}) {
    let selected = await context(), filters, after;
    let limit = options.limit === undefined ? 50 : Number(options.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new QuilttError('INVALID_ARGUMENT', 'Transaction limit must be 1–100.');
    if (options.cursor !== undefined) {
      if (typeof options.cursor !== 'string' || !/^quiltt-transactions:[a-f0-9-]{36}$/u.test(options.cursor)) throw new QuilttError('INVALID_CURSOR', 'Use a transaction cursor returned by this CLI.');
      const cursor = await lock(() => read(`cursor-${options.cursor.slice(cursorPrefix.length)}`));
      if (cursor?.profileId !== selected.session.profile.id || cursor.environmentId !== selected.config.environment.id || cursor.expiresAt <= now() || typeof cursor.after !== 'string') throw new QuilttError('CURSOR_EXPIRED', 'This cursor expired or belongs to another Sandbox Profile. Start a new transaction query.');
      for (const key of ['startDate', 'endDate', 'status', 'entryType']) if (options[key] !== undefined && options[key] !== cursor.filters[key]) throw new QuilttError('CURSOR_MISMATCH', 'The cursor retains its original transaction filters.');
      if (options.limit !== undefined && limit !== cursor.limit) throw new QuilttError('CURSOR_MISMATCH', 'The cursor retains its original page limit.');
      filters = cursor.filters; after = cursor.after; limit = cursor.limit;
    } else {
      filters = Object.fromEntries(['startDate', 'endDate', 'status', 'entryType'].filter(key => options[key] !== undefined).map(key => [key, options[key]]));
    }
    const filterParts = [];
    for (const [key, field] of [['startDate', 'date_gte'], ['endDate', 'date_lte']]) if (filters[key] !== undefined) {
      const date = filters[key];
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new QuilttError('INVALID_ARGUMENT', 'Use real YYYY-MM-DD transaction dates.');
      filterParts.push(`${field}:${JSON.stringify(date)}`);
    }
    if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) throw new QuilttError('INVALID_ARGUMENT', 'Start date must not follow end date.');
    if (filters.status !== undefined) { if (!['PENDING', 'POSTED'].includes(filters.status)) throw new QuilttError('INVALID_ARGUMENT', 'Status must be PENDING or POSTED.'); filterParts.push(`status:[${filters.status}]`); }
    if (filters.entryType !== undefined) { if (!['CREDIT', 'DEBIT'].includes(filters.entryType)) throw new QuilttError('INVALID_ARGUMENT', 'Entry type must be CREDIT or DEBIT.'); filterParts.push(`entryType:${filters.entryType}`); }
    const args = [`first:${limit}`, 'sort:DATE_DESC', ...(after ? [`after:${JSON.stringify(after)}`] : []), ...(filterParts.length ? [`filter:{${filterParts.join(',')}}`] : [])];
    const { data } = await execute(`query { transactions(${args.join(',')}) { count nodes { id date description amount entryType status account { id name currencyCode } } pageInfo { hasNextPage endCursor } } }`, selected);
    const page = data.transactions;
    if (!page || !Array.isArray(page.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean' || page.pageInfo.hasNextPage && (typeof page.pageInfo.endCursor !== 'string' || !page.pageInfo.endCursor || page.pageInfo.endCursor === after)) throw new QuilttError('INVALID_RESPONSE', 'Quiltt returned an incomplete transaction page.');
    let cursor = null;
    if (page.pageInfo.hasNextPage) {
      const id = uuid(); cursor = `${cursorPrefix}${id}`;
      await lock(async () => { await assertProfile(selected); await save(`cursor-${id}`, { profileId: selected.session.profile.id, environmentId: selected.config.environment.id, filters, limit, after: page.pageInfo.endCursor, expiresAt: now() + 3_600_000 }); });
    }
    return { environment: 'SANDBOX', transactions: page.nodes, count: page.count ?? null, hasMore: page.pageInfo.hasNextPage, cursor };
  }
  return { accounts, balances, connections, transactions };
}
export const { accounts, balances, connections, transactions } = createDataTools();
