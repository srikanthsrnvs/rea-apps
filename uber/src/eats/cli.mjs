import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { eatsToolManifest } from './tools.mjs';

const common = ['help'];
const commandOptions = {
  help: [],
  tools: [],
  locations: ['near', 'raw'],
  search: ['query', 'near', 'mode', 'offset', 'limit', 'raw'],
  menu: [
    'store-id',
    'item-id',
    'section-id',
    'subsection-id',
    'near',
    'mode',
    'offset',
    'raw',
  ],
  cart: [
    'action',
    'draft-id',
    'line-id',
    'store-id',
    'request',
    'operation-id',
    'raw',
  ],
  checkout: ['draft-id', 'payment-profile-id', 'tip-amount', 'raw'],
  order: [
    'action',
    'plan-id',
    'order-id',
    'confirm',
    'limit',
    'cursor',
    'near',
    'raw',
  ],
  operation: ['operation-id', 'raw'],
};
const stringOptions = [
  'query',
  'near',
  'mode',
  'offset',
  'limit',
  'cursor',
  'store-id',
  'item-id',
  'section-id',
  'subsection-id',
  'draft-id',
  'line-id',
  'action',
  'request',
  'plan-id',
  'order-id',
  'operation-id',
  'payment-profile-id',
  'tip-amount',
];
const options = Object.fromEntries(
  stringOptions.map((name) => [name, { type: 'string' }]),
);
options.help = { type: 'boolean', short: 'h' };
options.confirm = { type: 'boolean' };
options.raw = { type: 'boolean' };

function required(values, name) {
  if (values[name] === undefined || values[name] === '')
    throw new Error(`--${name} is required`);
}

function validate(values, command) {
  const allowed = new Set([...common, ...commandOptions[command]]);
  for (const [name, value] of Object.entries(values)) {
    if (!allowed.has(name))
      throw new Error(`--${name} is not supported for eats ${command}`);
    if (typeof value === 'string' && !value.trim())
      throw new Error(`--${name} cannot be empty`);
  }
  if (values.near !== undefined) {
    const parts = values.near.split(',');
    const valid =
      parts.length === 2 &&
      parts.every(
        (part) => part.trim() !== '' && Number.isFinite(Number(part)),
      );
    if (
      !valid ||
      Math.abs(Number(parts[0])) > 90 ||
      Math.abs(Number(parts[1])) > 180
    )
      throw new Error(
        '--near must be latitude,longitude within valid coordinate bounds',
      );
  }
  if (
    values.mode !== undefined &&
    !['delivery', 'pickup'].includes(values.mode)
  )
    throw new Error('--mode must be delivery or pickup');
  for (const name of ['offset', 'limit']) {
    if (values[name] === undefined) continue;
    if (
      !/^[0-9]+$/.test(values[name]) ||
      !Number.isSafeInteger(Number(values[name]))
    )
      throw new Error(`--${name} must be an integer`);
    values[name] = Number(values[name]);
    if (
      values[name] < (name === 'limit' ? 1 : 0) ||
      (name === 'limit' && values[name] > 100)
    )
      throw new Error(`--${name} is outside the supported range`);
  }
  if (
    values['tip-amount'] !== undefined &&
    !/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(values['tip-amount'])
  )
    throw new Error(
      '--tip-amount must be a nonnegative decimal amount with at most two decimal places',
    );
  if (command === 'search') {
    required(values, 'query');
    required(values, 'near');
  } else if (command === 'menu') {
    required(values, 'store-id');
    required(values, 'near');
  } else if (command === 'checkout') {
    required(values, 'draft-id');
    required(values, 'tip-amount');
  } else if (command === 'operation') {
    required(values, 'operation-id');
  } else if (command === 'cart') {
    values.action ??= 'list';
    if (
      !['list', 'get', 'create', 'add', 'update', 'remove', 'discard'].includes(
        values.action,
      )
    )
      throw new Error('Unsupported Eats cart action');
    if (values.action !== 'list' && values.action !== 'create')
      required(values, 'draft-id');
    if (['create', 'add', 'update'].includes(values.action))
      required(values, 'request');
    if (values.action === 'remove') required(values, 'line-id');
    if (values['line-id'] && !['update', 'remove'].includes(values.action))
      throw new Error('--line-id is only supported for cart update or remove');
    if (values['draft-id'] && values.action === 'create')
      throw new Error(
        'Cart create does not accept --draft-id; use add to edit an existing cart',
      );
    if (
      values['store-id'] &&
      ['list', 'get', 'discard'].includes(values.action)
    )
      throw new Error('--store-id is not supported for this cart action');
    if (values.request && !['create', 'add', 'update'].includes(values.action))
      throw new Error(
        '--request is only supported for cart create, add or update',
      );
    if (values['operation-id'] && ['list', 'get'].includes(values.action))
      throw new Error('--operation-id is only supported for cart mutations');
  } else if (command === 'order') {
    values.action ??= 'status';
    if (!['confirm', 'status', 'cancel', 'history'].includes(values.action))
      throw new Error('Unsupported Eats order action');
    if (values.near && (values.action !== 'cancel' || values['plan-id']))
      throw new Error('--near is only supported when preparing a cancellation');
    if (
      values['order-id'] &&
      (values.action === 'confirm' || values['plan-id'])
    )
      throw new Error(
        'Plan confirmation uses its reviewed identity; omit --order-id',
      );
    if (
      values.action !== 'history' &&
      (values.limit !== undefined || values.cursor !== undefined)
    )
      throw new Error(
        '--limit and --cursor are only supported for order history',
      );
    if (
      values.action === 'confirm' ||
      (values.action === 'cancel' && (values['plan-id'] || values.confirm))
    ) {
      required(values, 'plan-id');
      if (values.confirm !== true)
        throw new Error(
          '--confirm is required to submit an order or cancellation',
        );
    } else if (values.action === 'cancel') {
      required(values, 'order-id');
    } else {
      if (values.confirm || values['plan-id'])
        throw new Error(
          `Order ${values.action} does not accept --confirm or --plan-id`,
        );
      if (values.action === 'history' && values['order-id'])
        throw new Error('Order history does not accept --order-id');
    }
  }
}

