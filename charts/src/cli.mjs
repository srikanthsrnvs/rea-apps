import { parseArgs } from 'node:util';
import { toolDefinitions } from './tool-definitions.mjs';
import { ChartsError, publicError } from './errors.mjs';
import { createCharts } from './service.mjs';

export function parse(argv) {
  const options = { pretty: { type: 'boolean' }, help: { type: 'boolean' } };
  for (const tool of toolDefinitions) for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
    options[name] = { type: schema.type === 'boolean' ? 'boolean' : 'string' };
  }
  let parsed;
  try { parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true, tokens: true }); }
  catch { throw new ChartsError('INVALID_ARGUMENT', 'Invalid arguments. Run charts tools for schemas and accepted options.'); }
  const command = parsed.positionals.join(' '), seen = new Set();
  for (const token of parsed.tokens.filter(token => token.kind === 'option')) {
    if (seen.has(token.name)) throw new ChartsError('INVALID_ARGUMENT', 'Duplicate options are not accepted.');
    seen.add(token.name);
  }
  if (parsed.values.help || ((!command || ['tools', 'help'].includes(command)) && [...seen].every(key => ['pretty', 'help'].includes(key)))) {
    return { command: 'tools', args: {}, pretty: parsed.values.pretty };
  }
  if (command === 'mcp' && [...seen].every(key => key === 'pretty')) return { command, args: {} };
  const definition = toolDefinitions.find(tool => tool.command === command);
  if (!definition) throw new ChartsError('UNKNOWN_COMMAND', 'Unknown command. Run charts tools.');
  const args = {};
  for (const [name, value] of Object.entries(parsed.values)) {
    if (['pretty', 'help'].includes(name)) continue;
    const schema = definition.inputSchema.properties[name];
    if (!schema) throw new ChartsError('INVALID_ARGUMENT', 'An option is not accepted by this command. Run charts tools.');
    if (schema.type === 'integer' || schema.type === 'number') args[name] = /^-?\d+(?:\.\d+)?$/u.test(value) ? Number(value) : NaN;
    else if (schema.type === 'array' || schema.type === 'object') {
      try { args[name] = JSON.parse(value); } catch { throw new ChartsError('INVALID_ARGUMENT', 'Array and object options must be valid JSON.'); }
    } else args[name] = value;
  }
  return { command, args, pretty: parsed.values.pretty };
}

export async function dispatch(argv, dependencies = {}) {
  const parsed = parse(argv);
  if (parsed.command === 'tools') return { status: 'ok', message: 'Charts command catalog.', tools: toolDefinitions };
  return (dependencies.service ?? createCharts()).execute(parsed.command, parsed.args, { signal: dependencies.signal });
}

export async function run(argv = process.argv.slice(2)) {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new DOMException('Interrupted', 'AbortError'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const parsed = parse(argv);
    if (parsed.command === 'mcp') {
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      const { serveMcp } = await import('./mcp.mjs');
      await serveMcp();
      return;
    }
    console.log(JSON.stringify(await dispatch(argv, { signal: controller.signal }), null, parsed.pretty ? 2 : undefined));
  } catch (error) {
    const detail = publicError(error, controller.signal);
    console.error(JSON.stringify({ status: 'error', message: detail.message, error: detail }));
    process.exitCode = detail.code === 'ABORTED' ? 130 : 1;
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
