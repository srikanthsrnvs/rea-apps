#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, ApiError } from './http.mjs';
import * as disk from './state.mjs';
import { authStart, authComplete, authStatus, authLogout } from './auth.mjs';
import { currentAccount } from './account.mjs';
import * as catalog from './catalog.mjs';
import { listCarts, getCart, setCartItem } from './cart.mjs';
import { listOrders, getOrder } from './orders.mjs';
import { prepareCheckout } from './checkout.mjs';
import { tools, validateArguments } from './tools.mjs';

export const help = `Instacart CLI — JSON output; headless native HTTP; no API key.

instacart tools
instacart login --phone NUMBER
instacart auth complete --code CODE
instacart auth status | auth check | logout
instacart addresses
instacart stores --postal-code ZIP --latitude LAT --longitude LNG
instacart search --shop-id ID --postal-code ZIP --query coffee [--cursor CURSOR]
instacart item --shop-id ID --id ITEM_ID
instacart carts | cart get --cart-id ID
instacart cart set --cart-id ID --item-id ID --quantity NUMBER
instacart orders [--after CURSOR]
instacart checkout prepare --cart-id ID --shop-id ID --address-id ID [--service delivery]
instacart call TOOL_NAME --input '{"argument":"value"}'

Run tools for exact schemas and additional options. Checkout spending is not enabled.
State: INSTACART_CLI_STATE_DIR or ~/.config/instacart-cli (private files).
`;

function invalid(message) { throw new ApiError('INVALID_ARGUMENT', message); }

export function parseCommand(argv) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) return { special: 'help' };
  if (argv[0] === 'tools' && argv.length === 1) return { special: 'tools' };
  if (argv[0] === 'call') {
    if (argv.length !== 4 || argv[2] !== '--input') invalid('Use call TOOL_NAME --input JSON.');
    const tool = tools.find(item => item.name === argv[1]);
    if (!tool) invalid('Unknown tool. Run tools for available operations.');
    let args;
    try { args = JSON.parse(argv[3]); } catch { invalid('Tool input must be valid JSON.'); }
    return { tool, args: validateArguments(tool, args) };
  }
  const optionAt = argv.findIndex(value => value.startsWith('--'));
  const command = (optionAt < 0 ? argv : argv.slice(0, optionAt)).join(' ');
  const tool = tools.find(item => item.command === command);
  if (!tool) invalid('Unknown command. Run help or tools.');
  const args = {};
  const flags = optionAt < 0 ? [] : argv.slice(optionAt);
  for (let i = 0; i < flags.length; i++) {
    const raw = flags[i];
    if (!raw.startsWith('--') || raw.includes('=')) invalid('Use --option VALUE syntax.');
    const key = raw.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const schema = tool.inputSchema.properties[key];
    if (!schema || Object.hasOwn(args, key)) invalid(`Unknown or repeated option: ${raw}.`);
    let value = flags[i + 1];
    if (schema.type === 'boolean' && (value === undefined || value.startsWith('--'))) args[key] = true;
    else {
      if (value === undefined || value.startsWith('--')) invalid(`Missing value for ${raw}.`);
      i++;
      if (schema.type === 'boolean') { if (!['true', 'false'].includes(value)) invalid(`${raw} must be true or false.`); args[key] = value === 'true'; }
      else if (['number', 'integer'].includes(schema.type)) { if (!value.trim()) invalid(`Invalid number for ${raw}.`); args[key] = Number(value); }
      else if (schema.type === 'array') args[key] = value.split(',');
      else args[key] = value;
    }
  }
  return { tool, args: validateArguments(tool, args) };
}

export async function dispatch(tool, args, dependencies = {}) {
  const store = dependencies.store ?? disk;
  const clientFactory = dependencies.clientFactory ?? createClient;
  return store.withStateLock(async () => {
    const state = await store.readState('session') ?? {};
    const client = clientFactory(state);
    if (tool.authenticated && !state.accessToken) throw new ApiError('AUTH_REQUIRED', 'Run login and auth complete before using this command.');
    try {
      switch (tool.name) {
        case 'login': return await authStart(client, state, args);
        case 'auth_complete': return await authComplete(client, state, { ...args, validateSession: async candidate => {
          const account = await currentAccount(clientFactory({ ...state, accessToken: candidate }));
          state.userId = account.id;
          return account;
        } });
        case 'auth_status': return authStatus(state);
        case 'auth_check': case 'account': return await currentAccount(client);
        case 'logout': delete state.userId; return authLogout(state);
        case 'addresses': return await catalog.addresses(client);
        case 'stores': return await catalog.stores(client, args);
        case 'shop': return await catalog.shop(client, args);
        case 'search': return await catalog.search(client, args);
        case 'items': return await catalog.items(client, args);
        case 'item': return await catalog.item(client, args);
        case 'prices': return await catalog.prices(client, args);
        case 'carts': return await listCarts(client, args);
        case 'cart_get': return await getCart(client, args);
        case 'cart_set': return await setCartItem(client, args);
        case 'orders': return await listOrders(client, args);
        case 'order': return await getOrder(client, args);
        case 'checkout_prepare': return await prepareCheckout(client, args, { save: store.saveState });
        default: throw new ApiError('UNKNOWN_TOOL', 'Unknown tool.');
      }
    } finally { await store.saveState('session', state); }
  });
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseCommand(argv);
    if (parsed.special === 'help') { process.stdout.write(help); return; }
    if (parsed.special === 'tools') { console.log(JSON.stringify({ app: 'instacart', version: '0.1.0', tools }, null, 2)); return; }
    const data = await dispatch(parsed.tool, parsed.args);
    console.log(JSON.stringify({ ok: true, data }, null, 2));
  } catch (error) {
    const code = /^[A-Z0-9_]{1,100}$/.test(error.code ?? '') ? error.code : 'INTERNAL_ERROR';
    const message = code === 'INTERNAL_ERROR' ? 'The command failed. No operation was automatically repeated.' : error.message;
    console.log(JSON.stringify({ ok: false, error: { code, message, ...(error.details ? { details: error.details } : {}) } }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
