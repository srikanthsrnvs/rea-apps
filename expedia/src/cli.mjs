import { parseArgs } from 'node:util';
import { ExpediaError } from './errors.mjs';
import { authStatus, login, completeLogin, cancelLogin, refreshLogin, logout } from './auth.mjs';
import { searchFlights, flightDetails, airportSearch, selectFare } from './flights.mjs';
import { prepareCheckout, inspectCheckout, submitCheckoutForm } from './checkout.mjs';
import { updateCardPayment, prepareBooking, confirmBooking, inspectOperation } from './booking.mjs';

const text = { type: 'string' }, uuid = { type: 'string', format: 'uuid' };
const definitions = [
  ['capabilities', 'Report verified HTTP features and payment requirements. Starts no browser or Android process.', {}],
  ['login', 'Begin email-code login on Linux. Returns an official verification widget link for the user’s browser and acknowledges a code request once. Preserves any saved account until independent validation. Repeated calls reuse the pending login.', { email: text, replace: { type: 'boolean' } }],
  ['auth code', 'After browser verification completes, submit the current email code once. Validates the resulting session before saving it. Never replays an uncertain submission.', { 'login-id': uuid, code: text }, ['login-id', 'code']],
  ['auth cancel', 'Cancel a pending login and close its temporary verification link. Preserves the saved account.', { 'login-id': uuid }, ['login-id']],
  ['auth status', 'Inspect saved authentication and pending verification without exposing session tokens.', {}],
  ['auth refresh', 'Validate and refresh a saved Expedia session using HTTP.', {}],
  ['auth logout', 'Delete local account and pending-login credentials.', {}],
  ['flights search', 'Search live Expedia flight offers without booking. Offers have local IDs used for detail selection.', {
    origin: text, destination: text, depart: text, return: text, adults: { type: 'integer', minimum: 1, maximum: 9 },
    'children-ages': text, 'infants-in-lap': { type: 'integer', minimum: 0, maximum: 9 }, 'infants-in-seat': { type: 'integer', minimum: 0, maximum: 9 },
    cabin: { type: 'string', enum: ['ANY', 'COACH', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'] }, sort: text,
  }, ['origin', 'destination', 'depart']],
  ['flights details', 'Select an offer and optional fare index, or search the next round-trip leg. Defaults to the first returned fare when a leg selection is needed. Does not book.', { 'offer-id': uuid, 'fare-index': { type: 'integer', minimum: 0, maximum: 100 } }, ['offer-id']],
  ['flights fare', 'Choose a fare from current detail results and retrieve updated conditions and price. Does not book.', { 'detail-id': uuid, 'fare-index': { type: 'integer', minimum: 0, maximum: 100 } }, ['detail-id', 'fare-index']],
  ['airports search', 'Resolve airport and city names through Expedia typeahead.', { query: text }, ['query']],
  ['checkout prepare', 'Prepare the selected flight checkout and retrieve exact fare, rules and traveler/contact form fields. Does not book or charge.', { 'detail-id': uuid }, ['detail-id']],
  ['checkout inspect', 'Read a prepared checkout review and its required fields.', { 'checkout-id': uuid }, ['checkout-id']],
  ['checkout form', 'Validate and save traveler/contact form inputs through Expedia. Input file is a JSON array of inputId/value pairs; does not book.', { 'checkout-id': uuid, type: text, 'input-file': text }, ['checkout-id', 'type', 'input-file']],
  ['checkout pay', 'Set up a new card using Expedia’s returned tokenization service. Card file stays local; PAN/CVV are never saved to CLI state. Stops if issuer verification is required. Does not book.', { 'checkout-id': uuid, 'payment-option-id': text, 'card-file': text }, ['checkout-id', 'payment-option-id', 'card-file']],
  ['book', 'Prepare a complete flight purchase review. After the user approves its current fare, itinerary, travelers, payment and rules, confirm the returned plan once. Never replay an unknown result.', { 'checkout-id': uuid, 'plan-id': uuid, confirm: { type: 'boolean' } }],
  ['operation', 'Inspect a durable booking result. With --refresh, read pending order status without repeating the purchase. Ticket issuance remains distinct from an accepted order.', { 'operation-id': uuid, refresh: { type: 'boolean' } }, ['operation-id']],
];
export const toolDefinitions = definitions.map(([command, description, properties, required = []]) => ({ command, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } }));
function invalid(message) { throw new ExpediaError('INVALID_ARGUMENT', message); }
export async function main(argv) {
  const options = { pretty: { type: 'boolean' }, help: { type: 'boolean' } };
  for (const tool of toolDefinitions) for (const [key, field] of Object.entries(tool.inputSchema.properties)) options[key] = { type: field.type === 'boolean' ? 'boolean' : 'string' };
  let parsed;
  try { parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true, tokens: true }); }
  catch { invalid('Invalid or unknown argument. Run expedia tools.'); }
  const command = parsed.positionals.join(' '), raw = parsed.values;
  if (!command || command === 'tools' || raw.help) return { tools: toolDefinitions };
  const definition = toolDefinitions.find(t => t.command === command);
  if (!definition) invalid('Unknown command. Run expedia tools.');
  const seen = new Set(), values = {};
  for (const token of parsed.tokens.filter(t => t.kind === 'option')) { if (seen.has(token.name)) invalid(`Duplicate --${token.name}.`); seen.add(token.name); }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'pretty') continue;
    const field = definition.inputSchema.properties[key];
    if (!field) invalid(`--${key} is not accepted by ${command}.`);
    if (field.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) invalid(`Invalid --${key}.`);
    if (field.enum && !field.enum.includes(value)) invalid(`Invalid --${key}.`);
    if (field.type === 'integer') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < field.minimum || Number(value) > field.maximum) invalid(`Invalid --${key}.`);
      values[key] = Number(value);
    } else values[key] = value;
  }
  for (const key of definition.inputSchema.required) if (values[key] === undefined) invalid(`Provide --${key}.`);
  if (command === 'capabilities') return {
    runtime: { transport: 'node_http', browser: false, android: false, tunnel: false },
    flights: { search: 'live_verified', details: 'live_verified', fareSelection: 'live_verified', checkoutPreparation: 'live_verified', anonymous: true },
    authentication: { savedSessionRefresh: 'live_verified', freshLogin: 'live_verified_linux', method: 'email_code_and_user_browser_verification', userBrowser: true, temporaryVerificationTunnel: true, hostBrowser: false, androidRuntime: false },
    purchase: { implementation: 'source_reconstructed', liveVerified: false, requiresExplicitApproval: true, issuerChallenge: 'unsupported', ticketIssuance: 'unverified' },
  };
  if (command === 'login') return login({ email: values.email, replace: values.replace });
  if (command === 'auth code') return completeLogin({ loginId: values['login-id'], code: values.code });
  if (command === 'auth cancel') return cancelLogin({ loginId: values['login-id'] });
  if (command === 'auth status') return authStatus();
  if (command === 'auth refresh') return refreshLogin();
  if (command === 'auth logout') return logout();
  if (command === 'flights details') return flightDetails({ offerId: values['offer-id'], fareIndex: values['fare-index'] });
  if (command === 'flights fare') return selectFare({ detailId: values['detail-id'], fareIndex: values['fare-index'] });
  if (command === 'airports search') return airportSearch({ query: values.query });
  if (command === 'checkout prepare') return prepareCheckout({ detailId: values['detail-id'] });
  if (command === 'checkout inspect') return inspectCheckout({ checkoutId: values['checkout-id'] });
  if (command === 'checkout form') return submitCheckoutForm({ checkoutId: values['checkout-id'], type: values.type, inputFile: values['input-file'] });
  if (command === 'checkout pay') return updateCardPayment({ checkoutId: values['checkout-id'], paymentOptionId: values['payment-option-id'], cardFile: values['card-file'] });
  if (command === 'operation') return inspectOperation({ operationId: values['operation-id'], refresh: values.refresh === true });
  if (command === 'book') {
    if (values['plan-id']) {
      if (values['checkout-id'] || values.confirm !== true) invalid('Use book --plan-id ID --confirm after approving the review.');
      return confirmBooking({ planId: values['plan-id'], confirm: true });
    }
    if (!values['checkout-id'] || values.confirm !== undefined) invalid('First use book --checkout-id ID to prepare a review.');
    return prepareBooking({ checkoutId: values['checkout-id'] });
  }
  if (command === 'flights search') {
    let children = [];
    if (values['children-ages'] !== undefined) {
      if (!/^\d{1,2}(,\d{1,2})*$/.test(values['children-ages'])) invalid('--children-ages must be comma-separated ages.');
      children = values['children-ages'].split(',').map(Number);
    }
    return searchFlights({ origin: values.origin, destination: values.destination, departDate: values.depart, returnDate: values.return, adults: values.adults, children, infantsInLap: values['infants-in-lap'], infantsInSeat: values['infants-in-seat'], cabin: values.cabin, sortType: values.sort });
  }
}
try {
  const result = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, process.argv.includes('--pretty') ? 2 : undefined)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: { code: error instanceof ExpediaError ? error.code : 'LOCAL_ERROR', message: error instanceof ExpediaError ? error.message : 'A local operation failed. Check installation and private state file access.', ...(error instanceof ExpediaError ? error.details : {}) } })}\n`);
  process.exitCode = 1;
}
