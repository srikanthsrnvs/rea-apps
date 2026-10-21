import { randomUUID } from 'node:crypto';
import { readState, saveState } from './state.mjs';
import { buildStaysSearch, normalizeStaysSearch } from './search-protocol.mjs';
import { AirbnbError } from './errors.mjs';

function key(cursor) {
  if (typeof cursor !== 'string' || !/^rea-airbnb:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(cursor)) throw new AirbnbError('SEARCH_CURSOR_INVALID', 'Use the nextCursor returned by this CLI.');
  return `search-${cursor.slice('rea-airbnb:'.length)}`;
}
const defined = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function identity(options) {
  const request = buildStaysSearch({ ...options, cursor: undefined });
  request.variables.staysSearchRequest.rawParams.sort((a, b) => a.filterName.localeCompare(b.filterName));
  return JSON.stringify(stable(request));
}
export async function searchStays(input, client) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AirbnbError('INVALID_ARGUMENT', 'Search options must be an object.');
  if (typeof client?.request !== 'function') throw new AirbnbError('INVALID_ARGUMENT', 'A request client is required.');
  let options = defined(input);
  if (input.cursor) {
    let saved;
    try { saved = await readState(key(input.cursor)); }
    catch (error) {
      if (error instanceof SyntaxError) throw new AirbnbError('SEARCH_CURSOR_INVALID', 'The saved search cursor is unreadable; start this search again.');
      throw error;
    }
    if (!saved || !Number.isFinite(saved.expiresAt) || Date.now() >= saved.expiresAt) throw new AirbnbError('SEARCH_CURSOR_EXPIRED', 'Start this search again; the original parameters for this cursor are unavailable.');
    if (!saved.options || typeof saved.options !== 'object' || Array.isArray(saved.options)
      || typeof saved.serverCursor !== 'string' || !saved.serverCursor.trim()) throw new AirbnbError('SEARCH_CURSOR_INVALID', 'The saved search cursor is incomplete; start this search again.');
    let original;
    try { original = identity(saved.options); }
    catch { throw new AirbnbError('SEARCH_CURSOR_INVALID', 'The saved search parameters are invalid; start this search again.'); }
    for (const [name, value] of Object.entries(options)) {
      if (name !== 'cursor' && identity({ ...saved.options, [name]: value }) !== original) throw new AirbnbError('SEARCH_CURSOR_MISMATCH', `Keep the original ${name} when continuing a search, or start a new search without a cursor.`);
    }
    options = { ...saved.options, ...options, cursor: saved.serverCursor };
  }
  const spec = buildStaysSearch(options);
  if (!spec.variables.staysSearchRequest.rawParams.some(param => ['query', 'place_id'].includes(param.filterName) && param.filterValues[0])) throw new AirbnbError('INVALID_ARGUMENT', 'Provide --query or --place-id.');
  // Bind continuations to the inputs used for this request, even if a caller
  // changes its own nested filter arrays while the request is in flight.
  let original;
  try { const { cursor: _, ...rest } = structuredClone(options); JSON.stringify(rest); original = rest; }
  catch { throw new AirbnbError('INVALID_ARGUMENT', 'Search options must contain serializable values.'); }
  const result = normalizeStaysSearch(await client.request(spec));
  result.sourceCursors = { nextCursor: result.nextCursor, previousCursor: result.previousCursor };
  for (const field of ['nextCursor', 'previousCursor']) if (result[field]) {
    const local = `rea-airbnb:${randomUUID()}`;
    await saveState(key(local), { options: original, serverCursor: result[field], expiresAt: Date.now() + 60 * 60_000 });
    result[field] = local;
  }
  result.summary.nextCursor = result.nextCursor;
  result.summary.previousCursor = result.previousCursor;
  return result;
}
