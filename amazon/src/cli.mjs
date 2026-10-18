import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { AmazonError } from './errors.mjs';
import { login, completeLogin, authStatus, refreshLogin, refreshShoppingCookies, cancelLogin, logout } from './auth.mjs';

const uuid = { type: 'string', format: 'uuid' };
const text = { type: 'string' };
const definitions = [
  ['capabilities', 'Report verified features and remaining protocol work.', {}],
  ['login', 'Issue an Amazon pairing code and official approval URL. Reuses an existing pending login or saved account. No host browser, display or Android is used.', { replace: { type: 'boolean' } }],
  ['auth complete', 'After the user approves the code on Amazon’s website, exchange it once and independently refresh the new session before saving.', { 'login-id': uuid }, ['login-id']],
  ['auth status', 'Inspect login status without exposing cookies, private pairing codes or account tokens.', {}],
  ['auth refresh', 'Independently validate a saved account token over HTTP.', {}],
  ['auth cookies', 'Renew the saved shopping cookies through the native token service, without a browser.', {}],
  ['auth cancel', 'Remove pending login state while preserving the saved account.', { 'login-id': uuid }, ['login-id']],
  ['auth logout', 'Remove locally saved account and pending login credentials.', {}],
  ['search', 'Search Amazon Shopping over HTTP. Results include product IDs, current displayed prices and source pagination cursors. Does not change the cart.', { query: text, cursor: text }],
  ['product', 'Read product title, displayed price, availability, rating and features. Does not add to cart or buy.', { asin: text }, ['asin']],
  ['orders list', 'Read signed-in order history with source pagination. Returns local account-bound order references; missing totals or eligibility remain unknown.', { cursor: text }],
  ['orders details', 'Read the exact detail page returned for an account-bound order reference. Does not cancel or change an order.', { 'order-ref': uuid }, ['order-ref']],
  ['cart', 'Read the current cart, selected quantities, prices and source item references. Does not change the cart.', {}],
  ['cart prepare-add', 'Prepare adding one unit of a product to the cart. Does not purchase or change the cart.', { asin:text }, ['asin']],
  ['cart prepare-remove', 'Prepare removal of a specific cart item. Does not change the cart.', { 'cart-ref':uuid, 'item-ref':text }, ['cart-ref','item-ref']],
  ['cart apply', 'Apply a prepared cart addition/removal once. Refuses a changed cart. Never purchases.', { 'plan-id':uuid }, ['plan-id']],
  ['checkout prepare', 'Read checkout over HTTP, decline optional Prime enrollment and return exact items, total, shipping address and saved payment for user approval. Does not purchase.', {}],
  ['checkout place', 'PURCHASE: require explicit user approval of the prepared review. Revalidate all terms and submit once. An uncertain result is never retried.', { 'plan-id':uuid, 'confirm-total':text, currency:text }, ['plan-id','confirm-total','currency']],
  ['orders cancel prepare', 'Check cancellation eligibility for an account-bound order and return any supported source form choices. Does not cancel.', { 'order-ref':uuid }, ['order-ref']],
  ['orders cancel', 'CANCEL: submit a prepared cancellation only after user approval. Preserves hidden source fields; uncertain outcomes are never retried. Optional values are a JSON object of source choices.', { 'plan-id':uuid, confirm:{type:'boolean'}, values:text }, ['plan-id','confirm']],
  ['operation status', 'Read a prepared action or submitted action result without replaying it.', { 'plan-id':uuid }, ['plan-id']],
];
export const toolDefinitions = definitions.map(([command, description, properties, required = []]) => ({ command, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } }));
export async function main(argv) {
  const options = { pretty: { type: 'boolean' }, help: { type: 'boolean' } };
  for (const definition of toolDefinitions) for (const [key, field] of Object.entries(definition.inputSchema.properties)) options[key] = { type: field.type };
  let parsed;
  try { parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true, tokens: true }); }
  catch { throw new AmazonError('INVALID_ARGUMENT', 'Invalid arguments. Run amazon tools.'); }
  const command = parsed.positionals.join(' ');
  if (!command || command === 'tools' || parsed.values.help) return { tools: toolDefinitions };
  const definition = toolDefinitions.find(value => value.command === command);
  if (!definition) throw new AmazonError('INVALID_ARGUMENT', 'Unknown command. Run amazon tools.');
  const seen = new Set();
  for (const token of parsed.tokens.filter(token => token.kind === 'option')) {
    if (seen.has(token.name)) throw new AmazonError('INVALID_ARGUMENT', 'Duplicate option.');
    seen.add(token.name);
    if (token.name !== 'pretty' && !Object.hasOwn(definition.inputSchema.properties, token.name)) throw new AmazonError('INVALID_ARGUMENT', `--${token.name} is not accepted by this command.`);
  }
  const values = parsed.values;
  for (const key of definition.inputSchema.required) if (values[key] === undefined) throw new AmazonError('INVALID_ARGUMENT', `Provide --${key}.`);
  for (const [key, schema] of Object.entries(definition.inputSchema.properties)) {
    if (schema.format === 'uuid' && values[key] && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(values[key])) throw new AmazonError('INVALID_ARGUMENT', `Invalid --${key}.`);
  }
  if (command === 'capabilities') return { runtime: { transport: 'node_http', browser: false, android: false, tunnel: false }, authentication: { pairing: 'live_verified', registration: 'live_verified', refresh: 'live_verified', shoppingCookies: 'live_verified' }, shopping: { search: 'http_verified', product: 'http_verified', orders: 'http_verified', cartRead: 'http_verified', checkoutReview: 'http_verified', cartChanges: 'implemented_not_live_submitted', purchase: 'implemented_not_live_submitted', cancellation: 'source_form_adapter_not_live_submitted' } };
  if (command === 'login') return login({ replace: values.replace });
  if (command === 'auth complete') return completeLogin({ loginId: values['login-id'] });
  if (command === 'auth status') return authStatus();
  if (command === 'auth refresh') return refreshLogin();
  if (command === 'auth cookies') return refreshShoppingCookies();
  if (command === 'auth cancel') return cancelLogin({ loginId: values['login-id'] });
  if (command === 'auth logout') return logout();
  if (command === 'search') return (await import('./shopping.mjs')).searchProducts({ query: values.query, cursor: values.cursor });
  if (command === 'product') return (await import('./shopping.mjs')).productDetails({ asin: values.asin });
  if (command === 'orders list') return (await import('./orders.mjs')).listOrders({ cursor: values.cursor });
  if (command === 'orders details') return (await import('./orders.mjs')).orderDetails({ orderRef: values['order-ref'] });
  if (command === 'cart') return (await import('./commerce.mjs')).showCart();
  if (command === 'cart prepare-add') return (await import('./commerce.mjs')).prepareAdd({asin:values.asin});
  if (command === 'cart prepare-remove') return (await import('./commerce.mjs')).prepareRemove({cartRef:values['cart-ref'],itemRef:values['item-ref']});
  if (command === 'cart apply') return (await import('./commerce.mjs')).applyCart({planId:values['plan-id']});
  if (command === 'checkout prepare') return (await import('./commerce.mjs')).prepareCheckout();
  if (command === 'checkout place') return (await import('./commerce.mjs')).placeOrder({planId:values['plan-id'],confirmTotal:values['confirm-total'],currency:values.currency});
  if (command === 'orders cancel prepare') return (await import('./commerce.mjs')).prepareCancellation({orderRef:values['order-ref']});
  if (command === 'orders cancel') {
    let choices={};
    try { if(values.values!==undefined)choices=JSON.parse(values.values); } catch { throw new AmazonError('INVALID_ARGUMENT','--values must be a JSON object.'); }
    return (await import('./commerce.mjs')).cancelOrder({planId:values['plan-id'],confirm:values.confirm,values:choices});
  }
  if (command === 'operation status') return (await import('./commerce.mjs')).operationStatus({planId:values['plan-id']});
}
export async function run(argv = process.argv.slice(2)) {
  try { process.stdout.write(`${JSON.stringify(await main(argv), null, argv.includes('--pretty') ? 2 : undefined)}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ error: { code: error instanceof AmazonError ? error.code : 'LOCAL_ERROR', message: error instanceof AmazonError ? error.message : 'A local operation failed.', ...(error instanceof AmazonError ? error.details : {}) } })}\n`); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
