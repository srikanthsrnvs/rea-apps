import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airbnb-search-test-'));
process.env.AIRBNB_STATE_DIR = directory;
const { searchStays } = await import('../src/search.mjs');
const { normalizeListing, normalizeCalendar } = await import('../src/search-protocol.mjs');
test.after(async () => fs.rm(directory, { recursive: true, force: true }));

test('identical upstream cursors retain separate queries and their dates and guests', async () => {
  const requests = [];
  const client = { request: async spec => {
    requests.push(spec);
    return { data: { presentation: { staysSearch: { results: { searchResults: [], paginationInfo: { nextPageCursor: 'same-upstream-offset' } } } } } };
  } };
  try {
    const first = await searchStays({ query: 'Place One', adults: 2, checkin: '2026-11-06', checkout: '2026-11-08' }, client);
    const second = await searchStays({ query: 'Place Two', adults: 4 }, client);
    assert.notEqual(first.nextCursor, second.nextCursor);
    await searchStays({ cursor: first.nextCursor }, client);
    const request = requests.at(-1).variables.staysSearchRequest;
    assert.equal(request.cursor, 'same-upstream-offset');
    const filters = Object.fromEntries(request.rawParams.map(entry => [entry.filterName, entry.filterValues]));
    assert.deepEqual(filters.query, ['Place One']);
    assert.deepEqual(filters.adults, ['2']);
    assert.deepEqual(filters.checkin, ['2026-11-06']);
    const count = requests.length;
    await assert.rejects(searchStays({ cursor: first.nextCursor, query: 'Place Two' }, client), { code: 'SEARCH_CURSOR_MISMATCH' });
    await assert.rejects(searchStays({ cursor: 'same-upstream-offset' }, client), { code: 'SEARCH_CURSOR_INVALID' });
    assert.equal(requests.length, count);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a null listing or calendar cannot be returned as a successful read', () => {
  assert.throws(() => normalizeListing({ data: null }), { code: 'LISTING_NOT_FOUND' });
  assert.throws(() => normalizeCalendar({ data: { node: null } }), { code: 'CALENDAR_NOT_FOUND' });
});

test('continuation summaries carry local cursors while native cursors remain in source data', async () => {
  const payload = { data: { presentation: { staysSearch: { results: {
    searchResults: [], paginationInfo: { nextPageCursor: 'native+/=', previousPageCursor: 'native-before' },
  } } } } };
  const client = { request: async () => payload };
  const first = await searchStays({ query: 'Example' }, client);
  assert.match(first.nextCursor, /^rea-airbnb:/);
  assert.equal(first.summary.nextCursor, first.nextCursor);
  assert.equal(first.summary.previousCursor, first.previousCursor);
  assert.deepEqual(first.sourceCursors, { nextCursor: 'native+/=', previousCursor: 'native-before' });
  assert.equal(first.raw, payload);
  assert.equal(payload.data.presentation.staysSearch.results.paginationInfo.nextPageCursor, 'native+/=');
  // Repeating an effective default or a numeric value in its string form does
  // not change the search the token identifies.
  await searchStays({ cursor: first.nextCursor, adults: '1', currency: 'usd', limit: '16' }, client);
});

test('nested caller mutations cannot change saved search filters after a request starts', async () => {
  const options = { query: 'Example', filters: { amenities: ['4'] } };
  const requests = [];
  const client = { request: async spec => {
    requests.push(spec);
    options.filters.amenities[0] = '9';
    return { data: { presentation: { staysSearch: { results: { searchResults: [], paginationInfo: { nextPageCursor: 'native' } } } } } };
  } };
  const first = await searchStays(options, client);
  await searchStays({ cursor: first.nextCursor }, client);
  assert.deepEqual(requests[1].variables.staysSearchRequest.rawParams.find(item => item.filterName === 'amenities').filterValues, ['4']);
  await assert.rejects(searchStays({ cursor: first.nextCursor, filters: { amenities: ['9'] } }, client), { code: 'SEARCH_CURSOR_MISMATCH' });
});

test('equivalent filter object key order does not invalidate a continuation', async () => {
  const client = { request: async () => ({ data: { presentation: { staysSearch: { results: {
    searchResults: [], paginationInfo: { nextPageCursor: 'native' },
  } } } } }) };
  const first = await searchStays({ query: 'Example', adults: 2, filters: { amenities: ['4'], room_types: ['Entire home/apt'] } }, client);
  await searchStays({ cursor: first.nextCursor, adults: '2', filters: { room_types: ['Entire home/apt'], amenities: ['4'] } }, client);
});

test('a query copied from native filter parameters can start and continue a search', async () => {
  const requests = [];
  const client = { request: async spec => {
    requests.push(spec);
    return { data: { presentation: { staysSearch: { results: { searchResults: [], paginationInfo: { nextPageCursor: 'native' } } } } } };
  } };
  const first = await searchStays({ rawParams: [{ filterName: 'query', filterValues: ['Example'] }] }, client);
  await searchStays({ cursor: first.nextCursor }, client);
  assert.deepEqual(requests[1].variables.staysSearchRequest.rawParams.find(item => item.filterName === 'query').filterValues, ['Example']);
});

test('corrupt or expired cursor state fails before making a request', async () => {
  const token = 'rea-airbnb:00000000-0000-4000-8000-000000000001';
  const filename = path.join(directory, 'search-00000000-0000-4000-8000-000000000001.json');
  await fs.mkdir(directory, { recursive: true });
  let calls = 0;
  const client = { request: async () => { calls++; return {}; } };
  for (const record of [
    { options: { query: 'Example' }, serverCursor: null, expiresAt: Date.now() + 60_000 },
    { options: { query: 'Example', children: -1 }, serverCursor: 'native', expiresAt: Date.now() + 60_000 },
  ]) {
    await fs.writeFile(filename, JSON.stringify(record));
    await assert.rejects(searchStays({ cursor: token }, client), { code: 'SEARCH_CURSOR_INVALID' });
  }
  await fs.writeFile(filename, JSON.stringify({ options: { query: 'Example' }, serverCursor: 'native', expiresAt: 1 }));
  await assert.rejects(searchStays({ cursor: token }, client), { code: 'SEARCH_CURSOR_EXPIRED' });
  await fs.writeFile(filename, '{');
  await assert.rejects(searchStays({ cursor: token }, client), { code: 'SEARCH_CURSOR_INVALID' });
  await assert.rejects(searchStays({ cursor: `rea-airbnb:${'-'.repeat(36)}` }, client), { code: 'SEARCH_CURSOR_INVALID' });
  await assert.rejects(searchStays({ query: 'Example', children: -1 }, client), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls, 0);
});
