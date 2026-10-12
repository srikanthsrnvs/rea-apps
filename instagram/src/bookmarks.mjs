import { setTimeout as delay } from 'node:timers/promises';
import { InstagramError } from './errors.mjs';
import { normalizeMedia } from './normalize.mjs';
import { connection, advancing } from './read.mjs';
import { encodeCursor, decodeCursor } from './cursor.mjs';

export const allSavedId = 'ALL_MEDIA_AUTO_COLLECTION';
const collectionTypes = ['ALL_MEDIA_AUTO_COLLECTION', 'MEDIA'];

function checkCount(count, maximum = 100) {
  if (!Number.isSafeInteger(count) || count < 1 || count > maximum) throw new InstagramError('INVALID_ARGUMENT', `Count must be between 1 and ${maximum}.`);
}
function checkCollection(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)
    || id.endsWith('_AUTO_COLLECTION') && id !== allSavedId) throw new InstagramError('INVALID_ARGUMENT', 'Use a saved-post collection ID returned by bookmarks collections.');
}
function mediaItems(rows) {
  const seen = new Set();
  return rows.map(row => normalizeMedia(row?.media ?? row)).filter(item => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id); return true;
  });
}

export async function bookmarkCollections(client, { cursor, count = 12 } = {}) {
  checkCount(count, 50);
  const account = client.session.account.id;
  const saved = cursor ? decodeCursor(cursor, 'bookmark-collections', account) : null;
  const data = await client.graphql('collections', { after: saved?.after ?? null, first: count, collection_types: collectionTypes });
  const list = connection(data.viewer?.collections_unified_with_auto_collections);
  advancing(list, saved?.after);
  const seen = new Set();
  const collections = list.edges.map(edge => {
    const node = edge.node;
    if (!node || typeof node.collection_id !== 'string' || typeof node.collection_name !== 'string'
      || typeof node.__typename !== 'string' || !node.__typename) {
      throw new InstagramError('PROTOCOL_CHANGED', 'Instagram returned an unfamiliar saved-post collection.');
    }
    try { checkCollection(node.collection_id); }
    catch { throw new InstagramError('PROTOCOL_CHANGED', 'Instagram returned an invalid saved-post collection ID.'); }
    return { id: node.collection_id, name: node.collection_name,
      type: node.collection_id === allSavedId ? 'all_saved' : 'collection',
      mediaCount: Number.isSafeInteger(node.collection_media_count) ? node.collection_media_count : null,
      cover: node.cover_media ? normalizeMedia(node.cover_media) : null,
      coverItems: mediaItems(node.cover_media_list ?? []),
    };
  }).filter(node => { if (seen.has(node.id)) return false; seen.add(node.id); return true; });
  return { collections, hasMore: list.page_info.has_next_page,
    nextCursor: list.page_info.has_next_page ? encodeCursor('bookmark-collections', account, { after: list.page_info.end_cursor }) : null };
}

export async function bookmarkItems(client, { collectionId, cursor, count = 12 } = {}) {
  checkCount(count);
  const account = client.session.account.id;
  const saved = cursor ? decodeCursor(cursor, 'bookmark-items', account) : null;
  const target = collectionId ?? saved?.collection ?? allSavedId;
  checkCollection(target);
  if (saved && saved.collection !== target) throw new InstagramError('INVALID_CURSOR', 'This cursor belongs to another saved collection.');
  const endpoint = target === allSavedId ? '/feed/saved/' : `/feed/collection/${target}/`;
  const body = await client.get(endpoint, { count, include_feed_only: false, max_id: saved?.after }, { profile: 'tv' });
  if (!Array.isArray(body?.items) || typeof body.more_available !== 'boolean'
    || body.more_available && (typeof body.next_max_id !== 'string' || !body.next_max_id)) {
    throw new InstagramError('PROTOCOL_CHANGED', 'Instagram returned unfamiliar saved-media pagination.');
  }
  if (saved && body.more_available && body.next_max_id === saved.after) throw new InstagramError('PAGINATION_STALLED', 'Instagram repeated its saved-media cursor. Start a fresh list.');
  return { collectionId: target, items: mediaItems(body.items), hasMore: body.more_available,
    nextCursor: body.more_available ? encodeCursor('bookmark-items', account, { after: body.next_max_id, collection: target }) : null };
}

// A bounded hierarchy page, with independent media cursors on every collection.
// Posts may belong to several collections; preserve those memberships.
export async function bookmarkTree(client, { cursor, count = 12, pause = delay } = {}) {
  checkCount(count, 12);
  const page = await bookmarkCollections(client, { cursor, count });
  const children = page.collections.map(node => ({ ...node, loaded: false, items: null, hasMore: null, nextCursor: null }));
  for (let index = 0; index < children.length; index++) {
    if (index) await pause(1000);
    const child = children[index];
    try {
      const contents = await bookmarkItems(client, { collectionId: child.id, count });
      Object.assign(child, { loaded: true, items: contents.items, hasMore: contents.hasMore, nextCursor: contents.nextCursor });
    } catch (error) {
      if (!(error instanceof InstagramError)) throw error;
      child.error = { code: error.code, message: error.message, ...error.details };
      // Return explicit partial data; stop rather than request more after a limit.
      break;
    }
  }
  return { type: 'bookmarks', children, hasMore: page.hasMore, nextCursor: page.nextCursor,
    complete: !cursor && !page.hasMore && children.every(child => child.loaded && !child.hasMore) };
}
