import { InstagramError } from './errors.mjs';
import { normalizeUser } from './normalize.mjs';
import { decodeCursor, encodeCursor } from './cursor.mjs';
import { searchUsers } from './read.mjs';

export async function relationships(client, kind, { userId, username, cursor, count = 50 } = {}) {
  if (!['followers', 'following'].includes(kind)) throw new InstagramError('INVALID_ARGUMENT', 'Unknown relationship list.');
  if (userId !== undefined && (typeof userId !== 'string' || !/^\d{1,30}$/.test(userId))
    || username !== undefined && !/^[A-Za-z0-9_.]{1,30}$/.test(username)
    || userId !== undefined && username !== undefined
    || !Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw new InstagramError('INVALID_ARGUMENT', 'Use either --user-id or --username, and a count between 1 and 100.');
  }
  const account = client.session.account.id;
  const saved = cursor ? decodeCursor(cursor, kind, account) : null;
  if (saved && (userId && saved.target !== userId
    || username && saved.username?.toLowerCase() !== username.toLowerCase())) {
    throw new InstagramError('INVALID_CURSOR', 'This cursor belongs to a different target account.');
  }
  let target = saved?.target ?? userId ?? account;
  let targetUsername = saved?.username ?? (target === account ? client.session.account.username : null);
  if (username && !saved) {
    const result = await searchUsers(client, username);
    const exact = result.users.find(user => user.username?.toLowerCase() === username.toLowerCase());
    if (!exact?.id || !/^\d{1,30}$/.test(exact.id)) throw new InstagramError('USER_NOT_FOUND', 'Account search did not return that exact username. Use --user-id if you know the account ID.');
    target = exact.id; targetUsername = exact.username;
  }
  const body = await client.get(`/friendships/${target}/${kind}/`, { count, max_id: saved?.after });
  if (!Array.isArray(body?.users) || body.next_max_id != null && typeof body.next_max_id !== 'string'
    || body.has_more === true && !body.next_max_id) {
    throw new InstagramError('PROTOCOL_CHANGED', 'Instagram returned unfamiliar relationship pagination.');
  }
  const hasMore = Boolean(body.next_max_id);
  if (saved && hasMore && body.next_max_id === saved.after) throw new InstagramError('PAGINATION_STALLED', 'Instagram repeated its relationship cursor. Start a fresh list.');
  const seen = new Set();
  const users = body.users.map(normalizeUser).filter(user => {
    if (!user?.id || seen.has(user.id)) return false;
    seen.add(user.id); return true;
  });
  const limited = body[kind === 'followers' ? 'should_limit_list_of_followers' : 'should_limit_list_of_followings'];
  return { userId: target, username: targetUsername, users, hasMore,
    nextCursor: hasMore ? encodeCursor(kind, account, { after: body.next_max_id, target, username: targetUsername }) : null,
    limited: typeof limited === 'boolean' ? limited : null,
    hiddenFollowingCount: kind === 'following' && Number.isSafeInteger(body.hidden_following_account_count) ? body.hidden_following_account_count : null,
  };
}
