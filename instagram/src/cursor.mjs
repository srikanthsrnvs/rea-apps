import { InstagramError } from './errors.mjs';
export function encodeCursor(kind, account, data) {
  return Buffer.from(JSON.stringify({ version: 1, kind, account, ...data })).toString('base64url');
}
export function decodeCursor(token, kind, account, query) {
  if (typeof token !== 'string' || token.length > 32768 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new InstagramError('INVALID_CURSOR', 'Invalid continuation cursor.');
  let value;
  try { value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); } catch {}
  if (!value || value.version !== 1 || value.kind !== kind || value.account !== account || typeof value.after !== 'string' || !value.after || value.after.length > 16384 || (query !== undefined && value.query !== query)) {
    throw new InstagramError('INVALID_CURSOR', 'This cursor belongs to another command, account, or search.');
  }
  if (kind === 'inbox' && (typeof value.mailbox !== 'string' || value.mailbox.length > 2048)) throw new InstagramError('INVALID_CURSOR', 'Invalid inbox continuation.');
  if (kind === 'content' && (typeof value.searchSession !== 'string' || !/^[a-f0-9-]{36}$/.test(value.searchSession))) throw new InstagramError('INVALID_CURSOR', 'Invalid search continuation.');
  if (['followers', 'following'].includes(kind) && (typeof value.target !== 'string' || !/^\d{1,30}$/.test(value.target)
    || value.username != null && (typeof value.username !== 'string' || !/^[A-Za-z0-9_.]{1,30}$/.test(value.username)))) throw new InstagramError('INVALID_CURSOR', 'Invalid relationship continuation.');
  if (kind === 'bookmark-items' && (typeof value.collection !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.collection))) throw new InstagramError('INVALID_CURSOR', 'Invalid saved collection continuation.');
  return value;
}
