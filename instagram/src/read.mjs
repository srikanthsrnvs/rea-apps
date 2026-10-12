import { randomUUID } from 'node:crypto';
import { InstagramError } from './errors.mjs';
import { normalizeMedia, normalizeUser } from './normalize.mjs';
import { encodeCursor, decodeCursor } from './cursor.mjs';

const inboxFlags = {
  __relay_internal__pv__IGDPinnedThreadsRenderEnabledGKrelayprovider: true,
  __relay_internal__pv__IGDMaxUnreadMessagesCountrelayprovider: 5,
  __relay_internal__pv__IGDThreadListActionsEnabledGKrelayprovider: true,
};
function connection(value) {
  if (!value || !Array.isArray(value.edges) || typeof value.page_info?.has_next_page !== 'boolean') throw new InstagramError('PROTOCOL_CHANGED', 'Instagram returned an unfamiliar list. Update the CLI.');
  if (value.page_info.has_next_page && !value.page_info.end_cursor) throw new InstagramError('PROTOCOL_CHANGED', 'Instagram omitted the continuation cursor.');
  return value;
}
function page(value, kind, account, extra = {}) {
  return { hasMore: value.page_info.has_next_page, nextCursor: value.page_info.has_next_page ? encodeCursor(kind, account, { after: value.page_info.end_cursor, ...extra }) : null };
}
function advancing(list, previous) {
  if (previous && list.page_info.has_next_page && list.page_info.end_cursor === previous) throw new InstagramError('PAGINATION_STALLED', 'Instagram repeated its continuation cursor. Start a fresh list.');
}
function timestamp(value) {
  const date = new Date(Number(value));
  return value && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export function exploreItems(body) {
  if (!Array.isArray(body?.sectional_items)) throw new InstagramError('PROTOCOL_CHANGED', 'Instagram returned an unfamiliar Explore grid.');
  const items = [], seen = new Set();
  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 30) return;
    if ((value.pk || value.id) && (value.media_type || value.code) && (value.user || value.image_versions2)) {
      const item = normalizeMedia(value);
      if (item?.id && !seen.has(item.id)) { seen.add(item.id); items.push(item); }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (['layout_content', 'media', 'medias', 'items', 'clips', 'fill_items', 'one_by_two_item', 'one_by_two_items', 'full_item', 'two_by_two_item', 'two_by_three_item', 'three_by_four_item', 'tray_item', 'contextual_item', 'nested_sections', 'fallback_section'].includes(key) || Array.isArray(value)) visit(child, depth + 1);
    }
  }
  for (const section of body.sectional_items) visit(section);
  return items;
}
export async function explore(client, cursor) {
  const account = client.session.account.id;
  const saved = cursor ? decodeCursor(cursor, 'explore', account) : null;
  const body = await client.get('/discover/web/explore_grid/', {
    is_prefetch: false, omit_cover_media: false, module: 'explore_popular', include_fixed_destinations: true,
    is_nonpersonalized_explore: false, max_id: saved?.after,
  });
  // The website sends max_id, not the numeric next_max_id used by the native app.
  if (typeof body.more_available !== 'boolean' || (body.more_available && typeof body.max_id !== 'string')) throw new InstagramError('PROTOCOL_CHANGED', 'Instagram omitted Explore pagination.');
  if (saved && body.more_available && body.max_id === saved.after) throw new InstagramError('PAGINATION_STALLED', 'Instagram repeated its Explore cursor. Start a fresh list.');
  return { items: exploreItems(body), hasMore: body.more_available, nextCursor: body.more_available ? encodeCursor('explore', account, { after: body.max_id }) : null };
}
export async function searchContent(client, query, cursor) {
  const account = client.session.account.id;
  const saved = cursor ? decodeCursor(cursor, 'content', account, query) : null;
  const searchSession = saved?.searchSession ?? randomUUID();
  const variables = { query, search_session_id: searchSession, serp_session_id: searchSession, ...(saved ? { after: saved.after, first: 24 } : {}) };
  const data = await client.graphql(saved ? 'contentPage' : 'content', variables);
  const list = connection(data.xdt_fbsearch__top_serp_graphql);
  advancing(list, saved?.after);
  const seen = new Set(), items = [];
  for (const edge of list.edges) for (const media of edge.node?.items ?? []) {
    if (edge.node.__typename !== 'XDTTopSerpMediaGridUnit') continue;
    const item = normalizeMedia(media);
    if (item?.id && !seen.has(item.id)) { seen.add(item.id); items.push(item); }
  }
  return { query, items, ...page(list, 'content', account, { query, searchSession }) };
}
export async function searchUsers(client, query) {
  const data = await client.graphql('users', { data: { context: 'blended', include_reel: 'true', query, rank_token: '', search_session_id: randomUUID(), search_surface: 'web_top_search' }, hasQuery: true });
  const users = data.xdt_api__v1__fbsearch__topsearch_connection?.users;
  if (!Array.isArray(users)) throw new InstagramError('PROTOCOL_CHANGED', 'Instagram returned an unfamiliar account search.');
  return { query, users: users.map(row => normalizeUser(row.user ?? row)).filter(Boolean), hasMore: false, nextCursor: null };
}
export function normalizeInbox(box, account) {
  const list = connection(box?.threads_by_folder);
  const threads = [...(box.pinned_threads_v2 ?? []), ...list.edges.map(e => e.node)];
  const seen = new Set(), conversations = [];
  for (const row of threads) {
    const t = row?.as_ig_direct_thread;
    if (!t?.thread_id) continue;
    const id = String(t.thread_id);
    if (seen.has(id)) continue;
    seen.add(id);
    const last = t.slide_messages?.edges?.[0]?.node;
    conversations.push({ id, title: t.thread_title ?? null, group: t.is_group ?? null,
      participants: (t.usersWithoutViewer ?? t.users ?? []).filter(u => String(u.id) !== account).map(normalizeUser).filter(Boolean),
      lastActivityAt: timestamp(t.last_activity_timestamp_ms),
      markedUnread: t.marked_as_unread ?? null, pinned: t.is_pin ?? false, muted: t.is_muted ?? null,
      preview: last ? { text: last.igd_snippet ?? last.text_body ?? null, type: last.content_type ?? null, timestampMs: String(last.timestamp_ms ?? '') } : null,
    });
  }
  return { conversations, ...page(list, 'inbox', account, { mailbox: box.id }) };
}
export async function inbox(client, cursor) {
  const account = client.session.account.id;
  const saved = cursor ? decodeCursor(cursor, 'inbox', account) : null;
  const data = await client.graphql(saved ? 'inboxPage' : 'inbox', saved
    ? { ...inboxFlags, id: saved.mailbox, cursor: saved.after, count: 15, folder: 'INBOX', newer_than_timestamp_ms: null }
    : { ...inboxFlags, device_id_for_iris_subscription: client.session.deviceId ?? randomUUID(), __relay_internal__pv__IGDIsProfessionalAccountGKrelayprovider: false });
  const box = data[saved ? 'fetch__SlideMailbox' : 'get_slide_mailbox_for_iris_subscription'];
  advancing(connection(box?.threads_by_folder), saved?.after);
  return normalizeInbox(box, account);
}
