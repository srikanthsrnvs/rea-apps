import { parseArgs } from 'node:util';
import { ResyError } from './errors.mjs';
import { ResyClient } from './http.mjs';
import { readState, withStateLock } from './state.mjs';
import { startLogin, pollLogin, waitLogin, cancelLogin, authStatus, logout } from './auth.mjs';
import { search, venue, availability, calendar, reservations, payments, details,
  prepareBooking, confirmBooking, prepareCancellation, confirmCancellation, inspectOperation } from './reservations.mjs';

const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Service date in the restaurant’s local timezone.' };
const id = { type: 'string', pattern: '^\\d{1,30}$' };
const uuid = { type: 'string', format: 'uuid' };
const opaque = { type: 'string', minLength: 1, maxLength: 16384 };
const party = { type: 'integer', minimum: 1, maximum: 100, default: 2 };
const near = { type: 'string', description: 'Latitude,longitude; both required for restaurant search.' };
const table = { 'slot-token': opaque, date, 'party-size': party };
const definitions = [
  ['login', 'Return a temporary HTTPS login link. The user signs in inside Resy’s official widget in their own browser; the headless host receives the session.', {
    timeout: { type: 'integer', minimum: 30, maximum: 3600, default: 600 }, replace: { type: 'boolean' },
    'public-url': { type: 'string', format: 'uri', description: 'Optional HTTPS reverse-proxy origin; requires fixed --port. Default uses a temporary Cloudflare tunnel.' },
    port: { type: 'integer', minimum: 0, maximum: 65535, default: 0 }, 'cloudflared-path': { type: 'string' },
  }],
  ['auth poll', 'Inspect the pending login without exposing session tokens.', {}],
  ['auth wait', 'Wait for browser login while allowing other commands to inspect state.', { timeout: { type: 'integer', minimum: 1, maximum: 3600, default: 600 } }],
  ['auth cancel', 'Close pending login and its relay while preserving an existing session.', {}],
  ['auth status', 'Inspect local login/session timestamps. Use me to validate with Resy.', {}],
  ['auth logout', 'Remove the local session and close a pending login.', {}],
  ['me', 'Validate the session and read the signed-in account.', {}],
  ['search', 'Search restaurants near coordinates, with available table options for a local date. Follow nextPage with --page.', {
    query: { type: 'string', maxLength: 500 }, near, date, 'party-size': party,
    page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  }, ['query', 'near', 'date']],
  ['venue', 'Read restaurant location, cuisine and metadata.', { 'venue-id': id }, ['venue-id']],
  ['availability', 'List tables and seating options for a restaurant, date and party size. Returned slot tokens can be reviewed with details or book.', {
    'venue-id': id, date, 'party-size': party, near,
  }, ['venue-id', 'date']],
  ['calendar', 'Read availability by day across a restaurant’s calendar.', {
    'venue-id': id, 'start-date': date, 'end-date': date, 'party-size': party,
  }, ['venue-id', 'start-date', 'end-date']],
  ['details', 'Read a table’s current pricing and policies without committing a reservation. Include venue-id to validate its restaurant and seating option.', { ...table, 'venue-id': id }, ['slot-token', 'date']],
  ['payments', 'List saved payment method IDs and masked display information.', {}],
  ['reservations', 'List account reservations. offset is the service’s 1-based reservation page; inspect returned metadata before continuing.', {
    type: { type: 'string', enum: ['upcoming', 'past', 'all'], default: 'upcoming' },
    offset: { type: 'integer', minimum: 1, maximum: 10000, default: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
  }],
  ['book', 'Without --confirm, prepare a plan showing restaurant, date, table, current price, payment method and cancellation policy. After user approval, --plan-id ID --confirm books once. Show the entire review before confirming.', {
    ...table, 'venue-id': id, 'payment-method-id': id, 'plan-id': uuid, confirm: { type: 'boolean' },
  }],
  ['cancel', 'Without --confirm, preview an existing reservation’s cancellation terms. After user approval, --plan-id ID --confirm cancels once. Show the entire review before confirming.', {
    'reservation-token': opaque, 'plan-id': uuid, confirm: { type: 'boolean' },
  }],
  ['operation', 'Inspect the saved outcome of a booking/cancellation attempt. An uncertain outcome must be reconciled against reservations before starting another attempt.', {
    'operation-id': uuid,
  }, ['operation-id']],
];

export const toolManifest = definitions.map(([command, description, properties, required = []]) => ({
  command, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
}));
for (const command of ['book', 'cancel']) {
  const schema = toolManifest.find(tool => tool.command === command).inputSchema;
  const preparation = command === 'book' ? ['slot-token', 'date', 'venue-id'] : ['reservation-token'];
  const preparationFields = Object.keys(schema.properties).filter(name => !['plan-id', 'confirm'].includes(name));
  schema.oneOf = [
    { required: preparation, not: { anyOf: [{ required: ['plan-id'] }, { properties: { confirm: { const: true } }, required: ['confirm'] }] } },
    { required: ['plan-id', 'confirm'], properties: { confirm: { const: true } }, not: { anyOf: preparationFields.map(name => ({ required: [name] })) } },
  ];
}

function invalid(message) { throw new ResyError('INVALID_ARGUMENT', message); }
function coordinates(value) {
  if (value === undefined) return {};
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+),-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) invalid('--near must be latitude,longitude.');
  const [lat, lon] = value.split(',').map(Number);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) invalid('--near contains out-of-range coordinates.');
  return { lat, lon };
}
function projectUser(user) {
  return { id: user.id, firstName: typeof user.first_name === 'string' ? user.first_name : null,
    lastName: typeof user.last_name === 'string' ? user.last_name : null,
    email: typeof user.em_address === 'string' ? user.em_address : null,
    phone: typeof user.mobile_number === 'string' ? user.mobile_number : null };
}

