// Static protocol recovered from Airbnb Android 26.42 (28026652).
// Source evidence and operation hashes: private/airbnb/evidence/account-read-catalog.json.

export const ACCOUNT_OPERATIONS = Object.freeze({
  account: ['Account', 'f5fe5a5bcde40d1265ec48f814f38cddd0172232c7bfde3726db9263c6429869'],
  wishlists: ['WishlistIndexPageQuery', '2c82304ea5a1f506a01b3c4c59fb6271877ad678552c83ca3229168b78b6d948'],
  wishlistItems: ['WishlistIndexItemsQuery', '29528da6a1dd7582ea06e81b99ca09afae191badc8a2fe68c071fc20f3aec606'],
  wishlistDetails: ['WishlistDetailPageV2Query', 'ef48ae67c6f0919b06fc0c911ba9b1cb5568fe2bc3771449adae0a1b2d7e390a'],
  wishlistDetailData: ['WishlistDetailPageDataQuery', '80d828582da08866eca55a7e9c4ef09ffa4e65c5c3183e143fd3fa7c3824fb10'],
  trips: ['GetTripsQuery', '413b3c6f25542b46f242e27bb86cdbec549debab4cb0b9281f4abf3d156c3e39'],
  connectedTrips: ['GetConnectedUserTripsQuery', 'accbdfa31c1e7462584569baac91b94daaa63282b3df783af12954402d4a7987'],
  inbox: ['InboxSyncProtocolNextPageQuery', 'b4b1301424f4058f53cafc106585401065ae8629e9b05977d6bf8568f77cba36'],
  inboxNewer: ['InboxSyncProtocolNewerThanQuery', '1c30dff8c1809dbaae4a82678370e41d9448221dcd147d8b0f95dcc895645706'],
  inboxSearch: ['InboxSyncProtocolSearchQuery', 'e69162c81021080edc8b175423e6d1c0f2367d2bd81fe00a6e60f6120ae64292'],
  inboxItems: ['InboxSyncProtocolItemFetchQuery', '4ed47977df6142a8c5809a405f86ea3183aaca5e394e43e095d1fc3bd80613cf'],
});

function descriptor(key, variables) {
  const [operationName, hash] = ACCOUNT_OPERATIONS[key];
  return { operationName, hash, variables };
}

function string(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a nonempty string`);
  return value;
}

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be an integer >= ${minimum}`);
  return value;
}

function optional(target, source, key, validate) {
  if (source[key] === undefined) return;
  target[key] = source[key] === null ? null : validate(source[key], key);
}

function json(value, name) {
  if (typeof value !== 'object' || value === null) throw new TypeError(`${name} must be a JSON object or array`);
  // Copy caller data, reject non-JSON values, and preserve explicit nulls.
  const encoded = JSON.stringify(value, (_key, entry) => {
    if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol' ||
        typeof entry === 'bigint' || (typeof entry === 'number' && !Number.isFinite(entry))) {
      throw new TypeError(`${name} must contain only JSON values`);
    }
    return entry;
  });
  return JSON.parse(encoded);
}

function strings(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value.map((entry) => string(entry, name));
}

export function buildAccount() {
  return descriptor('account', {});
}

export function buildWishlists({ offset = 0, treatmentFlags = ['wishlist_should_load_service'] } = {}) {
  const variables = { offset: integer(offset, 'offset'), limit: 20 };
  optional(variables, { treatmentFlags }, 'treatmentFlags', strings);
  return descriptor('wishlists', variables);
}

export function buildWishlistItems(options = {}) {
  const variables = {};
  optional(variables, options, 'limit', (v, n) => integer(v, n, 1));
  optional(variables, options, 'offset', integer);
  return descriptor('wishlistItems', variables);
}

function wishlist(key, options) {
  const variables = { wishlistId: string(options.wishlistId, 'wishlistId') };
  optional(variables, options, 'treatmentFlags', strings);
  optional(variables, options, 'skipUnusedFields', (v, n) => {
    if (typeof v !== 'boolean') throw new TypeError(`${n} must be boolean`);
    return v;
  });
  if (key === 'wishlistDetails') optional(variables, options, 'mockIdentifier', string);
  return descriptor(key, variables);
}

