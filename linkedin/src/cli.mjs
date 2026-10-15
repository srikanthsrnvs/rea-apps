import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { LinkedInError } from './errors.mjs';
import { LinkedInClient } from './http.mjs';
import { me } from './account.mjs';
import { searchPeople, getProfile } from './people.mjs';
import { listConversations, searchConversations, getConversation, findConversationsByRecipients, listMessages,
  changeConversationCategory, setNotificationStatus, setConversationRead } from './inbox.mjs';
import { prepareOperation, sendOperation, getOperation, reconcileOperation } from './operations.mjs';
import { newSession, sessionFromExport, sessionStatus } from './session.mjs';
import { loginWithPassword, loginWithGoogleToken } from './auth-protocol.mjs';
import { readState, saveState, removeState, withStateLock } from './state.mjs';
import { tools } from './tools.mjs';
import { readAndroidSession } from './android-session.mjs';
import { prepareInvitation, sendInvitation, invitationStatus } from './connections.mjs';

function invalid(message) { throw new LinkedInError('INVALID_ARGUMENT', message); }
async function stdin() {
  let value = ''; for await (const chunk of process.stdin) { value += chunk; if (value.length > 1_000_000) invalid('Input is too large.'); }
  return value;
}
async function jsonFile(filename) {
  const content = filename === '-' ? await stdin() : await fs.readFile(filename, 'utf8');
  if (content.length > 1_000_000) invalid('Input is too large.');
  try { return JSON.parse(content); } catch { invalid('Provide valid JSON input.'); }
}
function validateArgs(name, args) {
  const spec = tools.find(t => t.name === name)?.inputSchema;
  if (!spec) invalid(`Unknown tool: ${name}. Run linkedin tools.`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) invalid('Tool input must be a JSON object.');
  for (const name of Object.keys(args)) if (!(name in spec.properties)) invalid(`Unknown input property: ${name}.`);
  for (const name of spec.required ?? []) if (args[name] === undefined) invalid(`Missing input property: ${name}.`);
  for (const [key, value] of Object.entries(args)) {
    const property = spec.properties[key];
    if (property.type === 'integer' ? !Number.isSafeInteger(value) : property.type === 'array' ? !Array.isArray(value) : typeof value !== property.type) invalid(`Invalid input type for ${key}.`);
    if (property.const !== undefined && property.const !== value) invalid(`${key} must be ${property.const}.`);
    if (property.enum && !property.enum.includes(value)) invalid(`Unsupported ${key}.`);
  }
}
async function authenticated(operation) {
  return withStateLock(async () => {
    const session = await readState('session');
    if (!session) throw new LinkedInError('AUTH_REQUIRED', 'No LinkedIn CLI session is saved. Native authentication or a session import is required. Run linkedin login for the current options.');
    const client = new LinkedInClient(session);
    try {
      if (!session.account?.mailboxUrn) await me(client);
      return await operation(client);
    } finally { await saveState('session', client.session); }
  });
}
async function call(name, args) {
  validateArgs(name, args);
  if (name === 'auth.status') return withStateLock(async () => sessionStatus(await readState('session')));
  if (name === 'auth.import_android') {
    const input = await readAndroidSession(args);
    return withStateLock(async () => {
      const client = new LinkedInClient(sessionFromExport(input));
      await me(client); await saveState('session', client.session);
      return { ...sessionStatus(client.session), androidRequiredAtRuntime: false };
    });
  }
  if (name === 'message.status') return withStateLock(() => getOperation(args.operationId));
  if (name === 'connection.status') return withStateLock(() => invitationStatus(args.operationId));
  return authenticated(async client => {
    const mailboxUrn = client.session.account.mailboxUrn;
    switch (name) {
      case 'me': return me(client);
      case 'people.search': return searchPeople(client, args);
      case 'profile.get': return getProfile(client, args);
      case 'inbox.list': return listConversations(client, { ...args, mailboxUrn });
      case 'inbox.search': return searchConversations(client, { ...args, mailboxUrn });
      case 'conversation.get': return getConversation(client, args);
      case 'conversation.find': return findConversationsByRecipients(client, { ...args, mailboxUrn });
      case 'messages.list': return listMessages(client, args);
      case 'message.prepare': {
        if (args.profile && (args.recipientUrns || args.conversationUrn)) invalid('Use profile, recipientUrns or conversationUrn, not a combination.');
        const recipientUrns = args.profile ? [(await getProfile(client, { identifier: args.profile })).profileUrn] : args.recipientUrns;
        return prepareOperation({ ...args, recipientUrns, mailboxUrn });
      }
      case 'message.send': return sendOperation(client, args.operationId, args);
      case 'message.reconcile': return reconcileOperation(client, args.operationId, args);
      case 'connection.prepare': {
        if (Boolean(args.profile) === Boolean(args.recipientUrn)) invalid('Use exactly one of profile or recipientUrn.');
        const recipientUrn = args.profile ? (await getProfile(client, { identifier: args.profile })).profileUrn : args.recipientUrn;
        return prepareInvitation({ mailboxUrn, recipientUrn, note: args.note });
      }
      case 'connection.send': return sendInvitation(client, args.operationId, args);
      case 'inbox.category': return changeConversationCategory(client, args);
      case 'inbox.notifications': return setNotificationStatus(client, args);
      case 'inbox.read': return setConversationRead(client, args);
    }
  });
}

