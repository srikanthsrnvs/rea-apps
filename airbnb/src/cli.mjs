import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { toolDefinitions } from './tool-definitions.mjs';
import { AirbnbError } from './errors.mjs';
import * as auth from './auth.mjs';
import { createClient } from './client.mjs';
import { buildAutocomplete, buildListingDetails, buildCalendar, normalizeAutocomplete, normalizeListing, normalizeCalendar } from './search-protocol.mjs';
import { searchStays } from './search.mjs';
import { buildAccount, parseAccount, buildWishlists, buildWishlistDetails, parseWishlistsPage, buildTrips, parseTripsPage, buildInbox, buildInboxSearch, parseInboxPage } from './account-protocol.mjs';
import { prepareBooking, confirmBooking, bookingStatus } from './booking.mjs';
import { prepareCancellation, confirmCancellation, cancellationStatus } from './cancellation.mjs';

function parse(argv) {
  const options = { pretty: { type: 'boolean' }, help: { type: 'boolean' } };
  for (const definition of toolDefinitions) for (const [name, type] of Object.entries(definition.inputSchema.properties)) options[name] = { type: type.type };
  let parsed;
  try { parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true, tokens: true }); }
  catch { throw new AirbnbError('INVALID_ARGUMENT', 'Invalid arguments. Run airbnb tools.'); }
  const command = parsed.positionals.join(' '), o = parsed.values;
  if (!command || ['help', 'tools'].includes(command) || o.help) return { command: 'tools', o };
  const definition = toolDefinitions.find(tool => tool.command === command);
  if (!definition) throw new AirbnbError('UNKNOWN_COMMAND', 'Unknown command. Run airbnb tools.');
  const seen = new Set();
  for (const token of parsed.tokens.filter(token => token.kind === 'option')) {
    if (seen.has(token.name)) throw new AirbnbError('INVALID_ARGUMENT', 'Duplicate option.');
    seen.add(token.name);
    if (token.name !== 'pretty' && !Object.hasOwn(definition.inputSchema.properties, token.name)) throw new AirbnbError('INVALID_ARGUMENT', `--${token.name} is not accepted by this command.`);
  }
  for (const key of definition.inputSchema.required) if (o[key] === undefined) throw new AirbnbError('INVALID_ARGUMENT', `Provide --${key}.`);
  return { command, o };
}
const number = value => value === undefined ? undefined : Number(value);
const dates = o => ({ checkin: o.checkin, checkout: o.checkout, adults: number(o.adults), children: number(o.children), infants: number(o.infants), pets: number(o.pets) });
function compact(result, raw) { if (!raw && result && typeof result === 'object') { if (result.summary) return result.summary; const { raw: _, ...rest } = result; return rest; } return result; }

