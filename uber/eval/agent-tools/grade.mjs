// Grade state and native writes, never the model's claim of completion.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { reference } from './reference.mjs';
import { id } from './backend.mjs';
const selections = (groups) =>
  (groups ?? [])
    .map((group) => ({
      uuid: group.uuid,
      options: (group.childOptions?.options ?? [])
        .map((option) => ({
          uuid: option.uuid,
          quantity: option.quantity,
          children: selections(option.customizationV2List),
        }))
        .sort((a, b) => a.uuid.localeCompare(b.uuid)),
    }))
    .sort((a, b) => a.uuid.localeCompare(b.uuid));
export async function grade(key, state, trace, turns) {
  const r = await reference(key),
    expected = r.state.drafts[0],
    actual = state.drafts[0];
  const checks = {
    completed: !turns.some((t) => t.aborted),
    noPurchase: !state.calls.some((c) =>
      /checkout-orders-by-draft-orders|fulfill-action/.test(c.endpoint),
    ),
  };
  if (key === 'unavailable') {
    checks.noCartChanges = state.writes === 0 && state.drafts.length === 0;
    checks.inspectedUnavailableOption = trace.some(
      (t) =>
        t.name === 'eats_menu' &&
        t.result?.modifierGroups?.some((g) =>
          g.options?.some((o) => o.name === 'Oat Milk' && o.isSoldOut === true),
        ),
    );
  } else {
    checks.oneCart = state.drafts.length === 1;
    checks.sameFulfillment = actual?.diningMode === expected.diningMode;
    checks.sameAddress =
      actual?.deliveryAddress?.latitude === 34 &&
      actual?.deliveryAddress?.longitude === -118;
    const expectedItems = expected.shoppingCart.items,
      actualItems = actual?.shoppingCart?.items ?? [];
    checks.exactItemsAndChoices =
      actualItems.length === expectedItems.length &&
      expectedItems.every((e) =>
        actualItems.some(
          (a) =>
            a.skuUUID === e.skuUUID &&
            a.quantity === e.quantity &&
            isDeepStrictEqual(
              selections(a.customizationV2s),
              selections(e.customizationV2s),
            ),
        ),
      );
    if (key === 'latte') {
      const create = state.calls.find((c) =>
        c.endpoint.endsWith('create-draft-order'),
      );
      checks.startedWithTwo =
        create?.body?.request?.shoppingCart?.items?.[0]?.quantity === 2;
      checks.quantityOnlyFollowup =
        turns.length === 2 &&
        turns[1].calls.length === 1 &&
        turns[1].calls[0].name === 'eats_cart' &&
        turns[1].calls[0].args.action === 'update' &&
        (turns[1].calls[0].args.quantity === 3 ||
          (turns[1].calls[0].args.request?.quantity === 3 &&
            Object.keys(turns[1].calls[0].args.request).length === 1));
    }
    if (key === 'mixed') {
      const create = state.calls.find((c) =>
        c.endpoint.endsWith('create-draft-order'),
      );
      checks.kitchenInstructionsPreserved = /sauce.{0,20}side/i.test(
        create?.body?.request?.shoppingCart?.items?.find(
          (i) => i.skuUUID === id(12),
        )?.specialInstructions ?? '',
      );
      const checkout = trace.find(
        (t) =>
          t.name === 'eats_checkout' &&
          t.result?.status === 'confirmation_required',
      );
      checks.correctCheckout =
        checkout?.args?.tipAmount === '2.50' &&
        checkout.result.total?.formatted === '$24.50';
      checks.removeOnlyBurger =
        turns.length === 2 &&
        turns[1].calls.filter(
          (c) => c.name === 'eats_cart' && c.args.action === 'remove',
        ).length === 1;
    }
    if (key === 'unknown') {
      checks.singleWrite = state.writes === 1;
      const failed = trace.find(
        (t) => t.result?.error?.code === 'outcome_unknown',
      );
      checks.inspectedSameOperation =
        Boolean(failed?.result?.operationId) &&
        trace.some(
          (t) =>
            t.name === 'eats_operation' &&
            t.args.operationId === failed.result.operationId &&
            t.result?.state === 'unknown',
        );
    }
  }
  return {
    case: key,
    passed: Object.values(checks).every(Boolean),
    checks,
    turnCalls: turns.map((t) => t.calls.length),
    referenceTurnCalls: r.turns.map((t) => t.length),
    seconds: turns.map((t) => t.seconds),
    writes: state.writes,
  };
}
if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], 'file:').href
) {
  const dir = process.argv[2];
  if (!dir) throw new Error('Usage: node grade.mjs PRIVATE_RUN_DIRECTORY');
  for (const key of fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('-state.json'))
    .map((n) => n.slice(0, -11))) {
    const read = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
    const trace = fs
      .readFileSync(path.join(dir, key, 'trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((s) => JSON.parse(s));
    console.log(
      JSON.stringify(
        await grade(
          key,
          read(key + '-state.json'),
          trace,
          read(key + '/turns.json'),
        ),
      ),
    );
  }
}
