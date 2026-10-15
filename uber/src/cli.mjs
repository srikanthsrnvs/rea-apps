import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { parseCallback, sessionExchange, extractLoginSession, withExpiry, shoppingRequest } from './protocol.mjs';
import { readState, saveState, removeState, stateDirectory, withStateLock } from './state.mjs';
import { request as api, refresh, authenticatedRequest } from './client.mjs';
import { normalizeQuotes, legacyFareRequest } from './quotes.mjs';
import { toolManifest } from './tools.mjs';
import { searchRequest, normalizeSearch, resolveRequest, normalizeResolved } from './locations.mjs';
import { prepareCancellation,confirmCancellation } from './cancellation.mjs';
import { inspectOperation } from './mutations.mjs';
import { requireUUID } from './plans.mjs';
import { riderCancelRequest,normalizeTripStatus } from './cancellation-protocol.mjs';
import { listPaymentProfiles } from './payments.mjs';
import { startLogin, completeLogin, validateLogin, pollLogin, cancelLogin, logout, authStatus, startBrowserRecovery } from './auth.mjs';

let values;
const print = value => console.log(JSON.stringify(value, null, 2));

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

async function browserLogin() {
  print(await startBrowserRecovery({callback:values['callback-url'],clientId:values['client-id']}));
}

async function codeInput() {
  if (values.code && values['code-file']) throw new Error('Use --code or --code-file, not both');
  if (values.code) return values.code.trim();
  if (values['code-file']) {
    const file = await fs.open(values['code-file'], 'r');
    try { const buffer = Buffer.alloc(128); const { bytesRead } = await file.read(buffer); if (bytesRead === 128) throw new Error('Code file is too large'); return buffer.subarray(0, bytesRead).toString().trim(); }
    finally { await file.close(); }
  }
  if (!process.stdin.isTTY) throw new Error('--code or --code-file is required outside an interactive terminal');
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try { return (await prompt.question('Verification code: ')).trim(); } finally { prompt.close(); }
}

