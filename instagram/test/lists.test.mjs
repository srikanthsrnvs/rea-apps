import test from 'node:test';
import assert from 'node:assert/strict';
import { relationships } from '../src/relationships.mjs';
import { bookmarkCollections, bookmarkItems, bookmarkTree, allSavedId } from '../src/bookmarks.mjs';
import { encodeCursor, decodeCursor } from '../src/cursor.mjs';
import { InstagramError } from '../src/errors.mjs';
import { InstagramClient } from '../src/http.mjs';
import { sessionFromExport } from '../src/session.mjs';
import { tvUserAgent } from '../src/profiles.mjs';

const session = { account: { id: '123', username: 'fixture' } };
const media = id => ({ pk: id, code: 'fixture', media_type: 1,
  user: { pk: '9', username: 'author' }, image_versions2: { candidates: [{ url: 'https://example.com/image' }] },
  private_unused_field: 'not-in-output', carousel_media: [{ pk: id + '_child', media_type: 2, video_versions: [{ url: 'https://example.com/video' }] }],
});
const collection = (id = allSavedId, type = 'IGAllMediaAutoCollection') => ({ node: {
  __typename: type, collection_id: id, collection_name: id === allSavedId ? 'All posts' : 'Fixture collection',
  collection_media_count: 2, cover_media: media('cover'), cover_media_list: [media('cover')],
} });
const collectionBody = (edges, more = false, after = null) => ({ viewer: { collections_unified_with_auto_collections: {
  edges, page_info: { has_next_page: more, end_cursor: after },
} } });

test('relationships preserve target, restriction flags and pagination while projecting users', async () => {
  const calls = [];
  const client = { session, get: async (endpoint, params) => {
    calls.push({ endpoint, params });
    return { users: [{ pk: '9007199254740993001', username: 'friend', private_unused_field: 'not-in-output' }, { pk: '9007199254740993001' }],
      next_max_id: calls.length === 1 ? 'opaque' : null, has_more: calls.length === 1,
      should_limit_list_of_followers: true };
  } };
  const first = await relationships(client, 'followers', { userId: '999', count: 12 });
  const next = await relationships(client, 'followers', { cursor: first.nextCursor, count: 12 });
  assert.equal(first.users.length, 1); assert.equal(first.users[0].id, '9007199254740993001');
  assert.equal(first.limited, true); assert.equal(first.hasMore, true);
  assert.equal(next.userId, '999'); assert.equal(next.hasMore, false); assert.equal(next.nextCursor, null);
  assert.equal(calls[1].endpoint, '/friendships/999/followers/'); assert.equal(calls[1].params.max_id, 'opaque');
  assert.equal(JSON.stringify(first).includes('not-in-output'), false);
});

test('username target uses an exact match and does not repeat search on continuation', async () => {
  let searches = 0;
  const client = { session, graphql: async (kind, vars) => {
    searches++; assert.equal(kind, 'users'); assert.ok(['FRIEND', 'absent'].includes(vars.data.query));
    return { xdt_api__v1__fbsearch__topsearch_connection: { users: [
      { user: { pk: '8', username: 'friend_similar' } }, { user: { pk: '9', username: 'friend' } },
    ] } };
  }, get: async endpoint => {
    assert.equal(endpoint, '/friendships/9/following/');
    return { users: [], next_max_id: 'opaque', has_more: true, should_limit_list_of_followings: false, hidden_following_account_count: 3 };
  } };
  const first = await relationships(client, 'following', { username: 'FRIEND' });
  assert.equal(first.username, 'friend'); assert.equal(first.hiddenFollowingCount, 3);
  await assert.rejects(relationships(client, 'following', { cursor: first.nextCursor, username: 'friend' }), { code: 'PAGINATION_STALLED' });
  assert.equal(searches, 1);
  await assert.rejects(relationships(client, 'followers', { username: 'absent' }), { code: 'USER_NOT_FOUND' });
});

test('relationship cursors reject another account, list, target or injected path before requests', async () => {
  const cursor = encodeCursor('following', '123', { after: 'opaque', target: '999', username: 'friend' });
  const client = { session, get: () => { throw Error('unexpected request'); }, graphql: () => { throw Error('unexpected request'); } };
  for (const [kind, options] of [
    ['followers', { cursor }], ['following', { cursor, userId: '888' }], ['following', { cursor, username: 'other' }],
    ['following', { cursor: encodeCursor('following', '123', { after: 'x', target: '../logout' }) }],
  ]) await assert.rejects(relationships(client, kind, options), { code: 'INVALID_CURSOR' });
  await assert.rejects(relationships({ ...client, session: { account: { id: '456' } } }, 'following', { cursor }), { code: 'INVALID_CURSOR' });
  await assert.rejects(relationships(client, 'following', { userId: '../logout' }), { code: 'INVALID_ARGUMENT' });
});

test('relationship lists fail explicitly on missing or stalled continuation', async () => {
  const client = { session, get: async () => ({ users: [], has_more: true }) };
  await assert.rejects(relationships(client, 'followers'), { code: 'PROTOCOL_CHANGED' });
});

