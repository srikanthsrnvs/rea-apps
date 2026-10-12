import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { defaults, createContext, createLogin, parseCallback, sessionExchange, extractLoginSession, withExpiry, shoppingRequest } from './protocol.mjs';
import { readState, saveState, removeState, stateDirectory, withStateLock } from './state.mjs';
import { request as api, refresh, authenticatedRequest } from './client.mjs';
import { normalizeQuotes, legacyFareRequest } from './quotes.mjs';
import { toolManifest } from './tools.mjs';
import { searchRequest, normalizeSearch, resolveRequest, normalizeResolved } from './locations.mjs';

let values;
const print = value => console.log(JSON.stringify(value, null, 2));

async function context() {
  const existing = await readState('context');
  const value = existing ?? createContext();
  if (values['client-id']) value.firstPartyClientID = values['client-id'];
  await saveState('context', value);
  return value;
}

async function deviceData() {
  return values['device-data'] ? JSON.parse(await fs.readFile(values['device-data'], 'utf8')) : {};
}

async function exchange(callbackURL) {
  const pending = await readState('pending-login');
  if (!pending) throw new Error('No pending login. Run uber login or uber login-url first');
  if (Date.now() - Date.parse(pending.createdAt) > 15 * 60 * 1000) throw new Error('Pending login expired; start a new login');
  const callback = parseCallback(callbackURL, pending.callback);
  const config = pending.context;
  if (!config) throw new Error('Pending login has no context; start a new login');
  const body = sessionExchange(config, pending, callback, await deviceData());
  const response = await api(config, '/rt/silk-screen/submit-form', body);
  const oauth = extractLoginSession(response);
  if (!oauth) throw new Error('Response contains no recognized OAuth access token; inspect the private last-response.json');
  await saveState('session', withExpiry({ ...oauth, context: config }));
  await removeState('pending-login');
  await removeState('integrity');
  print({ loggedIn: true, refreshTokenAvailable: Boolean(oauth.refreshToken) });
}

async function login() {
  const pending = createLogin(await context(), values['callback-url'] ?? defaults.callback);
  await saveState('pending-login', pending);
  print({ url: pending.url, expiresInMinutes: 15,
    next: 'Open this URL in a browser, sign in, then copy its final URL (even if the page says not found) and run: uber auth complete --callback-url URL',
    status: 'waiting_for_login' });
}

