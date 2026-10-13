import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { OpenTableError } from './errors.mjs';
import { OpenTableClient, acquireAnonymous } from './http.mjs';
import { readState, saveState, withStateLock } from './state.mjs';
import { startLogin, completeLogin, refreshLogin, authStatus, cancelLogin, logout, accountFromUser } from './auth.mjs';

const uuid = { type: 'string', format: 'uuid' };
const restaurantId = { type: 'string', pattern: '^\\d{1,30}$' };
const dateTime = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$', description: 'Explicit restaurant-local date and time, without UTC conversion.' };
const partySize = { type: 'integer', minimum: 1, maximum: 20, default: 2 };
const definitions = [
  ['login', 'Request an OpenTable SMS or email verification code. Supply exactly one phone or email; a repeated pending login does not resend.', {
    phone: { type: 'string', minLength: 7, maxLength: 30 }, email: { type: 'string', maxLength: 254 },
    'country-code': { type: 'string', pattern: '^\\d{1,3}$', default: '1' }, 'country-id': { type: 'string', pattern: '^[A-Z]{2}$', default: 'US' },
  }],
  ['auth complete', 'Confirm the received verification code and save a validated session. Does not create an account or recycle a phone number.', {
    code: { type: 'string', pattern: '^\\d{4,10}$' },
  }, ['code']],
  ['auth status', 'Read local session state without exposing tokens or full login contact details.', {}],
  ['auth refresh', 'Refresh a saved session, or validate an already exchanged candidate without repeating verification.', {}],
  ['auth cancel', 'Discard pending login and candidate credentials while preserving a validated session.', {}],
  ['auth logout', 'Remove local authentication credentials.', {}],
  ['me', 'Validate the signed-in account and list its available diner profiles.', {}],
  ['search', 'Search restaurants near coordinates at a local date/time, with available tables and pagination.', {
    query: { type: 'string', maxLength: 500 }, near: { type: 'string', description: 'Latitude,longitude.' },
    'date-time': dateTime, 'party-size': partySize,
    page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  }, ['query', 'near', 'date-time']],
  ['restaurant', 'Read a restaurant and its metadata.', { 'restaurant-id': restaurantId }, ['restaurant-id']],
  ['availability', 'List restaurant table options. slotId is a private local reference used for booking; search again after changing or refreshing the session.', {
    'restaurant-id': restaurantId, 'date-time': dateTime, 'party-size': partySize,
  }, ['restaurant-id', 'date-time']],
  ['payments', 'List saved wallet card IDs and masked metadata; excludes reusable payment tokens.', {}],
  ['reservations', 'Read your reservations; follow available history pages using page.', { page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 } }],
  ['book', 'Prepare a venue-bound table review without booking. After user approval, --plan-id ID --confirm checks and holds the table. If status is review_required, show nextPlan.review, obtain approval of those terms and confirm nextPlan.planId. Otherwise submits once. Supports ordinary cardless tables and compatible saved-card guarantees.', {
    'restaurant-id': restaurantId, 'slot-id': uuid, 'diner-id': { type: 'string', maxLength: 200 },
    'payment-method-id': { type: 'string', maxLength: 200 }, 'plan-id': uuid, confirm: { type: 'boolean' },
  }],
  ['cancel', 'Prepare cancellation terms for a reservation reference. Show the review and obtain user approval before --plan-id ID --confirm. A card guarantee may have an unknown fee: obtain explicit approval of that risk before --accept-unknown-fee.', {
    'reservation-id': uuid, 'plan-id': uuid, confirm: { type: 'boolean' },
    'accept-unknown-fee': { type: 'boolean', description: 'Only after the user explicitly approves the reviewed possible cancellation fee when its amount is unknown.' },
  }],
  ['operation', 'Inspect a durable booking or cancellation outcome; do not replay an uncertain submission.', { 'operation-id': uuid }, ['operation-id']],
];
const tools = definitions.map(([command, description, properties, required = []]) => ({ command, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false } }));
tools.find(tool => tool.command === 'login').inputSchema.oneOf = [
  { required: ['phone'], not: { required: ['email'] } }, { required: ['email'], not: { required: ['phone'] } },
];
for (const command of ['book', 'cancel']) {
  const schema = tools.find(tool => tool.command === command).inputSchema;
  const fields = Object.keys(schema.properties).filter(name => !['plan-id', 'confirm', 'accept-unknown-fee'].includes(name));
  schema.oneOf = [
    { required: command === 'book' ? ['restaurant-id', 'slot-id'] : ['reservation-id'], not: { anyOf: [{ required: ['plan-id'] }, { required: ['confirm'], properties: { confirm: { const: true } } }, ...(command === 'cancel' ? [{ required: ['accept-unknown-fee'] }] : [])] } },
    { required: ['plan-id', 'confirm'], properties: { confirm: { const: true } }, not: { anyOf: fields.map(name => ({ required: [name] })) } },
  ];
}
function invalid(message) { throw new OpenTableError('INVALID_ARGUMENT', message); }
function coordinates(value) {
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+),-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) invalid('--near must be latitude,longitude.');
  const [lat, lon] = value.split(',').map(Number);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) invalid('Coordinates are out of range.');
  return { lat, lon };
}
async function client(requireUser = false) {
  return withStateLock(async () => {
    const session = await readState('session');
    if (session?.accessToken && session?.account && session.expiresAt > Date.now()) return new OpenTableClient({ token: session.accessToken, sessionId: session.sessionId });
    if (requireUser) throw new OpenTableError('LOGIN_REQUIRED', 'Request and confirm an OpenTable verification code, or run auth refresh.');
    let context = await readState('context');
    if (!context) { context = { sessionId: randomUUID() }; await saveState('context', context); }
    let guest = await readState('guest');
    if (!guest?.accessToken || guest.expiresAt <= Date.now() + 30000) { guest = await acquireAnonymous({ sessionId: context.sessionId }); await saveState('guest', guest); }
    return new OpenTableClient({ token: guest.accessToken, sessionId: context.sessionId });
  });
}
async function main(args) {
  const options = { pretty: { type: 'boolean' }, help: { type: 'boolean' } };
  for (const tool of tools) for (const [name, field] of Object.entries(tool.inputSchema.properties)) options[name] = { type: field.type === 'boolean' ? 'boolean' : 'string' };
  let parsed;
  try { parsed = parseArgs({ args, options, allowPositionals: true, tokens: true }); } catch { invalid('Invalid or unknown option. Run opentable tools.'); }
  const raw = parsed.values, command = parsed.positionals.join(' '), seen = new Set();
  for (const token of parsed.tokens.filter(item => item.kind === 'option')) { if (seen.has(token.name)) invalid(`Duplicate --${token.name}.`); seen.add(token.name); }
  if (raw.help || !command || command === 'tools') return { tools };
  const definition = tools.find(tool => tool.command === command);
  if (!definition) invalid('Unknown command. Run opentable tools.');
  const values = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name === 'pretty') continue;
    const field = definition.inputSchema.properties[name];
    if (!field) invalid(`--${name} is not valid for ${command}.`);
    let normalized = value;
    if (field.type === 'integer') {
      if (!/^\d+$/.test(value)) invalid(`--${name} must be an integer.`);
      normalized = Number(value);
      if (!Number.isSafeInteger(normalized) || normalized < field.minimum || normalized > field.maximum) invalid(`Invalid --${name} range.`);
    }
    if (field.pattern && !new RegExp(field.pattern).test(value)) invalid(`Invalid --${name}.`);
    if (name === 'date-time') {
      const check = new Date(`${value}:00Z`);
      if (!Number.isFinite(check.getTime()) || check.toISOString().slice(0, 16) !== value) invalid('Provide a valid restaurant-local date and time.');
    }
    if (field.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) invalid(`Invalid --${name}.`);
    if (field.minLength !== undefined && value.length < field.minLength || field.maxLength !== undefined && value.length > field.maxLength) invalid(`Invalid --${name} length.`);
    values[name] = normalized;
  }
  for (const name of definition.inputSchema.required) if (values[name] === undefined) invalid(`Provide --${name}.`);
  if (['book', 'cancel'].includes(command)) {
    if (values['plan-id']) {
      if (!values.confirm || Object.keys(values).some(name => !['plan-id', 'confirm', ...(command === 'cancel' ? ['accept-unknown-fee'] : [])].includes(name))) invalid('Use --plan-id ID --confirm for a reviewed plan.');
    } else {
      if (values.confirm || values['accept-unknown-fee'] !== undefined) invalid('Prepare and review a plan before confirming.');
      for (const name of command === 'book' ? ['restaurant-id', 'slot-id'] : ['reservation-id']) if (!values[name]) invalid(`Provide --${name}.`);
    }
  }
  if (command === 'login') return startLogin({ phone: values.phone, email: values.email, countryCode: values['country-code'], countryId: values['country-id'] });
  if (command === 'auth complete') return completeLogin({ code: values.code });
  if (command === 'auth status') return authStatus();
  if (command === 'auth refresh') return refreshLogin();
  if (command === 'auth cancel') return cancelLogin();
  if (command === 'auth logout') return logout();
  const location = command === 'search' ? coordinates(values.near) : {};
  const api = await client(['me', 'payments', 'reservations', 'book', 'cancel', 'operation'].includes(command));
  if (command === 'me') return accountFromUser(await api.me());
  const reads = await import('./reservations.mjs');
  if (command === 'payments') return reads.payments(api);
  if (command === 'search') return reads.search(api, { query: values.query, ...location, dateTime: values['date-time'], partySize: values['party-size'], page: values.page, limit: values.limit });
  if (command === 'restaurant') return reads.restaurant(api, { restaurantId: values['restaurant-id'] });
  if (command === 'availability') return reads.availability(api, { restaurantId: values['restaurant-id'], dateTime: values['date-time'], partySize: values['party-size'] });
  if (command === 'reservations') return reads.reservations(api, { page: values.page });
  if (command === 'book') return values['plan-id'] ? reads.confirmBooking(api, { planId: values['plan-id'] }) : reads.prepareBooking(api, {
    restaurantId: values['restaurant-id'], slotCursor: values['slot-id'], dinerId: values['diner-id'], paymentMethodId: values['payment-method-id'] });
  if (command === 'cancel') return values['plan-id'] ? reads.confirmCancellation(api, { planId: values['plan-id'], acceptUnknownFee: values['accept-unknown-fee'] ?? false }) : reads.prepareCancellation(api, { reservationId: values['reservation-id'] });
  if (command === 'operation') return reads.inspectOperation({ operationId: values['operation-id'], client: api });
}
try {
  const value = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(value, null, process.argv.includes('--pretty') ? 2 : undefined)}\n`);
} catch (error) {
  const known = error instanceof OpenTableError;
  process.stderr.write(`${JSON.stringify({ error: { code: known ? error.code : 'LOCAL_ERROR', message: known ? error.message : 'A local operation failed. Check file access and installation.', ...(known ? error.details : {}) } })}\n`);
  process.exitCode = 1;
}