test('collection listing uses media collection types and paginates with projected covers', async () => {
  const calls = [];
  const client = { session, graphql: async (operation, vars) => {
    calls.push({ operation, vars });
    return calls.length === 1 ? collectionBody([collection(), collection('44', 'IGMediaCollection')], true, 'next-collections')
      : collectionBody([collection('55', 'IGMediaCollection')]);
  } };
  const first = await bookmarkCollections(client);
  const next = await bookmarkCollections(client, { cursor: first.nextCursor });
  assert.equal(first.collections[0].type, 'all_saved'); assert.equal(first.collections[1].type, 'collection');
  assert.equal(next.collections[0].id, '55'); assert.equal(next.nextCursor, null);
  assert.deepEqual(calls[0], { operation: 'collections', vars: { first: 12, after: null, collection_types: [allSavedId, 'MEDIA'] } });
  assert.equal(calls[1].vars.after, 'next-collections');
  assert.equal(JSON.stringify(first).includes('not-in-output'), false);
});

test('saved media supports wrappers, carousels, named membership and independent cursors', async () => {
  const calls = [];
  const client = { session, get: async (endpoint, params, options) => {
    calls.push({ endpoint, params, options });
    return { items: [{ media: media('42') }, { media: media('42') }, media('43')], more_available: calls.length === 1, next_max_id: 'next-items' };
  } };
  const first = await bookmarkItems(client, { collectionId: '44' });
  assert.deepEqual(first.items.map(item => item.id), ['42', '43']);
  assert.equal(first.items[0].carousel[0].type, 2);
  const next = await bookmarkItems(client, { cursor: first.nextCursor });
  assert.equal(next.collectionId, '44'); assert.equal(next.nextCursor, null);
  assert.equal(calls[1].endpoint, '/feed/collection/44/'); assert.equal(calls[1].params.max_id, 'next-items');
  assert.equal(calls[0].params.include_feed_only, false); assert.deepEqual(calls[0].options, { profile: 'tv' });
  await assert.rejects(bookmarkItems(client, { cursor: first.nextCursor, collectionId: '55' }), { code: 'INVALID_CURSOR' });
  await assert.rejects(bookmarkItems(client, { cursor: first.nextCursor, collectionId: '../logout' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(bookmarkItems(client, { cursor: encodeCursor('bookmark-items', '999', { after: 'x', collection: '44' }) }), { code: 'INVALID_CURSOR' });
});

test('bookmark tree retains shared membership, pagination and explicit completeness', async () => {
  const client = { session, graphql: async () => collectionBody([collection(), collection('44', 'IGMediaCollection')]),
    get: async endpoint => ({ items: [{ media: media('shared') }], more_available: endpoint === '/feed/saved/', next_max_id: 'next' }) };
  const tree = await bookmarkTree(client, { pause: async () => {} });
  assert.equal(tree.children.length, 2); assert.equal(tree.children[0].loaded, true);
  assert.equal(tree.children[0].items[0].id, tree.children[1].items[0].id);
  assert.equal(tree.complete, false); assert.equal(tree.children[0].hasMore, true);
  assert.equal(decodeCursor(tree.children[0].nextCursor, 'bookmark-items', '123').collection, allSavedId);
  const empty = await bookmarkTree({ session, graphql: async () => collectionBody([]) });
  assert.deepEqual(empty.children, []); assert.equal(empty.complete, true);
});

test('tree returns partial data and stops requesting after a read error', async () => {
  let calls = 0;
  const client = { session, graphql: async () => collectionBody([collection(), collection('44', 'IGMediaCollection'), collection('55', 'IGMediaCollection')]),
    get: async () => { calls++; if (calls === 2) throw new InstagramError('RATE_LIMITED', 'Wait.', { retryAfterSeconds: 5 }); return { items: [], more_available: false }; } };
  const tree = await bookmarkTree(client, { pause: async () => {} });
  assert.equal(tree.complete, false); assert.equal(tree.children[0].loaded, true);
  assert.equal(tree.children[1].error.code, 'RATE_LIMITED'); assert.equal(tree.children[1].error.retryAfterSeconds, 5);
  assert.equal(tree.children[2].loaded, false); assert.equal(tree.children[2].items, null); assert.equal(calls, 2);
});

test('saved pagination rejects unfamiliar, missing and repeated cursors', async () => {
  const cursor = encodeCursor('bookmark-items', '123', { after: 'same', collection: allSavedId });
  await assert.rejects(bookmarkItems({ session, get: async () => ({ items: [], more_available: true, next_max_id: 'same' }) }, { cursor }), { code: 'PAGINATION_STALLED' });
  await assert.rejects(bookmarkItems({ session, get: async () => ({ items: [], more_available: true }) }), { code: 'PROTOCOL_CHANGED' });
  await assert.rejects(bookmarkCollections({ session, graphql: async () => collectionBody([collection('../logout', 'NewUnknownCollection')]) }), { code: 'PROTOCOL_CHANGED' });
});

test('saved client profile changes only the request agent and keeps cookies scoped', async () => {
  const s = sessionFromExport({ userAgent: 'fixture-web-agent', cookies: [{ name: 'sessionid', value: 'private', domain: '.instagram.com', path: '/', expires: -1 }] });
  const calls = [];
  const client = new InstagramClient(s, { fetchImpl: async (url, options) => {
    calls.push(options.headers['user-agent']); assert.equal(url.origin, 'https://www.instagram.com'); assert.equal(options.redirect, 'manual');
    return Response.json({ status: 'ok', items: [], more_available: false });
  } });
  await client.get('/feed/saved/', {}, { profile: 'tv' });
  await client.get('/friendships/123/following/');
  assert.deepEqual(calls, [tvUserAgent, 'fixture-web-agent']); assert.equal(client.session.userAgent, 'fixture-web-agent');
  await assert.rejects(client.get('/feed/saved/', {}, { profile: 'unknown' }), { code: 'INVALID_ARGUMENT' });
});
