import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runEatsCli } from '../src/eats/cli.mjs';
import { eatsTools } from '../src/eats/tools.mjs';

test('help and the six-tool manifest require no session or service call and print JSON', async () => {
  let calls = 0;
  const output = [];
  const dependencies = {
    execute: async () => {
      calls++;
    },
    print: (line) => output.push(JSON.parse(line)),
  };
  await runEatsCli([], dependencies);
  await runEatsCli(['tools'], dependencies);
  assert.equal(calls, 0);
  assert.equal(output[0].usage, 'uber eats <command> [options]');
  assert.equal(output[1].tools.length, 6);
  assert.equal(new Set(eatsTools.map((tool) => tool.name)).size, 6);
  assert.ok(
    eatsTools.every((tool) => tool.inputSchema.additionalProperties === false),
  );
  assert.ok(output[0].checkout.includes('--confirm'));
});

test('search converts only pagination numbers and preserves fulfillment and coordinates', async () => {
  const output = [];
  let seen;
  await runEatsCli(
    [
      'search',
      '--query',
      'tacos',
      '--near',
      '34,-118',
      '--mode',
      'pickup',
      '--offset',
      '20',
      '--limit',
      '10',
    ],
    {
      execute: async (command, values) => {
        seen = { command, values };
        return { restaurants: [] };
      },
      print: (line) => output.push(JSON.parse(line)),
    },
  );
  assert.equal(seen.command, 'search');
  assert.equal(seen.values.offset, 20);
  assert.equal(seen.values.limit, 10);
  assert.equal(seen.values.near, '34,-118');
  assert.equal(seen.values.mode, 'pickup');
  assert.deepEqual(output, [{ restaurants: [] }]);
});