async function main(args) {
  const options = { pretty: { type: 'boolean' }, help: { type: 'boolean' } };
  for (const definition of toolManifest) for (const [name, field] of Object.entries(definition.inputSchema.properties)) {
    options[name] = { type: field.type === 'boolean' ? 'boolean' : 'string' };
  }
  let parsed;
  try { parsed = parseArgs({ args, options, tokens: true, allowPositionals: true }); }
  catch { invalid('Invalid or unknown option. Run resy tools.'); }
  const command = parsed.positionals.join(' ');
  const raw = parsed.values;
  const seen = new Set();
  for (const token of parsed.tokens.filter(item => item.kind === 'option')) {
    if (seen.has(token.name)) invalid(`Duplicate --${token.name}.`);
    seen.add(token.name);
  }
  if (raw.help || !command || command === 'tools') return { tools: toolManifest };
  const definition = toolManifest.find(tool => tool.command === command);
  if (!definition) invalid('Unknown command. Run resy tools.');
  const values = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name === 'pretty') continue;
    const field = definition.inputSchema.properties[name];
    if (!field) invalid(`--${name} is not valid for ${command}.`);
    let normalized = value;
    if (field.type === 'integer') {
      if (!/^\d+$/.test(value)) invalid(`--${name} must be an integer.`);
      normalized = Number(value);
      if (!Number.isSafeInteger(normalized) || normalized < field.minimum || normalized > field.maximum) invalid(`--${name} must be ${field.minimum}–${field.maximum}.`);
    }
    if (field.pattern && !new RegExp(field.pattern).test(value)) invalid(`Invalid --${name}.`);
    if (field.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) invalid(`Invalid --${name}.`);
    if (field.enum && !field.enum.includes(value)) invalid(`Invalid --${name}.`);
    if (field.minLength !== undefined && value.length < field.minLength || field.maxLength !== undefined && value.length > field.maxLength) invalid(`Invalid --${name} length.`);
    values[name] = normalized;
  }
  for (const name of definition.inputSchema.required) if (values[name] === undefined) invalid(`Provide --${name}.`);
  if (['book', 'cancel'].includes(command)) {
    if (values['plan-id']) {
      if (!values.confirm) invalid('Confirm a reviewed plan using --plan-id ID --confirm.');
      if (Object.keys(values).some(name => !['plan-id', 'confirm'].includes(name))) invalid('A reviewed plan cannot be changed. Prepare a new plan.');
    } else {
      if (values.confirm) invalid('Prepare and review a plan before confirming its ID.');
      for (const name of command === 'book' ? ['slot-token', 'date', 'venue-id'] : ['reservation-token']) {
        if (values[name] === undefined) invalid(`Provide --${name} to prepare a plan.`);
      }
    }
  }
  const location = coordinates(values.near);
  if (command === 'login') return startLogin({ timeoutSeconds: values.timeout, replace: values.replace,
    publicUrl: values['public-url'], port: values.port, cloudflaredPath: values['cloudflared-path'] });
  if (command === 'auth poll') return pollLogin();
  if (command === 'auth wait') return waitLogin({ timeoutSeconds: values.timeout });
  if (command === 'auth cancel') return cancelLogin();
  if (command === 'auth status') return authStatus();
  if (command === 'auth logout') return logout();
  const session = await withStateLock(() => readState('session'));
  const client = new ResyClient({ token: session?.token });
  if (command === 'me') return projectUser(await client.me());
  if (command === 'search') return search(client, { query: values.query, ...location, day: values.date,
    partySize: values['party-size'], page: values.page, limit: values.limit });
  if (command === 'venue') return venue(client, { venueId: values['venue-id'] });
  if (command === 'availability') return availability(client, { venueId: values['venue-id'], day: values.date, partySize: values['party-size'], ...location });
  if (command === 'calendar') return calendar(client, { venueId: values['venue-id'], startDate: values['start-date'], endDate: values['end-date'], partySize: values['party-size'] });
  if (command === 'details') return details(client, { slotToken: values['slot-token'], day: values.date, partySize: values['party-size'], venueId: values['venue-id'] });
  if (command === 'payments') return payments(client);
  if (command === 'reservations') return reservations(client, { type: values.type, offset: values.offset, limit: values.limit });
  if (command === 'book') return values['plan-id'] ? confirmBooking(client, { planId: values['plan-id'] })
    : prepareBooking(client, { slotToken: values['slot-token'], day: values.date, partySize: values['party-size'], paymentMethodId: values['payment-method-id'], venueId: values['venue-id'] });
  if (command === 'cancel') return values['plan-id'] ? confirmCancellation(client, { planId: values['plan-id'] })
    : prepareCancellation(client, { reservationToken: values['reservation-token'] });
  if (command === 'operation') return inspectOperation({ operationId: values['operation-id'], client });
}

try {
  const result = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, process.argv.includes('--pretty') ? 2 : undefined)}\n`);
} catch (error) {
  const known = error instanceof ResyError;
  process.stderr.write(`${JSON.stringify({ error: { code: known ? error.code : 'LOCAL_ERROR',
    message: known ? error.message : 'A local operation failed. Check file access and installation.', ...(known ? error.details : {}) } })}\n`);
  process.exitCode = 1;
}