async function readRequest(filename) {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    const maxBytes = 1024 * 1024;
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error('--request must be a JSON file of at most 1 MiB');
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        total,
      );
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > maxBytes)
      throw new Error('--request must be a JSON file of at most 1 MiB');
    let request;
    try {
      request = JSON.parse(buffer.subarray(0, total).toString('utf8'));
    } catch {
      throw new Error('--request must contain valid JSON');
    }
    if (
      request === null ||
      typeof request !== 'object' ||
      Array.isArray(request)
    )
      throw new Error('--request must contain a JSON object');
    return request;
  } finally {
    await handle.close();
  }
}

export async function runEatsCli(argv, { execute, print = console.log } = {}) {
  const parsed = parseArgs({
    args: argv,
    options,
    allowPositionals: true,
    tokens: true,
  });
  const seen = new Set();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name))
      throw new Error(`--${token.name} may only be supplied once`);
    seen.add(token.name);
  }
  if (parsed.positionals.length > 1)
    throw new Error('Expected one Eats subcommand');
  const command = parsed.positionals[0] ?? 'help';
  if (!Object.hasOwn(commandOptions, command))
    throw new Error(`Unknown Eats command: ${command}`);
  const values = parsed.values;
  if (values.help || command === 'help') {
    const result = {
      usage: 'uber eats <command> [options]',
      commands: eatsToolManifest.tools.map(
        ({ name, command, description }) => ({ name, command, description }),
      ),
      operation: 'uber eats operation --operation-id ID',
      request:
        'Cart create/add/update accept --request FILE containing a JSON object. Draft changes do not place an order.',
      checkout:
        'Choose --tip-amount explicitly; review the priced plan before order --action confirm --plan-id ID --confirm.',
    };
    print(JSON.stringify(result, null, 2));
    return result;
  }
  validate(values, command);
  if (command === 'tools') {
    print(JSON.stringify(eatsToolManifest, null, 2));
    return eatsToolManifest;
  }
  if (values.request) values.request = await readRequest(values.request);
  const service = execute ?? (await import('./service.mjs')).executeEats;
  const result = await service(command, values);
  print(JSON.stringify(result, null, 2));
  return result;
}
