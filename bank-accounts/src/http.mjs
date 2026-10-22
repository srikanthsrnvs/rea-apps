import { BankAccountsError } from './errors.mjs';
export const API_VERSION = '2026-04-01';
const endpoints = {
  key: ['https://auth.quiltt.io/v1/introspect/api_key', 'POST'],
  session: ['https://auth.quiltt.io/v1/introspect/session_token', 'POST'],
  issue: ['https://auth.quiltt.io/v1/users/sessions', 'POST'],
  revoke: ['https://auth.quiltt.io/v1/users/session', 'DELETE'],
  graphql: ['https://api.quiltt.io/v1/graphql', 'POST'],
};
export function checkToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9._~+\/-]{16,16384}={0,2}$/u.test(token)) throw new BankAccountsError('INVALID_TOKEN', 'A valid private Quiltt credential is required.');
  return token;
}
export async function request(endpoint, { token, authorization, body, fetchImpl = fetch } = {}) {
  const selected = endpoints[endpoint];
  if (!selected) throw new BankAccountsError('INVALID_REQUEST', 'Unsupported Quiltt endpoint.');
  if (!authorization) authorization = `Bearer ${checkToken(token)}`;
  let response;
  try { response = await fetchImpl(selected[0], { method: selected[1], redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { authorization, 'quiltt-version': API_VERSION, 'content-type': 'application/json', accept: 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch { throw new BankAccountsError('NETWORK_ERROR', 'Quiltt could not be reached. The request was not automatically retried.'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new BankAccountsError(response.status === 401 ? 'AUTH_REQUIRED' : response.status === 429 ? 'RATE_LIMITED' : 'BANK_ACCOUNTS_HTTP_ERROR', `Quiltt returned HTTP ${response.status}.`);
  }
  if (response.status === 204) return null;
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength; if (size > 8 * 1024 * 1024) throw new BankAccountsError('RESPONSE_TOO_LARGE', 'Quiltt returned too much data.');
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) { if (error instanceof BankAccountsError) throw error; throw new BankAccountsError('NETWORK_ERROR', 'The Quiltt response was interrupted.'); }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BankAccountsError('INVALID_RESPONSE', 'Quiltt returned an unreadable response.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new BankAccountsError('INVALID_RESPONSE', 'Quiltt returned an unrecognized response.');
  return result;
}
export async function graphql(query, variables, options) {
  const result = await request('graphql', { ...options, body: { query, variables } });
  if (result.errors?.length || !result.data || typeof result.data !== 'object') throw new BankAccountsError('GRAPHQL_ERROR', 'Quiltt could not complete the data query. No partial result was treated as complete.');
  return result.data;
}
