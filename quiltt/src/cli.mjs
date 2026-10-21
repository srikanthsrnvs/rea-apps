import { parseArgs } from 'node:util';
import { toolDefinitions } from './tool-definitions.mjs';
import { QuilttError } from './errors.mjs';
import { configure } from './config.mjs';
import * as auth from './auth.mjs';
import * as data from './data.mjs';
function parse(argv) {
  const options = { pretty: { type: 'boolean' }, help: { type: 'boolean' } };
  for (const def of toolDefinitions) for (const [name, schema] of Object.entries(def.inputSchema.properties)) options[name] = { type: schema.type };
  let result;
  try { result = parseArgs({ args: argv, options, strict: true, allowPositionals: true, tokens: true }); }
  catch { throw new QuilttError('INVALID_ARGUMENT', 'Invalid arguments. Run quiltt tools. API secrets are never accepted as arguments.'); }
  const command = result.positionals.join(' '), o = result.values;
  if (!command || ['tools', 'help'].includes(command) || o.help) return { command: 'tools', o };
  const def = toolDefinitions.find(item => item.command === command);
  if (!def) throw new QuilttError('UNKNOWN_COMMAND', 'Unknown command. Run quiltt tools.');
  const seen = new Set();
  for (const token of result.tokens.filter(item => item.kind === 'option')) {
    if (seen.has(token.name) || token.name !== 'pretty' && !Object.hasOwn(def.inputSchema.properties, token.name)) throw new QuilttError('INVALID_ARGUMENT', 'Duplicate option or an option not accepted by this command.');
    seen.add(token.name);
  }
  for (const key of def.inputSchema.required) if (o[key] === undefined) throw new QuilttError('INVALID_ARGUMENT', `Provide --${key}.`);
  return { command, o };
}
const number = value => value === undefined ? undefined : Number(value);
export async function dispatch(argv) {
  const { command, o } = parse(argv);
  switch (command) {
    case 'tools': return { environment: 'SANDBOX', tools: toolDefinitions };
    case 'configure': return configure({ connector: o['connector-id'], file: o['api-key-file'], stdin: o['api-key-stdin'], prompt: o.prompt });
    case 'login': case 'connect': return auth.startLogin({ replace: o.replace, connect: command === 'connect', publicUrl: o['public-url'], port: number(o.port), timeoutSeconds: number(o['timeout-seconds']) });
    case 'auth poll': return auth.pollLogin();
    case 'auth wait': return auth.waitLogin({ timeoutSeconds: number(o['timeout-seconds']) });
    case 'auth status': return auth.authStatus();
    case 'auth cancel': return auth.cancelLogin();
    case 'logout': return auth.logout();
    case 'accounts': return data.accounts();
    case 'balances': return data.balances();
    case 'connections': return data.connections();
    case 'transactions': return data.transactions({ limit: o.limit, cursor: o.cursor, startDate: o['start-date'], endDate: o['end-date'], status: o.status, entryType: o['entry-type'] });
    default: throw new QuilttError('UNKNOWN_COMMAND', 'Unknown command. Run quiltt tools.');
  }
}
export async function run(argv = process.argv.slice(2)) {
  try { console.log(JSON.stringify(await dispatch(argv), null, argv.includes('--pretty') ? 2 : undefined)); }
  catch (error) { console.error(JSON.stringify({ error: { code: error instanceof QuilttError ? error.code : 'INTERNAL_ERROR', message: error instanceof QuilttError ? error.message : 'The Quiltt command could not complete.' } })); process.exitCode = 1; }
}
