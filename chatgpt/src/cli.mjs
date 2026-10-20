import fs from 'node:fs/promises';
import { parseArgs as parseNodeArgs } from 'node:util';
import { login, pollLogin, completeLogin, authStatus, cancelLogin, logout } from './auth.mjs';
import { createClient } from './client.mjs';
import { accountRequest, parseAccount, chatsSearchRequest,
  parseSearchResults, chatRequest, chatMessagesRequest, parseConversation } from './chat-read-protocol.mjs';
import { ChatGptError } from './errors.mjs';
import { toolDefinitions } from './tool-definitions.mjs';

function parseArgs(argv) {
  const schema = { pretty: { type: 'boolean' }, help: { type: 'boolean' } };
  for (const tool of toolDefinitions) for (const [key, value] of Object.entries(tool.inputSchema.properties)) schema[key] = { type: value.type };
  let parsed;
  try { parsed = parseNodeArgs({ args: argv, options: schema, allowPositionals: true, strict: true, tokens: true }); }
  catch { throw new ChatGptError('INVALID_ARGUMENT', 'Invalid arguments. Run chatgpt tools.'); }
  const words = parsed.positionals, options = parsed.values, command = words.join(' ');
  if (!command || ['help', 'tools'].includes(command) || options.help) return { words: ['tools'], options };
  const tool = toolDefinitions.find(tool => tool.command === command);
  if (!tool) throw new ChatGptError('UNKNOWN_COMMAND', 'Unknown command. Run chatgpt tools.');
  const seen = new Set();
  for (const token of parsed.tokens.filter(token => token.kind === 'option')) {
    if (seen.has(token.name)) throw new ChatGptError('INVALID_ARGUMENT', 'Duplicate option.');
    seen.add(token.name);
    if (token.name !== 'pretty' && !Object.hasOwn(tool.inputSchema.properties, token.name)) {
      throw new ChatGptError('INVALID_ARGUMENT', `--${token.name} is not accepted by this command.`);
    }
  }
  for (const key of tool.inputSchema.required) if (options[key] === undefined) throw new ChatGptError('INVALID_ARGUMENT', `Provide --${key}.`);
  return { words, options };
}
const integer = (value, fallback) => value === undefined ? fallback : Number(value);
const string = (options, key) => {
  if (typeof options[key] !== 'string') throw new ChatGptError('INVALID_ARGUMENT', `Provide --${key}.`);
  return options[key];
};

export async function dispatch(argv) {
  const { words, options: o } = parseArgs(argv);
  const command = words.join(' ');
  if (command === 'tools') return { tools: toolDefinitions };
  if (command === 'login') return login({ email: typeof o.email === 'string' ? o.email : undefined, replace: o.replace === true });
  if (command === 'auth status') return authStatus();
  if (command === 'auth poll') return pollLogin({ loginId: string(o, 'login-id') });
  if (command === 'auth cancel') return cancelLogin({ loginId: string(o, 'login-id') });
  if (command === 'logout') return logout();
  if (command === 'auth complete') {
    if ((o['callback-file'] !== undefined) === (o['callback-url'] !== undefined)) throw new ChatGptError('INVALID_ARGUMENT', 'Provide exactly one callback URL source.');
    const callbackUrl = o['callback-file'] ? (await fs.readFile(string(o, 'callback-file'), 'utf8')).trim() : string(o, 'callback-url');
    return completeLogin({ loginId: string(o, 'login-id'), callbackUrl });
  }
  if (command === 'chat new' || command === 'chat reply' || command.startsWith('codex ')) {
    let prompt = o.prompt;
    if (command === 'chat new' || command === 'chat reply' || ['codex new', 'codex reply'].includes(command)) {
      if ((o.prompt !== undefined) === (o['prompt-file'] !== undefined)) throw new ChatGptError('INVALID_ARGUMENT', 'Provide exactly one prompt source.');
      if (o['prompt-file']) {
        if ((await fs.stat(o['prompt-file'])).size > 1024 * 1024) throw new ChatGptError('INVALID_ARGUMENT', 'Prompt files must not exceed 1 MiB.');
        prompt = await fs.readFile(o['prompt-file'], 'utf8');
      }
    }
    if (command.startsWith('codex ')) {
      const { readCodex, mutateCodex, codexOperationStatus } = await import('./codex.mjs');
      const kind = words[1];
      if (kind === 'operation') return codexOperationStatus(o['operation-id']);
      const options = { operationId: o['operation-id'], threadId: o['thread-id'], turnId: o['turn-id'],
        environmentId: o['environment-id'], prompt, model: o.model, effort: o.effort, scope: o.scope,
        query: o.query, cursor: o.cursor, limit: o.limit === undefined ? undefined : Number(o.limit), all: o.all === true };
      return ['new', 'reply', 'stop'].includes(kind) ? mutateCodex(kind, options) : readCodex(kind, options);
    }
    return (await import('./turns.mjs')).sendTurn({ operationId: o['operation-id'], chatId: o['chat-id'], prompt,
      model: o.model, timezone: o.timezone, parentMessageId: o['parent-message-id'] });
  }
  if (command === 'turn status') return (await import('./turns.mjs')).turnStatus({ operationId: o['operation-id'] });
  if (command === 'turn stop') return (await import('./turns.mjs')).stopTurn({ operationId: o['operation-id'] });
  if (command === 'models') return (await import('./turns.mjs')).getModels();
  const client = await createClient();
  if (command === 'account') return parseAccount(await client.request(accountRequest()));
  if (command === 'chats list') {
    const args = { offset: integer(o.offset, 0), limit: integer(o.limit, 20), order: o.order ?? 'updated', archived: o.archived === true, expand: o.expand === true };
    return (await import('./chats.mjs')).listChats({ ...args, all: o.all === true }, client);
  }
  if (command === 'chats search') return parseSearchResults(await client.request(chatsSearchRequest(string(o, 'query'), {
    cursor: o.cursor, limit: integer(o.limit, 20), queryId: o['query-id'],
  })));
  const args = { numTurns: integer(o['num-turns'], 50), before: o.before, includeMessageId: o['include-message-id'], projectId: o['project-id'], ownerId: o['owner-id'] };
  const request = command === 'chat messages' ? chatMessagesRequest(string(o, 'chat-id'), args) : chatRequest(string(o, 'chat-id'), args);
  return parseConversation(await client.request(request));
}

export async function run(argv = process.argv.slice(2)) {
  try { console.log(JSON.stringify(await dispatch(argv), null, argv.includes('--pretty') ? 2 : undefined)); }
  catch (error) {
    const known = error instanceof ChatGptError;
    console.error(JSON.stringify({ error: { code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : 'The command could not complete.', ...(known ? { details: error.details } : {}) } }));
    process.exitCode = 1;
  }
}