async function main() {
  const { values: options, positionals: parts } = parseArgs({ allowPositionals: true, options: {
    json: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' }, username: { type: 'string' }, serial: { type: 'string' }, adb: { type: 'string' },
    query: { type: 'string' }, count: { type: 'string' }, cursor: { type: 'string' }, category: { type: 'string' },
    id: { type: 'string' }, urn: { type: 'string' }, conversation: { type: 'string' }, to: { type: 'string', multiple: true },
    text: { type: 'string' }, operation: { type: 'string' }, confirm: { type: 'boolean' },
    'contact-info': { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' },
  } });
  if (options.version) return { version: '0.1.0' };
  if (options.help || !parts.length) return { name: 'linkedin', commands: ['tools', 'call TOOL --json JSON', 'call TOOL --input -', 'login', 'auth status', 'auth import-android --serial DEVICE', 'auth import FILE', 'auth export --output FILE', 'logout', 'me', 'search --query TEXT', 'profile URL_OR_URN', 'inbox', 'messages --conversation URN', 'message prepare --to PROFILE_URN --text TEXT', 'message send --operation UUID --confirm', 'connection prepare --to PROFILE_URN --text NOTE', 'connection send --operation UUID --confirm', 'connection status --operation UUID'],
    scope: 'People search, profiles and inbox. No feed or posting.', auth: 'Google-only accounts use a native Android session bootstrap, followed by HTTP-only commands. No browser is launched.' };
  const [command, action, parameter] = parts;
  if (command === 'tools') return { tools, validation: { localTests: true, liveAccount: true, liveSend: false, liveInvitation: true,
    verifiedReads: ['me', 'people.search', 'profile.get', 'inbox.list', 'inbox.search', 'conversation.get', 'messages.list'],
    authentication: 'Google sign-in bootstrapped from the original Android app; later commands use HTTP. Fresh Google-only login is not host-only.' } };
  if (command === 'call') {
    if (Boolean(options.json) === Boolean(options.input)) invalid('Provide one of --json JSON or --input FILE (use - for stdin).');
    let args;
    try { args = options.input ? await jsonFile(options.input) : JSON.parse(options.json); } catch (error) { if (error instanceof SyntaxError) invalid('Provide valid JSON input.'); throw error; }
    return call(action, args);
  }
  if (command === 'login') {
    if (!options.username) {
      if (await readState('session')) return authenticated(async client => { await me(client); return sessionStatus(client.session); });
      return { authenticated: false, status: 'native_bootstrap_required', browserRequiredOnHost: false,
        googleSignIn: 'Sign in using Google in the original LinkedIn Android app in a permitted test environment, then import its session. A stock nondebuggable phone does not expose that session to ADB.',
        importCommand: 'linkedin auth import-android --serial DEVICE_SERIAL',
        headlessTransfer: 'On the test host: auth export --output PRIVATE_FILE. Transfer privately, then auth import PRIVATE_FILE on Linux.',
        passwordCommand: 'linkedin login --username EMAIL < PRIVATE_PASSWORD_FILE' };
    }
    const password = (await stdin()).replace(/\r?\n$/, '');
    return withStateLock(async () => {
      const client = new LinkedInClient(newSession());
      const result = await loginWithPassword(client, { identifier: options.username, password });
      if (result.status !== 'validation_required') { await saveState('pending-login', client.session); return result; }
      await me(client); await saveState('session', client.session); await removeState('pending-login');
      return sessionStatus(client.session);
    });
  }
  if (command === 'auth') {
    if (action === 'status') return call('auth.status', {});
    if (action === 'import') {
      const input = await jsonFile(parameter ?? options.input ?? '-');
      return withStateLock(async () => {
        const client = new LinkedInClient(sessionFromExport(input));
        await me(client); await saveState('session', client.session); return sessionStatus(client.session);
      });
    }
    if (action === 'import-android') return call('auth.import_android', { serial: options.serial, ...(options.adb ? { adb: options.adb } : {}) });
    if (action === 'google') {
      const input = await jsonFile(options.input ?? '-');
      return withStateLock(async () => {
        const client = new LinkedInClient(newSession());
        const result = await loginWithGoogleToken(client, { idToken: input.googleIdToken });
        if (result.status !== 'validation_required') { await saveState('pending-login', client.session); return result; }
        await me(client); await saveState('session', client.session); await removeState('pending-login');
        return sessionStatus(client.session);
      });
    }
    if (action === 'export') {
      if (!options.output) invalid('Provide --output FILE. Session credentials are never printed.');
      return withStateLock(async () => {
        const session = await readState('session');
        if (!session) throw new LinkedInError('AUTH_REQUIRED', 'No saved LinkedIn session.');
        await fs.writeFile(options.output, JSON.stringify(session) + '\n', { flag: 'wx', mode: 0o600 });
        return { exported: true, path: options.output };
      });
    }
    invalid('Use auth status, auth google --input FILE, auth import FILE, or auth export --output FILE.');
  }
  if (command === 'logout') return withStateLock(async () => { await removeState('session'); await removeState('pending-login'); return { authenticated: false, localSessionRemoved: true }; });
  if (command === 'me') return call('me', {});
  if (command === 'search') return call('people.search', { keywords: options.query ?? action ?? '', ...(options.count ? { count: Number(options.count) } : {}), ...(options.cursor ? { cursor: options.cursor } : {}) });
  if (command === 'profile') {
    const id = options.id ?? options.urn ?? action;
    return call('profile.get', { ...(id?.startsWith('urn:') ? { urn: id } : { identifier: id }), ...(options['contact-info'] ? { contactInfo: true } : {}) });
  }
  if (command === 'inbox') return call('inbox.list', { ...(options.category ? { category: options.category } : {}), ...(options.count ? { count: Number(options.count) } : {}), ...(options.cursor ? { nextCursor: options.cursor } : {}) });
  if (command === 'messages') return call('messages.list', { conversationUrn: options.conversation ?? action, ...(options.count ? { count: Number(options.count) } : {}), ...(options.cursor ? { nextCursor: options.cursor } : {}) });
  if (command === 'message') {
    if (action === 'prepare') return call('message.prepare', { ...(options.conversation ? { conversationUrn: options.conversation } : { recipientUrns: options.to }), text: options.text });
    if (['send', 'status', 'reconcile'].includes(action)) return call(`message.${action}`, { operationId: options.operation ?? parameter, ...(action === 'send' ? { confirm: Boolean(options.confirm) } : {}), ...(action === 'reconcile' && options.conversation ? { conversationUrn: options.conversation } : {}) });
  }
  if (command === 'connection') {
    if (action === 'prepare') {
      if (options.to?.length !== 1) invalid('Supply one resolved recipient with --to.');
      return call('connection.prepare', { recipientUrn: options.to[0], note: options.text });
    }
    if (['send', 'status'].includes(action)) return call(`connection.${action}`, { operationId: options.operation ?? parameter, ...(action === 'send' ? { confirm: Boolean(options.confirm) } : {}) });
  }
  invalid('Unknown command. Run linkedin --help or linkedin tools.');
}

try { console.log(JSON.stringify({ ok: true, data: await main() })); }
catch (error) {
  const expected = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code);
  console.log(JSON.stringify({ ok: false, error: { code: expected ? error.code : 'CLI_ERROR', message: expected ? error.message : 'The command could not complete.', ...(error.details ? { details: error.details } : {}) } }));
  process.exitCode = 1;
}
