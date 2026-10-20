import { createClient } from './client.mjs';
import { chatsListRequest, parseChatsList, chatsSearchRequest, parseSearchResults,
  chatRequest, chatMessagesRequest, parseConversation, accountRequest, parseAccount } from './chat-read-protocol.mjs';
import { ChatGptError } from './errors.mjs';

export async function listChats({ all = false, maxPages = 1000, ...options } = {}, client) {
  client ??= await createClient();
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
    throw new ChatGptError('INVALID_ARGUMENT', 'maxPages must be between 1 and 1000.');
  }
  let offset = options.offset ?? 0;
  const items = [], seen = new Set();
  let pages = 0, duplicates = 0, result;
  do {
    const args = { ...options, offset };
    result = parseChatsList(await client.request(chatsListRequest(args)), args);
    pages++;
    if (!all) return result;
    for (const item of result.items) {
      if (seen.has(item.id)) duplicates++;
      else { seen.add(item.id); items.push(item); }
    }
    if (!result.pagination.has_more || result.pagination.stalled || pages >= maxPages) break;
    offset = result.pagination.next_offset;
  } while (offset !== null);
  return { items, pagination: { ...result.pagination, pages, duplicates, start_offset: options.offset ?? 0,
    complete: !result.pagination.has_more, stopped_by_limit: result.pagination.has_more && pages >= maxPages } };
}

export async function searchChats(query, options = {}, client) {
  client ??= await createClient();
  return parseSearchResults(await client.request(chatsSearchRequest(query, options)));
}

export async function getChat(conversationId, options = {}, client) {
  client ??= await createClient();
  return parseConversation(await client.request(chatRequest(conversationId, options)));
}

export async function getChatMessages(conversationId, options = {}, client) {
  client ??= await createClient();
  return parseConversation(await client.request(chatMessagesRequest(conversationId, options)));
}

export async function getAccount(client) {
  client ??= await createClient();
  return parseAccount(await client.request(accountRequest()));
}