try {
  const parsed = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' },
    'callback-url': { type: 'string' },
    'client-id': { type: 'string' },
    'device-data': { type: 'string' },
    phone: { type: 'string' },
    'country-code': { type: 'string' },
    'login-id': { type: 'string' },
    'challenge-id': { type: 'string' },
    code: { type: 'string' },
    'code-file': { type: 'string' },
    replace: { type: 'boolean' },
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
  'trip-id': { type: 'string' },
  'plan-id': { type: 'string' },
  'fulfillment-order-id': { type: 'string' },
  reason: { type: 'string' },
  'refund-strategy': { type: 'string' },
  comment: { type: 'string' },
  confirm: { type: 'boolean' },
  product: { type: 'string' },
  'vehicle-view-id': { type: 'string' },
  'variant-id': { type: 'string' },
  'payment-profile-id': { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  'public-url': { type: 'string' },
  'frame-origin': { type: 'string', multiple: true },
  duration: { type: 'string' },
  } });
  values = parsed.values;
  const command = parsed.positionals.join(' ') || 'help';
  
  if (values.help || command === 'help') {
    console.log(`Standalone Uber CLI — verification-code login and headless HTTP access.

uber tools                         Print tool definitions for models
uber login --phone +15555550123     Send a login verification code; works over SSH
uber auth complete --login-id ID --challenge-id ID --code CODE  Submit the current code; may request a second code
uber auth poll --login-id ID        Inspect the pending login without sending another code
uber auth validate --login-id ID    Retry validation of an already exchanged session
uber auth cancel --login-id ID      Cancel a pending login; keep the existing session
uber login-url                     Explicit manual browser recovery flow
uber auth complete --callback-url URL  Complete manual browser recovery
uber auth status                   Report local session state without printing tokens
uber auth refresh                  Exchange the stored refresh token
uber auth logout                   Delete local credentials and private responses
uber resolve --id ID --provider PROVIDER  Resolve a place to coordinates
uber search --query TEXT --near LAT,LON  Find places by name or address
uber status                        Query current account trip state
uber map [--trip-id UUID]           Read map routes, waypoints and driver-position snapshots
uber map link --trip-id UUID        Retrieve the official trip-sharing URL without sending it
uber map serve [--trip-id UUID]     Serve an expiring iframe map; remains running until stopped
uber payments                      List saved payment method IDs and display names
uber products --from LAT,LON --to LAT,LON  List current ride products
uber quote --from LAT,LON --to LAT,LON     Get current ride products and fare estimates
uber quote --from LAT,LON --to LAT,LON --dry-run  Inspect the request without sending it
uber shopping --request request.json  Send a modern order-selection request
uber book --from LAT,LON --to LAT,LON --product UberX  Prepare a signed quote for booking
uber book --plan-id UUID --confirm   Dispatch the reviewed ride and charge its selected payment
uber cancel --trip-id UUID         Preview cancellation terms without cancelling
uber cancel --plan-id UUID --confirm  Execute the reviewed cancellation plan
uber operation --id UUID           Inspect a saved booking/cancellation outcome

Optional flags: --raw, --country-code 1, --replace, --code-file FILE, --device-data FILE, --callback-url URL, --via LAT,LON
State: ${stateDirectory}`);
  } else if (command === 'tools') print(toolManifest);
  else if (command === 'login') {
    if (values['callback-url'] || values['client-id'] || values['device-data']) throw new Error('Custom browser settings belong to the explicit login-url recovery command');
    if (!values.phone) print({status:'phone_required',next:'Run uber login --phone +COUNTRYCODEPHONENUMBER to receive a verification code.'});
    else print(await startLogin({phone:values.phone,countryCode:values['country-code']??'1',replace:values.replace}));
  }
  else if (command === 'login-url') await browserLogin();
  else if (command === 'auth poll') print(await pollLogin({loginId:values['login-id']}));
  else if (command === 'auth cancel') print(await cancelLogin({loginId:values['login-id']}));
  else if (command === 'auth validate') print(await validateLogin({loginId:values['login-id']}));
  else if (command === 'auth complete') {
    if (values['callback-url']) {
      if (values.code || values['code-file'] || values['login-id'] || values['challenge-id']) throw new Error('Do not mix browser recovery and verification-code arguments');
      await withStateLock(() => exchange(values['callback-url'].trim()));
    } else {
      print(await completeLogin({code:await codeInput(),loginId:values['login-id'],challengeId:values['challenge-id']}));
    }
  } else if (command === 'auth status') {
    print(await authStatus());
  } else if (command === 'auth refresh') {
    await refresh();
    print({ refreshed: true });
  } else if (command === 'auth logout') {
    print(await logout());
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
    print(values.raw ? response : normalizeTripStatus(response));
  } else if (command === 'map link') {
    if (values.confirm || values['dry-run'] || values.raw) throw new Error('Map link is a read-only trip-link request');
    const { getTripShareLink } = await import('./trip-share.mjs');
    print(await getTripShareLink(values['trip-id']));
  } else if (command === 'map' || command === 'map serve') {
    if (values['trip-id']) requireUUID(values['trip-id'], 'Trip ID');
    const { getTripMap } = await import('./trip-map.mjs');
    if (command === 'map') {
      if (['host', 'port', 'public-url', 'frame-origin', 'duration'].some(key => values[key] !== undefined)) throw new Error('Viewer settings belong to uber map serve');
      print(await getTripMap({ tripId: values['trip-id'] }));
    } else {
      if (values.raw || values.confirm || values['dry-run']) throw new Error('Map serve supports read-only viewer settings');
      const { startMapServer, mapSessionGuard } = await import('./map-server.mjs');
      // Bind the lease to the first selected trip. Never follow a different ride
      // if the original ride ends during a long-lived browser session.
      let selectedTripId = values['trip-id'];
      const isAuthorized = await mapSessionGuard();
      const viewer = await startMapServer({ host: values.host, port: values.port, publicUrl: values['public-url'], frameOrigins: values['frame-origin'], durationSeconds: values.duration }, {
        isAuthorized,
        getScene: async () => {
          if (!await isAuthorized()) throw new Error('Map session changed');
          let scene;
          try { scene = await getTripMap({ tripId: selectedTripId }); }
          catch (error) {
            if (error.code !== 'TRIP_NOT_FOUND' || !selectedTripId) throw error;
            // Absence can mean cancellation, completion, or a response change.
            // Clear the map without inventing a terminal server status.
            return { schemaVersion: 1, observedAt: new Date().toISOString(), state: 'unavailable', tripId: selectedTripId, pollingIntervalMs: 8000, driver: { position: null, path: [] }, routes: [], waypoints: [], eta: {}, warnings: ['The selected trip is absent from the current status response.'] };
          }
          if (!await isAuthorized()) throw new Error('Map session changed');
          if (scene.tripId) selectedTripId ??= scene.tripId;
          return scene;
        },
      });
      const { mapUrl, expiresAt, listening, tripId, state, fidelity } = viewer;
      print({ mapUrl, expiresAt, listening, tripId, state, fidelity, lifecycle: 'Foreground server; keep this command running. Stop with SIGINT/SIGTERM or wait for expiry.' });
      const stop = () => { viewer.close().catch(() => { process.exitCode = 1; }); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
  } else if (command === 'operation') {
    print(await inspectOperation(values.id));
  } else if (command === 'payments') {
    print(await listPaymentProfiles());
  } else if (command === 'book') {
    if (values['plan-id']) {
      requireUUID(values['plan-id'],'Plan ID');
      if (['from','to','via','product','vehicle-view-id','variant-id','payment-profile-id'].some(key=>values[key]!==undefined)) throw new Error('A confirmed plan cannot be changed; prepare a new booking instead');
      if (values['dry-run']) {
        if (values.confirm) throw new Error('Choose --dry-run or --confirm');
        const plan=await readState(`plan-${values['plan-id']}`);
        if (!plan || plan.kind!=='booking') throw new Error('Booking plan was not found');
        print({endpoint:`/rt/riders/${plan.userUUID}/v2/pickup`,body:plan.body,preview:plan.preview,expiresAt:plan.expiresAt,willBook:false});
      } else {
        if (!values.confirm) throw new Error('Run book --plan-id UUID --confirm to dispatch the reviewed ride');
        const {confirmBooking}=await import('./booking.mjs');
        print(await confirmBooking(values['plan-id']));
      }
    } else {
      if (values.confirm) throw new Error('Prepare a priced booking plan first, then confirm its plan ID');
      const vehicleViewId=values['vehicle-view-id']===undefined?undefined:Number(values['vehicle-view-id']);
      if (vehicleViewId!==undefined && (!/^\d+$/.test(values['vehicle-view-id']) || !Number.isSafeInteger(vehicleViewId))) throw new Error('Vehicle view ID must be a nonnegative safe integer');
      if ((values.product===undefined)===(vehicleViewId===undefined)) throw new Error('Choose exactly one of --product or --vehicle-view-id');
      shoppingRequest(values.from,values.to,values.via);
      if (values['dry-run']) print({route:{from:values.from,to:values.to,via:values.via??[]},product:values.product??null,vehicleViewId:vehicleViewId??null,paymentProfileId:values['payment-profile-id']??null,willBook:false});
      else {
        const {prepareBooking}=await import('./booking.mjs');
        print(await prepareBooking({from:values.from,to:values.to,via:values.via,product:values.product,vehicleViewId,variantId:values['variant-id'],paymentProfileId:values['payment-profile-id']}));
      }
    }
  } else if (command === 'cancel') {
    if (values['plan-id']) {
      if (!values.confirm || values['dry-run']) throw new Error('Run cancel --plan-id UUID --confirm to execute the reviewed plan');
      if (['trip-id','reason','refund-strategy','fulfillment-order-id','comment'].some(key=>values[key]!==undefined)) throw new Error('A confirmed plan cannot be changed; prepare a new cancellation instead');
      print(await confirmCancellation(values['plan-id'],{raw:values.raw}));
    } else {
      if (values.confirm) throw new Error('Prepare cancellation terms first, then confirm its plan ID');
      const options={tripId:requireUUID(values['trip-id'],'Trip ID'),reason:values.reason,refundStrategy:values['refund-strategy'],fulfillmentOrderId:values['fulfillment-order-id'],comment:values.comment};
      if (values['dry-run']) print({previewEndpoint:`/rt/trips/${options.tripId}/cancellation-info`,previewBody:{},cancellationEndpoint:`/rt/trips/${options.tripId}/rider-cancel`,cancellationBody:riderCancelRequest(options),willCancel:false});
      else print(await prepareCancellation(options));
    }
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
  console.error(JSON.stringify({error:{message:error.message,code:error.code ?? 'cli_error',...(error.status ? {status:error.status} : {}),...(error.operationId ? {operationId:error.operationId} : {})}}));
  process.exitCode = 1;
}
