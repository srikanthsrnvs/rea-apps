import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWebsiteBootstrap } from '../src/bootstrap.mjs';
import { InstagramClient } from '../src/http.mjs';
import { sessionFromExport } from '../src/session.mjs';
import { encodeCursor, decodeCursor } from '../src/cursor.mjs';
import { exploreItems, normalizeInbox, inbox, searchContent } from '../src/read.mjs';
const html = id => '<script type="application/json">' + JSON.stringify({ modules: [
  ['PolarisViewer', [], { data: { id, username: 'fixture', fbid: '456' } }],
  ['DTSGInitialData', [], { token: 'private-fixture-token' }], ['LSD', [], { token: 'private-lsd' }],
] }) + '</script>';
const media = id => ({ pk: id, code: 'fixture', media_type: 2, user: { pk: '3', username: 'fixture' }, video_versions: [{ url: 'https://example.com/video' }] });

test('bootstrap validates the cookie account and keeps request tokens out of me output', async () => {
  assert.throws(() => parseWebsiteBootstrap(html('123'), '999'), { code: 'LOGIN_REQUIRED' });
  const session = sessionFromExport({ cookies: ['sessionid', 'ds_user_id'].map(name => ({ name, value: name === 'ds_user_id' ? '123' : 'private', domain: '.instagram.com', path: '/', expires: -1 })) });
  const client = new InstagramClient(session, { fetchImpl: async () => new Response(html('123')) });
  const result = await client.me();
  assert.equal(result.user.id, '123');
  assert.equal(JSON.stringify(result).includes('private-fixture-token'), false);
});

test('continuation cursors reject account, command, search mismatches and corrupt input', () => {
  const token = encodeCursor('content', '123', { after: 'opaque', query: 'coffee', searchSession: 'a'.repeat(8)+'-aaaa-aaaa-aaaa-'+ 'a'.repeat(12) });
  assert.equal(decodeCursor(token, 'content', '123', 'coffee').after, 'opaque');
  for (const args of [[token, 'content', '456', 'coffee'], [token, 'inbox', '123'], [token, 'content', '123', 'tea'], ['@@', 'explore', '123']]) assert.throws(() => decodeCursor(...args), { code: 'INVALID_CURSOR' });
});

test('Explore flattens mixed clips and tiles while preserving IDs and removing duplicates', () => {
  const body = { sectional_items: [{ layout_content: { one_by_two_item: { clips: { id: 'collection-id', items: [{ media: media('9007199254740993001') }] } }, fill_items: [{ media: media('2') }, { media: media('2') }] } }] };
  assert.deepEqual(exploreItems(body).map(m => m.id), ['9007199254740993001', '2']);
  assert.throws(() => exploreItems({}), { code: 'PROTOCOL_CHANGED' });
});

test('inbox projects summaries only; pagination calls the mailbox query without opening a thread', async () => {
  const thread = { thread_id: '88', thread_title: 'Fixture', users: [{ id: '123' }, { id: '456', username: 'friend' }], slide_messages: { edges: [{ node: { igd_snippet: 'Preview', text_body: 'private full text', content: { secret: true } } }] } };
  const box = { id: 'mailbox', pinned_threads_v2: [{ as_ig_direct_thread: thread }], threads_by_folder: { edges: [{ node: { as_ig_direct_thread: thread } }], page_info: { has_next_page: true, end_cursor: 'opaque' } } };
  const result = normalizeInbox(box, '123');
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].participants.length, 1);
  assert.equal(JSON.stringify(result).includes('private full text'), false);
  const calls = [];
  const client = { session: { account: { id: '123' } }, graphql: async (query, vars) => { calls.push({ query, vars }); return { fetch__SlideMailbox: { ...box, threads_by_folder: { edges: [], page_info: { has_next_page: false, end_cursor: null } } } }; } };
  const next = await inbox(client, result.nextCursor);
  assert.deepEqual(calls.map(c => c.query), ['inboxPage']);
  assert.equal(calls[0].vars.id, 'mailbox'); assert.equal(calls[0].vars.cursor, 'opaque');
  assert.equal(next.nextCursor, null);
});

test('content pagination carries the same query and session with the server cursor', async () => {
  const calls = [];
  const client = { session: { account: { id: '123' } }, graphql: async (query, vars) => { calls.push({ query, vars }); return { xdt_fbsearch__top_serp_graphql: { edges: [{ node: { __typename: 'XDTTopSerpMediaGridUnit', items: [media('99')] } }], page_info: { has_next_page: calls.length === 1, end_cursor: 'opaque' } } }; } };
  const first = await searchContent(client, 'coffee');
  const second = await searchContent(client, 'coffee', first.nextCursor);
  assert.equal(first.items.length, 1); assert.equal(second.hasMore, false);
  assert.equal(calls[1].query, 'contentPage'); assert.equal(calls[1].vars.after, 'opaque');
  assert.equal(calls[1].vars.search_session_id, calls[0].vars.search_session_id);
});

test('GraphQL sends only allowlisted reads, fresh tokens and never follows redirects or retries errors', async () => {
  const session = sessionFromExport({ cookies: [{ name: 'sessionid', value: 'private', domain: '.instagram.com', path: '/', expires: -1 }] });
  let calls = 0;
  const client = new InstagramClient(session, { fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://www.instagram.com/api/graphql'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['sec-fetch-site'], 'same-origin');
    assert.equal(new URLSearchParams(options.body).get('fb_dtsg'), 'private-fixture-token');
    return Response.json({ errors: [{ message: 'private-error-payload' }] });
  } });
  client.bootstrap = parseWebsiteBootstrap(html('123'), '123');
  await assert.rejects(client.graphql('send', {}), { code: 'INVALID_ENDPOINT' });
  assert.equal(calls, 0);
  await assert.rejects(client.graphql('inbox', {}), error => error.code === 'API_ERROR' && !JSON.stringify(error).includes('private-error-payload'));
  assert.equal(calls, 1);
});

test('a repeated server continuation fails explicitly instead of looping indefinitely', async () => {
  const token = encodeCursor('content', '123', { after: 'same', query: 'coffee', searchSession: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  const client = { session: { account: { id: '123' } }, graphql: async () => ({ xdt_fbsearch__top_serp_graphql: { edges: [], page_info: { has_next_page: true, end_cursor: 'same' } } }) };
  await assert.rejects(searchContent(client, 'coffee', token), { code: 'PAGINATION_STALLED' });
});