try {
  const parsed = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' },
    'callback-url': { type: 'string' },
    'client-id': { type: 'string' },
    'device-data': { type: 'string' },
    request: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    via: { type: 'string', multiple: true },
    'dry-run': { type: 'boolean' },
    raw: { type: 'boolean' },
  query: { type: 'string' },
  near: { type: 'string' },
  context: { type: 'string' },
  id: { type: 'string' },
  provider: { type: 'string' },
  } });
  values = parsed.values;
  const command = parsed.positionals.join(' ') || 'help';
  
  if (values.help || command === 'help') {
    console.log(`Standalone Uber CLI — browser approval once, then headless HTTP access.

uber tools                         Print tool definitions for models
uber login                         Generate a browser approval URL; works over SSH
uber auth complete --callback-url URL  Exchange the completed browser URL
uber auth status                   Report local session state without printing tokens
uber auth refresh                  Exchange the stored refresh token
uber auth logout                   Delete local credentials and private responses
uber resolve --id ID --provider PROVIDER  Resolve a place to coordinates
uber search --query TEXT --near LAT,LON  Find places by name or address
uber status                        Query current account trip state
uber products --from LAT,LON --to LAT,LON  List current ride products
uber quote --from LAT,LON --to LAT,LON     Get current ride products and fare estimates
uber quote --from LAT,LON --to LAT,LON --dry-run  Inspect the request without sending it
uber shopping --request request.json  Send a modern order-selection request

Optional flags: --raw, --device-data FILE, --callback-url URL, --via LAT,LON
State: ${stateDirectory}`);
  } else if (command === 'tools') print(toolManifest);
  else if (command === 'login') await login();
  else if (command === 'login-url') await login();
  else if (command === 'auth complete') {
    let callbackURL = values['callback-url'];
    if (!callbackURL) {
      if (!process.stdin.isTTY) throw new Error('--callback-url is required outside an interactive terminal');
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try { callbackURL = await prompt.question('Completed browser URL: '); } finally { prompt.close(); }
    }
    await withStateLock(() => exchange(callbackURL.trim()));
  } else if (command === 'auth status') {
    const session = await readState('session');
    const integrity = await readState('integrity');
    print({ loggedIn: Boolean(session?.accessToken), accessTokenExpired: Boolean(session?.expiresAt && session.expiresAt <= Date.now()), refreshTokenAvailable: Boolean(session?.refreshToken), receivedAt: session?.receivedAt ?? null, expiresAt: session?.expiresAt ?? null, integrityExpiresAt: integrity?.expiresAt ?? null });
  } else if (command === 'auth refresh') {
    await refresh(await readState('session'));
    print({ refreshed: true });
  } else if (command === 'auth logout') {
    await withStateLock(async () => {
      for (const name of (await fs.readdir(stateDirectory)).filter(name => name.endsWith('.json') && name !== 'context.json')) await removeState(name.slice(0, -5));
    });
    print({loggedOut:true});
  } else if (command === 'search') {
    const body = searchRequest(values.query, values.near, values.context);
    if (values['dry-run']) print({endpoint:'/rt/pudo-presentation-helix/text-search',body:{request:body}});
    else {
      const response = await authenticatedRequest('/rt/pudo-presentation-helix/text-search', {request:body});
      print(values.raw ? response : normalizeSearch(response.rows));
    }
  } else if (command === 'resolve') {
    const body = resolveRequest(values.id, values.provider, values.context);
    if (values['dry-run']) print({endpoint:'/rt/riders/me/resolve-location',body});
    else {
      const response = await authenticatedRequest('/rt/riders/me/resolve-location', body);
      print(values.raw ? response : normalizeResolved(response));
    }
  } else if (command === 'status') {
    const response = await authenticatedRequest('/rt/riders/me/status', {});
    if (!response.clientStatus || !Array.isArray(response.fulfillmentStateData?.orders)) throw new Error('Unrecognized trip status response');
    print(values.raw ? response : {clientStatus: response.clientStatus, activeOrderCount: response.fulfillmentStateData.orders.length, orders: response.fulfillmentStateData.orders, pollingIntervalMs: response.metadata?.pollingIntervalMs ?? null});
  } else if (['products', 'quote', 'shopping'].includes(command)) {
    let body;
    if (values.request) {
      body = JSON.parse(await fs.readFile(values.request, 'utf8'));
      if (body.request) body = body.request;
    } else if (['products', 'quote'].includes(command) && values.from && values.to) {
      body = shoppingRequest(values.from, values.to, values.via);
    } else throw new Error('Supply --from LAT,LON --to LAT,LON or --request JSONFILE');
    const endpoint = '/rt/shopping-service/order_selection/';
    const wrapped = { request: body };
    if (values['dry-run']) print({ endpoint, body: wrapped });
    else {
      const response = await authenticatedRequest(endpoint, wrapped);
      if (command === 'quote') {
        const pointString = point => `${point?.latitude},${point?.longitude}`;
        const pickup = pointString(body.pickupWaypoint?.locationSpec?.point);
        const waypoints = body.waypointSpecs ?? [];
        const destination = pointString(waypoints.at(-1)?.locationSpec?.point);
        const via = waypoints.slice(0, -1).map(waypoint => pointString(waypoint.locationSpec?.point));
        const orders = response.response?.fullResponse?.shoppingOrders;
        if (!Array.isArray(orders)) throw new Error('Shopping response has no product catalog');
        const ids = [...new Set(orders.map(order => order.jobs?.singleTransport?.transportJob?.productContext?.legacy?.vehicleViewID).filter(Number.isSafeInteger))];
        if (!ids.length) throw new Error('Shopping response has no vehicle view IDs for pricing');
        const fareRequest = legacyFareRequest(pickup, destination, via, ids);
        const fares = await authenticatedRequest('/rt/riders/me/fare-estimate', fareRequest);
        print(values.raw ? {shopping:response, fares} : normalizeQuotes(response, fares));
      } else print(values.raw || command === 'shopping' ? response : normalizeQuotes(response));
    }
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(JSON.stringify({error:{message:error.message,code:error.code ?? 'cli_error',...(error.status ? {status:error.status} : {})}}));
  process.exitCode = 1;
}