export async function dispatch(argv) {
  const { command, o } = parse(argv);
  if (command === 'tools') return { tools: toolDefinitions };
  if (command === 'login') {
    let result = await auth.login({ email: o.email, phone: o.phone, countryCode: o.phone ? o.country ?? 'US' : o.country, replace: o.replace });
    if (o.phone && result.status === 'code_required' && result.method === 'sms' && !result.codeDispatch) {
      result = await auth.requestPhoneCode({ loginId: result.loginId, initial: true });
    }
    if (result.verification?.phase === 'waiting' && result.verification.status === 'not_started') {
      result = await auth.startAuthVerification({ loginId: result.loginId });
    }
    return result;
  }
  if (command === 'auth status') return auth.authStatus();
  if (command === 'auth verification start') return auth.startAuthVerification({ loginId: o['login-id'] });
  if (command === 'auth verification resume') return auth.resumeAuthVerification({ loginId: o['login-id'] });
  if (command === 'auth request-sms') return auth.requestPhoneCode({ loginId: o['login-id'] });
  if (command === 'auth cancel') return auth.cancelLogin({ loginId: o['login-id'] });
  if (command === 'auth validate') return auth.authStep({ loginId: o['login-id'] });
  if (command === 'logout') return auth.logout();
  if (command === 'auth resend') return auth.authStep({ loginId: o['login-id'], method: o.method, resend: true });
  if (command === 'auth verify') {
    if ((o.code !== undefined) === (o['code-file'] !== undefined)) throw new AirbnbError('INVALID_ARGUMENT', 'Provide exactly one of --code or --code-file.');
    let code = o.code;
    if (o['code-file']) {
      if ((await fs.stat(o['code-file'])).size > 100) throw new AirbnbError('INVALID_ARGUMENT', 'The code file is too large.');
      code = (await fs.readFile(o['code-file'], 'utf8')).trim();
    }
    return auth.authStep({ loginId: o['login-id'], code });
  }
  if (command === 'booking preview') return prepareBooking({ listingId: o['listing-id'], ...dates(o), currency: o.currency, raw: o.raw });
  if (command === 'booking confirm') return confirmBooking({ reviewId: o['review-id'], paymentOption: o['payment-option'], maxTotal: o['max-total'], currency: o.currency, acceptTerms: o['accept-terms'], messageToHost: o['message-to-host'], confirm: o.confirm });
  if (command === 'booking status') return bookingStatus({ reviewId: o['review-id'], lookup: o.lookup });
  if (command === 'cancellation preview') return prepareCancellation({ confirmationCode: o['confirmation-code'], reasonId: o['reason-id'], raw: o.raw });
  if (command === 'cancellation confirm') return confirmCancellation({ reviewId: o['review-id'], acceptTerms: o['accept-terms'], confirm: o.confirm });
  if (command === 'cancellation status') return cancellationStatus({ reviewId: o['review-id'] });
  // Build and validate the request before accessing saved state or making a call.
  let spec, normalize = x => ({ data: x.data ?? x });
  let anonymous = false;
  switch (command) {
    case 'account': spec = buildAccount(); normalize = parseAccount; break;
    case 'places search': spec = buildAutocomplete({ query: o.query, country: o.country ?? 'US', limit: o.limit }); normalize = normalizeAutocomplete; anonymous = true; break;
    case 'stays search':
      return compact(await searchStays({ ...dates(o), query: o.query, placeId: o['place-id'], cursor: o.cursor, limit: o.limit, minPrice: o['min-price'], maxPrice: o['max-price'], currency: o.currency }, await createClient({ optionalAuth: true })), o.raw);
    case 'listing get': spec = buildListingDetails({ listingId: o['listing-id'], ...dates(o) }); normalize = normalizeListing; anonymous = true; break;
    case 'listing calendar': spec = buildCalendar({ listingId: o['listing-id'], month: o.month, year: o.year, count: o.count }); normalize = normalizeCalendar; anonymous = true; break;
    case 'wishlists list': spec = buildWishlists({ offset: number(o.offset) }); normalize = parseWishlistsPage; break;
    case 'wishlist get': spec = buildWishlistDetails({ wishlistId: o['wishlist-id'] }); break;
    case 'trips list': spec = buildTrips({ first: number(o.limit) ?? 9, after: o.cursor }); normalize = parseTripsPage; break;
    case 'inbox list': spec = buildInbox({ pageSize: number(o['page-size']) ?? 20, cursor: o.cursor }); normalize = parseInboxPage; break;
    case 'inbox search': spec = buildInboxSearch({ query: o.query, cursor: o.cursor }); normalize = x => parseInboxPage(x, { mode: 'search' }); break;
    default: throw new AirbnbError('UNKNOWN_COMMAND', 'Unknown command. Run airbnb tools.');
  }
  const client = await createClient({ optionalAuth: anonymous });
  return compact(normalize(await client.request(spec)), o.raw);
}

export async function run(argv = process.argv.slice(2)) {
  try { console.log(JSON.stringify(await dispatch(argv), null, argv.includes('--pretty') ? 2 : undefined)); }
  catch (error) {
    const known = typeof error.code === 'string' && /^[A-Z][A-Z_]+$/.test(error.code);
    const invalid = error instanceof TypeError;
    console.error(JSON.stringify({ error: { code: known ? error.code : invalid ? 'INVALID_ARGUMENT' : 'INTERNAL_ERROR',
      message: known || invalid ? error.message : 'The command could not complete.', ...(error.details ? { details: error.details } : {}) } }));
    process.exitCode = 1;
  }
}