export function buildWishlistDetails(options = {}) { return wishlist('wishlistDetails', options); }
export function buildWishlistDetailData(options = {}) { return wishlist('wishlistDetailData', options); }

export function buildTrips(options = {}) {
  const variables = {};
  optional(variables, { first: 9, ...options }, 'first', (v, n) => integer(v, n, 1));
  optional(variables, options, 'after', string);
  return descriptor('trips', variables);
}

export function buildConnectedTrips(options = {}) {
  const variables = {};
  optional(variables, options, 'first', (v, n) => integer(v, n, 1));
  optional(variables, options, 'after', string);
  optional(variables, options, 'filter', json);
  return descriptor('connectedTrips', variables);
}

function inbox(key, options) {
  const variables = { numPreviewMessages: 1, pageSize: integer(options.pageSize, 'pageSize', 1) };
  optional(variables, options, 'cursor', string);
  if (key === 'inbox') optional(variables, options, 'filters', json);
  optional(variables, options, 'threadSegmentInputs', json);
  optional(variables, options, 'numRequestedMessages', integer);
  return descriptor(key, variables);
}

export function buildInbox(options = {}) { return inbox('inbox', options); }
export function buildInboxNewer(options = {}) { return inbox('inboxNewer', options); }

export function buildInboxSearch(options = {}) {
  const variables = { query: string(options.query, 'query'), numPreviewMessages: 1 };
  optional(variables, options, 'filters', json);
  optional(variables, options, 'cursor', string);
  return descriptor('inboxSearch', variables);
}

export function buildInboxItems({ ids } = {}) {
  const values = strings(ids, 'ids');
  if (!values.length) throw new TypeError('ids must not be empty');
  return descriptor('inboxItems', { ids: values, numPreviewMessages: 1 });
}

function dataOf(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new TypeError('GraphQL response must be an object');
  if (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length)) {
    const error = new Error('GraphQL response contains errors');
    error.code = 'GRAPHQL_ERROR';
    throw error;
  }
  if (!response.data || typeof response.data !== 'object') throw new Error('GraphQL response has no data');
  return response.data;
}

function identityCandidates(value) {
  const candidates = new Set([String(value)]);
  if (typeof value === 'string' && /^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    // Only compare recognizable typed IDs; never infer an ID from arbitrary bytes.
    if (/^[A-Za-z][A-Za-z0-9_]*:[^:\s]+$/.test(decoded)) {
      candidates.add(decoded);
      candidates.add(decoded.slice(decoded.indexOf(':') + 1));
    }
  }
  return candidates;
}

export function parseAccount(response, { expectedUserId } = {}) {
  const viewer = dataOf(response).viewer;
  const user = viewer?.user;
  const id = user?.id;
  if (typeof id !== 'string' || !id.trim()) throw new Error('Account response has no viewer.user.id');
  if (expectedUserId !== undefined && expectedUserId !== null) {
    const expected = identityCandidates(expectedUserId);
    if (![...identityCandidates(id)].some((entry) => expected.has(entry))) {
      const error = new Error('Account response belongs to a different user');
      error.code = 'ACCOUNT_MISMATCH';
      throw error;
    }
  }
  return { id, viewer, user, raw: response };
}

function connectionPage(connection, response) {
  const edges = Array.isArray(connection?.edges) ? connection.edges : null;
  const pageInfo = connection?.pageInfo && typeof connection.pageInfo === 'object' ? connection.pageInfo : null;
  // Preserve unknown and partial data. Missing edges never mean an empty list.
  return { edges, pageInfo, raw: response };
}

export function parseTripsPage(response) {
  return connectionPage(dataOf(response).viewer?.trips, response);
}

export function parseInboxPage(response, { mode = 'next' } = {}) {
  const aliases = { next: 'inboxItemsNextPage', newer: 'inboxItemsNewerThan', search: 'inboxSearchItems' };
  if (!Object.hasOwn(aliases, mode)) throw new TypeError('Unknown inbox page mode');
  return connectionPage(dataOf(response).viewer?.messagingInbox?.[aliases[mode]], response);
}

export function parseWishlistsPage(response) {
  const page = dataOf(response).presentation?.wishlistIndexPage;
  return { items: Array.isArray(page?.wishlists) ? page.wishlists : null, gating: page?.gating ?? null, raw: response };
}
