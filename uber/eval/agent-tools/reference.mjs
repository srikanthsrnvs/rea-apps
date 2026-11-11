// Authored reference trajectories through the same production tools and backend.
// This is not a second sampled model; it makes the intended cart state explicit.
import { backend, id } from './backend.mjs';
import { runEatsTool } from '../../src/eats/tool-dispatch.mjs';
import { scenarios } from './scenarios.mjs';
export async function reference(key) {
  const f = backend(scenarios[key]),
    turns = [[]];
  const call = async (name, args) => {
    turns.at(-1).push({ name, args });
    return runEatsTool(name, args, { execute: f.execute });
  };
  await call('eats_locations', {});
  await call('eats_search', {
    query: 'Harbor Kitchen',
    near: '34,-118',
    mode: key === 'latte' ? 'pickup' : 'delivery',
  });
  const detail = async (n) =>
    call('eats_menu', {
      storeId: id(2),
      itemId: id(n),
      sectionId: id(3),
      near: '34,-118',
      mode: key === 'latte' ? 'pickup' : 'delivery',
    });
  const create = (items) =>
    call('eats_cart', {
      action: 'create',
      storeId: id(2),
      diningMode: key === 'latte' ? 'pickup' : 'delivery',
      deliveryAddress: f.address,
      items,
    });
  let result;
  if (key === 'latte') {
    const d = await detail(11);
    result = await create([
      {
        ...d.standardItem,
        quantity: 2,
        choices: [
          { group: 'Size', option: 'Large 16 oz' },
          { group: 'Milk', option: 'Oat Milk' },
          { group: 'Foam', option: 'No foam' },
          { group: 'Extras', option: 'Espresso Shot', quantity: 2 },
        ],
      },
    ]);
    turns.push([]);
    result = await call('eats_cart', {
      action: 'update',
      draftId: result.cart.draftId,
      lineId: result.cart.items[0].shoppingCartItemUUID,
      quantity: 3,
    });
  } else if (key === 'mixed') {
    const burger = await detail(12),
      fries = await detail(13);
    result = await create([
      {
        ...burger.standardItem,
        specialInstructions: 'Sauce on the side',
        choices: [{ group: 'Onions', option: 'No onions' }],
      },
      {
        ...fries.standardItem,
        quantity: 2,
        choices: [{ group: 'Seasoning', option: 'No salt' }],
      },
    ]);
    const draftId = result.cart.draftId,
      lineId = result.cart.items[0].shoppingCartItemUUID;
    await call('eats_checkout', { draftId, tipAmount: '2.50' });
    turns.push([]);
    result = await call('eats_cart', { action: 'remove', draftId, lineId });
  } else if (key === 'unavailable') {
    await detail(11); // Oat is sold out: stop without any draft mutation.
  } else if (key === 'unknown') {
    const d = await detail(10);
    try {
      await create([d.standardItem]);
    } catch (error) {
      if (error.code !== 'outcome_unknown') throw error;
      result = await call('eats_operation', { operationId: error.operationId });
    }
  }
  return {
    turns,
    result,
    state: {
      drafts: f.drafts,
      writes: f.writeCount,
      calls: f.calls,
      records: [...f.records],
    },
  };
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  for (const key of Object.keys(scenarios)) {
    const r = await reference(key);
    console.log(
      JSON.stringify({
        case: key,
        turnCalls: r.turns.map((t) => t.length),
        writes: r.state.writes,
        drafts: r.state.drafts.length,
        status: r.result?.status ?? r.result?.state ?? null,
      }),
    );
  }
}
