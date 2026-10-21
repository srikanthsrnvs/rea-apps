import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAccount, buildWishlists, buildWishlistItems, buildWishlistDetails, buildTrips,
  buildInbox, buildInboxNewer, buildInboxSearch, parseAccount, parseInboxPage,
  parseTripsPage, parseWishlistsPage } from '../src/account-protocol.mjs';

test('account bootstrap is a no-input read and rejects mismatched or partial identities', () => {
  assert.deepEqual(buildAccount().variables, {});
  const response = { data: { viewer: { user: { id: Buffer.from('User:123').toString('base64') } } } };
  assert.equal(parseAccount(response, { expectedUserId: '123' }).raw, response);
  assert.throws(() => parseAccount(response, { expectedUserId: '124' }), { code: 'ACCOUNT_MISMATCH' });
  assert.throws(() => parseAccount({ data: response.data, errors: [{ message: 'incomplete' }] }), { code: 'GRAPHQL_ERROR' });
  assert.throws(() => parseAccount({ data: { viewer: { email: 'invented@example.invalid' } } }), /viewer.user.id/);
});

test('wishlist offset paging preserves source-fixed limit and optional null semantics', () => {
  assert.deepEqual(buildWishlists({ offset: 40 }).variables, { offset: 40, limit: 20, treatmentFlags: ['wishlist_should_load_service'] });
  assert.deepEqual(buildWishlistItems({ offset: null }).variables, { offset: null });
  assert.throws(() => buildWishlists({ offset: -1 }));
  assert.throws(() => buildWishlistDetails({ wishlistId: '' }));
  assert.equal(buildWishlistDetails({ wishlistId: 'opaque-id' }).variables.wishlistId, 'opaque-id');
});

test('trip and inbox cursor values are opaque, and absent and null differ', () => {
  const cursor = 'opaque/+?==cursor';
  assert.deepEqual(buildTrips({ after: cursor }).variables, { first: 9, after: cursor });
  assert.deepEqual(buildTrips({ first: undefined, after: null }).variables, { after: null });
  assert.equal(buildInbox({ cursor, pageSize: 20 }).variables.cursor, cursor);
  assert.equal(buildInboxNewer({ pageSize: 20 }).variables.numPreviewMessages, 1);
  assert.throws(() => buildInbox(), /pageSize/);
  assert.throws(() => buildInbox({ pageSize: 0 }));
  assert.throws(() => buildInboxSearch({ query: 'x', filters: { value: undefined } }));
});

test('page parsing preserves unknown fields and distinguishes missing from empty results', () => {
  const response = { data: { viewer: { messagingInbox: { inboxItemsNextPage: {
    edges: [], pageInfo: { hasNextPage: true, endCursor: 'next', extra: 1 }, other: 'kept',
  } } } } };
  const page = parseInboxPage(response);
  assert.deepEqual(page.edges, []);
  assert.equal(page.pageInfo.extra, 1);
  assert.equal(page.raw.data.viewer.messagingInbox.inboxItemsNextPage.other, 'kept');
  assert.equal(parseTripsPage({ data: { viewer: {} } }).edges, null);
  assert.equal(parseWishlistsPage({ data: {} }).items, null);
  assert.throws(() => parseInboxPage(response, { mode: 'guessed-alias' }));
});