test('cart reads structured JSON selections and preserves zero quantities and nested options', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eats-cli-'));
  try {
    const filename = path.join(directory, 'cart.json');
    const body = {
      items: [
        {
          itemId: 'latte',
          quantity: 1,
          customizationV2s: [
            {
              uuid: 'milk',
              childOptions: { options: [{ uuid: 'whole', quantity: 0 }] },
            },
          ],
        },
      ],
    };
    await fs.writeFile(filename, JSON.stringify(body));
    let received;
    await runEatsCli(
      ['cart', '--action', 'add', '--draft-id', 'draft', '--request', filename],
      {
        execute: async (_, values) => {
          received = values;
          return { status: 'draft' };
        },
        print() {},
      },
    );
    assert.deepEqual(received.request, body);
    assert.equal(received['draft-id'], 'draft');
    await fs.writeFile(filename, '[]');
    await assert.rejects(
      runEatsCli(['cart', '--action', 'create', '--request', filename], {
        execute() {
          assert.fail('must not execute');
        },
        print() {},
      }),
      /JSON object/,
    );
    await fs.writeFile(filename, '{bad');
    await assert.rejects(
      runEatsCli(['cart', '--action', 'create', '--request', filename], {
        print() {},
      }),
      /valid JSON/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('checkout requires an explicit tip and retains its decimal value without float conversion', async () => {
  let received;
  await runEatsCli(
    ['checkout', '--draft-id', 'draft', '--tip-amount', '0.00'],
    {
      execute: async (_, values) => {
        received = values;
        return {};
      },
      print() {},
    },
  );
  assert.equal(received['tip-amount'], '0.00');
  await assert.rejects(
    runEatsCli(['checkout', '--draft-id', 'draft'], { print() {} }),
    /tip-amount is required/,
  );
  for (const amount of ['-1', '1e2', 'NaN', '2.555', '0x10']) {
    await assert.rejects(
      runEatsCli(['checkout', '--draft-id', 'draft', '--tip-amount', amount], {
        print() {},
      }),
      /tip-amount/,
    );
  }
});

test('order confirmation and cancellation require a reviewed plan and explicit confirmation', async () => {
  let calls = 0;
  const dependencies = {
    execute: async () => {
      calls++;
      return { operationId: 'operation' };
    },
    print() {},
  };
  await assert.rejects(
    runEatsCli(
      ['order', '--action', 'confirm', '--plan-id', 'plan'],
      dependencies,
    ),
    /--confirm is required/,
  );
  await assert.rejects(
    runEatsCli(
      ['order', '--action', 'cancel', '--order-id', 'order', '--confirm'],
      dependencies,
    ),
    /--plan-id is required/,
  );
  assert.equal(calls, 0);
  await runEatsCli(
    ['order', '--action', 'confirm', '--plan-id', 'plan', '--confirm'],
    dependencies,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    runEatsCli(
      ['order', '--action', 'status', '--order-id', 'order', '--confirm'],
      dependencies,
    ),
    /does not accept/,
  );
});

test('cancellation preparation remains distinct from submitting its reviewed plan', async () => {
  const calls = [];
  const dependencies = {
    execute: async (command, values) => {
      calls.push({ command, ...values });
      return {};
    },
    print() {},
  };
  await runEatsCli(
    ['order', '--action', 'cancel', '--order-id', 'order'],
    dependencies,
  );
  assert.equal(calls[0]['order-id'], 'order');
  assert.equal(calls[0].confirm, undefined);
  assert.equal(calls[0]['plan-id'], undefined);
  await runEatsCli(
    ['order', '--action', 'cancel', '--plan-id', 'reviewed-plan', '--confirm'],
    dependencies,
  );
  assert.equal(calls[1]['plan-id'], 'reviewed-plan');
  assert.equal(calls[1].confirm, true);
  await assert.rejects(
    runEatsCli(['order', '--action', 'cancel'], dependencies),
    /--order-id is required/,
  );
  await assert.rejects(
    runEatsCli(
      ['order', '--action', 'cancel', '--plan-id', 'plan'],
      dependencies,
    ),
    /--confirm is required/,
  );
  assert.equal(calls.length, 2);
});

test('active status omits order id and history preserves its opaque cursor', async () => {
  const calls = [];
  const dependencies = {
    execute: async (command, values) => {
      calls.push({ command, ...values });
      return {};
    },
    print() {},
  };
  await runEatsCli(['order'], dependencies);
  assert.equal(calls[0].action, 'status');
  assert.equal(calls[0]['order-id'], undefined);
  await runEatsCli(
    ['order', '--action', 'history', '--limit', '10', '--cursor', 'opaque/+=='],
    dependencies,
  );
  assert.equal(calls[1].limit, 10);
  assert.equal(calls[1].cursor, 'opaque/+==');
  await assert.rejects(
    runEatsCli(
      ['order', '--action', 'status', '--cursor', 'one'],
      dependencies,
    ),
    /only supported for order history/,
  );
  await assert.rejects(
    runEatsCli(
      ['order', '--action', 'history', '--order-id', 'one'],
      dependencies,
    ),
    /does not accept --order-id/,
  );
  await assert.rejects(
    runEatsCli(['order', '--action', 'history', '--confirm'], dependencies),
    /does not accept/,
  );
  assert.equal(calls.length, 2);
  const tool = eatsTools.find(({ name }) => name === 'eats_order');
  assert.ok(tool.inputSchema.properties.action.enum.includes('history'));
});

test('cart mutation recovery forwards the same operation id without affecting read commands', async () => {
  const operationId = '41f78366-514e-4156-8df0-4fe609218f13';
  let values;
  const dependencies = {
    execute: async (_, input) => {
      values = input;
      return {};
    },
    print() {},
  };
  await runEatsCli(
    [
      'cart',
      '--action',
      'remove',
      '--draft-id',
      'draft',
      '--line-id',
      'line',
      '--operation-id',
      operationId,
    ],
    dependencies,
  );
  assert.equal(values['operation-id'], operationId);
  await assert.rejects(
    runEatsCli(
      ['cart', '--action', 'list', '--operation-id', operationId],
      dependencies,
    ),
    /only supported for cart mutations/,
  );
  assert.equal(
    eatsTools.find(({ name }) => name === 'eats_cart').inputSchema.properties
      .operationId.format,
    'uuid',
  );
});

test('invalid, repeated or cross-command flags fail before any account access', async () => {
  let calls = 0;
  const dependencies = {
    execute: async () => {
      calls++;
    },
    print() {},
  };
  for (const argv of [
    ['search', '--query', 'pizza', '--near', '91,0'],
    ['search', '--query', 'pizza', '--near', '0,0', '--limit', '0'],
    ['search', '--query', 'pizza', '--near', '0,0', '--offset', '1.5'],
    ['search', '--query', 'pizza', '--near', '0,0', '--confirm'],
    ['cart', '--action', 'list', '--action', 'discard'],
    ['menu', '--store-id', 'one', '--near', '0,0', '--mode', 'DELIVERY'],
    ['order', 'confirm'],
    ['unknown'],
    ['operation'],
  ])
    await assert.rejects(runEatsCli(argv, dependencies));
  assert.equal(calls, 0);
});

test('menu rejects a page size unsupported by the native endpoint', async () => {
  await assert.rejects(
    runEatsCli(
      ['menu', '--store-id', 'store', '--near', '34,-118', '--limit', '10'],
      {
        execute() {
          assert.fail('ignored menu flags must not reach the service');
        },
        print() {},
      },
    ),
    /--limit is not supported for eats menu/,
  );
  const tool = eatsTools.find(({ name }) => name === 'eats_menu');
  assert.equal(tool.inputSchema.properties.limit, undefined);
  assert.ok(!tool.command.includes('--limit'));
});

test('service failures propagate without printing a successful result', async () => {
  const output = [];
  await assert.rejects(
    runEatsCli(['operation', '--operation-id', 'operation'], {
      execute: async () => {
        throw new Error('Outcome uncertain; inspect operation');
      },
      print: (line) => output.push(line),
    }),
    /Outcome uncertain/,
  );
  assert.deepEqual(output, []);
});
test('confirmation rejects ignored order/location selectors instead of approving a different plan', async () => {
  const execute = async () => {
    throw new Error('Service must not be called');
  };
  for (const args of [
    [
      'order',
      '--action',
      'confirm',
      '--plan-id',
      'plan',
      '--confirm',
      '--order-id',
      'different-order',
    ],
    [
      'order',
      '--action',
      'cancel',
      '--plan-id',
      'plan',
      '--confirm',
      '--near',
      '34,-118',
    ],
    [
      'cart',
      '--action',
      'create',
      '--draft-id',
      'existing',
      '--request',
      'unused.json',
    ],
  ])
    await assert.rejects(
      runEatsCli(args, { execute, print() {} }),
      /omit|only supported|does not accept/,
    );
});
