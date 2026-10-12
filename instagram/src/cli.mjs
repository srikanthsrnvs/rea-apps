import { parseArgs } from 'node:util';
import { InstagramError } from './errors.mjs';
import { loginInstructions, browserLogin, authStatus, importSessionFile, logout, pairingAuth } from './auth.mjs';
import { InstagramClient } from './http.mjs';
import { normalizeUser } from './normalize.mjs';
import { explore, searchContent, searchUsers, inbox } from './read.mjs';
import { readState, saveState, withStateLock } from './state.mjs';
import { relationships } from './relationships.mjs';
import { bookmarkCollections, bookmarkItems, bookmarkTree } from './bookmarks.mjs';

const cursorField = { type: 'string', minLength: 1, maxLength: 32768 };
const relationshipFields = {
  'user-id': { type: 'string', pattern: '^\\d{1,30}$', description: 'Optional target; defaults to the signed-in account.' },
  username: { type: 'string', pattern: '^[A-Za-z0-9_.]{1,30}$', description: 'Alternative to user-id; resolved by exact account-search match.' },
  cursor: cursorField, count: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
};

const tools = [
  ['login', 'Generate an Instagram approval link for the user’s own browser. Reuses an active request unless --replace is set.', {
    browser: { type: 'boolean', description: 'Optional local Chrome helper; requires a display. Default pairing works headlessly.' }, 'browser-path': { type: 'string' },
    replace: { type: 'boolean' },
    timeout: { type: 'integer', minimum: 30, maximum: 3600, default: 600 },
  }, []],
  ['auth poll', 'Check one pairing request; on approval validate and save the session. Pending output includes a retry interval.', {}],
  ['auth wait', 'Wait for browser approval and save the validated session without a browser on this host.', {
    timeout: { type: 'integer', minimum: 30, maximum: 3600, default: 600 },
  }],
  ['auth cancel', 'Cancel pending login and remove its temporary secrets, preserving the existing session.', {}],
  ['auth status', 'Inspect local session timestamps and pending approval without exposing credentials.', {}],
  ['auth import', 'Validate and import a private JSON browser session export.', { file: { type: 'string' } }, ['file']],
  ['auth logout', 'Remove local credentials and the helper browser profile.', {}],
  ['me', 'Read the signed-in account and validate its saved session.', {}],
  ['followers', 'List accessible followers with pagination and any server restriction flag. Cursor retains the target account.', relationshipFields],
  ['following', 'List accessible following accounts with pagination and any server restriction flag. Cursor retains the target account.', relationshipFields],
  ['bookmarks', 'Read a bounded tree of saved-post collections, with one media page and a continuation cursor per collection. Check complete and loaded flags.', {
    cursor: cursorField, count: { type: 'integer', minimum: 1, maximum: 12, default: 12 },
  }],
  ['bookmarks collections', 'List saved-post collections, including All posts, with pagination. This reads metadata and covers.', {
    cursor: cursorField, count: { type: 'integer', minimum: 1, maximum: 50, default: 12 },
  }],
  ['bookmarks items', 'List saved posts in one collection. Defaults to All posts; cursor retains the collection ID.', {
    'collection-id': { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
    cursor: cursorField, count: { type: 'integer', minimum: 1, maximum: 100, default: 12 },
  }],
  ['search users', 'Search account suggestions by name or username.', {
    query: { type: 'string', minLength: 1, maxLength: 200 },
  }, ['query']],
  ['search content', 'Search posts and Reels as a paginated list. Reuse the returned cursor with the same query.', {
    query: { type: 'string', minLength: 1, maxLength: 200 },
    cursor: { type: 'string', minLength: 1, maxLength: 32768 },
  }, ['query']],
  ['explore', 'List the Explore grid, including Reels; reuse the cursor to keep scrolling.', {
    cursor: { type: 'string', minLength: 1, maxLength: 32768 },
  }],
  ['inbox', 'List inbox conversation summaries and latest previews, without opening threads or marking messages read.', {
    cursor: { type: 'string', minLength: 1, maxLength: 32768 },
  }],
];

function catalog() {
  return tools.map(([command, description, fields, required = []]) => ({
    command, description,
    inputSchema: {
      type: 'object', properties: fields,
      required, additionalProperties: false,
    },
  }));
}

async function main(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, tokens: true, options: {
      browser: { type: 'boolean' }, 'browser-path': { type: 'string' }, timeout: { type: 'string' },
      replace: { type: 'boolean' },
      file: { type: 'string' }, query: { type: 'string' },
      'user-id': { type: 'string' }, username: { type: 'string' }, 'collection-id': { type: 'string' }, count: { type: 'string' },
      cursor: { type: 'string' },
      raw: { type: 'boolean' }, pretty: { type: 'boolean' }, help: { type: 'boolean' },
    } });
  } catch { throw new InstagramError('INVALID_ARGUMENT', 'Invalid or unknown command option. Run instagram --help.'); }
  const { positionals, values } = parsed;
  const command = positionals.join(' ');
  const seen = new Set();
  for (const token of parsed.tokens.filter(token => token.kind === 'option')) {
    if (seen.has(token.name)) throw new InstagramError('INVALID_ARGUMENT', `Duplicate --${token.name}.`);
    seen.add(token.name);
  }
  if (values.help || command === 'tools' || command === '') return { tools: catalog(), authentication: loginInstructions() };
  const definition = tools.find(([name]) => name === command);
  if (!definition) throw new InstagramError('INVALID_ARGUMENT', 'Unknown command. Run instagram tools.');
  const allowed = new Set([...Object.keys(definition[2]), 'pretty',
    ...(command === 'me' ? ['raw'] : [])]);
  for (const name of Object.keys(values)) {
    if (!allowed.has(name)) throw new InstagramError('INVALID_ARGUMENT', `--${name} is not valid for ${command}.`);
  }
  if (command === 'login' || command === 'auth wait') {
    const timeoutSeconds = Number(values.timeout ?? 600);
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3600) {
      throw new InstagramError('INVALID_ARGUMENT', '--timeout must be between 30 and 3600 seconds.');
    }
    if (command === 'auth wait') return pairingAuth.wait({ timeoutSeconds });
    if (values['browser-path'] && !values.browser) throw new InstagramError('INVALID_ARGUMENT', '--browser-path requires --browser.');
    if (values.browser && values.replace) throw new InstagramError('INVALID_ARGUMENT', '--replace is only valid for pairing login.');
    return values.browser ? browserLogin({ timeoutSeconds, executablePath: values['browser-path'] })
      : pairingAuth.start({ replace: values.replace, timeoutSeconds });
  }
  if (command === 'auth poll') return pairingAuth.poll();
  if (command === 'auth cancel') return pairingAuth.cancel();
  if (command === 'auth status') return authStatus();
  if (command === 'auth logout') return logout();
  if (command === 'auth import') {
    if (!values.file) throw new InstagramError('INVALID_ARGUMENT', 'Use auth import --file PRIVATE_JSON_FILE.');
    return importSessionFile(values.file);
  }
  if (command.startsWith('search ') && (!values.query?.trim() || values.query.length > 200)) {
    throw new InstagramError('INVALID_ARGUMENT', 'Provide --query with between 1 and 200 characters.');
  }
  if (values.cursor !== undefined && (!values.cursor || values.cursor.length > 32768)) throw new InstagramError('INVALID_ARGUMENT', 'Invalid cursor.');
  const countField = definition[2].count;
  const count = countField ? Number(values.count ?? countField.default) : undefined;
  if (countField && (!Number.isSafeInteger(count) || count < countField.minimum || count > countField.maximum)) throw new InstagramError('INVALID_ARGUMENT', `--count must be between ${countField.minimum} and ${countField.maximum}.`);
  if (values['user-id'] !== undefined && !/^\d{1,30}$/.test(values['user-id'])
    || values.username !== undefined && !/^[A-Za-z0-9_.]{1,30}$/.test(values.username)
    || values.username !== undefined && values['user-id'] !== undefined) throw new InstagramError('INVALID_ARGUMENT', 'Use either --user-id or --username with a valid account identifier.');
  if (values['collection-id'] !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(values['collection-id'])) throw new InstagramError('INVALID_ARGUMENT', 'Invalid saved collection ID.');
  return withStateLock(async () => {
    const session = await readState('session');
    if (!session) throw new InstagramError('LOGIN_REQUIRED', 'Run instagram login, approve its link in your browser, then run instagram auth wait.');
    const client = new InstagramClient(session, { saveSession: value => saveState('session', value) });
    const body = await client.me();
    if (command === 'me') return values.raw ? body : normalizeUser(body.user);
    if (['followers', 'following'].includes(command)) return relationships(client, command, {
      userId: values['user-id'], username: values.username, cursor: values.cursor, count,
    });
    if (command === 'bookmarks') return bookmarkTree(client, { cursor: values.cursor, count });
    if (command === 'bookmarks collections') return bookmarkCollections(client, { cursor: values.cursor, count });
    if (command === 'bookmarks items') return bookmarkItems(client, { collectionId: values['collection-id'], cursor: values.cursor, count });
    if (command === 'search users') return searchUsers(client, values.query.trim());
    if (command === 'search content') return searchContent(client, values.query.trim(), values.cursor);
    if (command === 'explore') return explore(client, values.cursor);
    if (command === 'inbox') return inbox(client, values.cursor);
  });
}

try {
  const result = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, process.argv.includes('--pretty') ? 2 : undefined)}\n`);
} catch (error) {
  const known = error instanceof InstagramError;
  process.stderr.write(`${JSON.stringify({ error: {
    code: known ? error.code : 'LOCAL_ERROR',
    message: known ? error.message : 'A local operation failed. Check file access and installation.',
    ...(known ? error.details : {}),
  } })}\n`);
  process.exitCode = 1;
}
