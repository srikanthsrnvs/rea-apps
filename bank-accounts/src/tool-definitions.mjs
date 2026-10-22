const string = { type: 'string' }, boolean = { type: 'boolean' };
const define = (command, description, properties = {}, required = []) => ({ name: `bank_accounts_${command.replaceAll(' ', '_')}`, command, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false } });
export const toolDefinitions = [
  define('configure', 'Configure a Sandbox Connector, verified against its official Quiltt-hosted configuration. Optional private API secret enables server access after browser session expiry; only same-environment SANDBOX keys are accepted.', { 'connector-id': string, 'api-key-file': string, 'api-key-stdin': boolean, prompt: boolean }, ['connector-id']),
  define('login', 'Return a browser sign-in/bank-linking URL and the Exit Redirect setting required on the Connector. No browser or Android runtime on the host.', { replace: boolean, 'public-url': string, port: string, 'timeout-seconds': string }),
  define('connect', 'Link another Sandbox bank to the saved Profile. The callback must authenticate the same Profile.', { 'public-url': string, port: string, 'timeout-seconds': string }),
  define('auth poll', 'Read pending login status without exposing tokens.'),
  define('auth wait', 'Wait for bank linking and independent session/Profile validation.', { 'timeout-seconds': string }),
  define('auth cancel', 'Cancel a pending connection flow, preserving an existing saved Profile.'),
  define('auth status', 'Read saved Profile and browser-session expiry. Local status is not an upstream token validation.'),
  define('logout', 'Remove the local Profile session. Does not disconnect or delete bank Connections in Quiltt.'),
  define('accounts', 'List the authenticated Profile accounts and their balances, with bank names and balance timestamps.'),
  define('balances', 'Read the latest synced account balances. Null means unavailable, not zero; timestamps describe freshness.'),
  define('connections', 'List linked institutions and their sync/repair status.'),
  define('transactions', 'Read transactions across the Profile, with cursor pagination and optional date, posted/pending and credit/debit filters.', { limit: string, cursor: string, 'start-date': string, 'end-date': string, status: string, 'entry-type': string }),
];
