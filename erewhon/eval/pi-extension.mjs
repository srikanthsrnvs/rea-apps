import fs from 'node:fs';
import { toolManifest, advancedToolManifest, orderingToolManifest } from '../src/tools.mjs';
import { createCatalog } from '../src/catalog.mjs';
import { fixture, recipe } from '../test/helpers/recipe-fixture.mjs';

// This extension exercises production modules against a deterministic backend.
// It never loads account credentials, SSH, a browser or real payment endpoints.
export default async function (pi) {
  const f = fixture();
  const catalog = createCatalog(f.dependencies);
  const scenario = process.env.EREWHON_EVAL_SCENARIO ?? 'fresh';
  const log = process.env.EREWHON_EVAL_TRACE;
  const record = value => { if (log) fs.appendFileSync(log, `${JSON.stringify(value)}\n`, { mode: 0o600 }); };
  let plan;
  if (scenario !== 'fresh') {
    await f.api.save({ name: 'usual-coffee', recipe });
    f.rotation = 'new-session';
  }
  if (['interrupted', 'pending', 'approved', 'repeat'].includes(scenario)) plan = await f.api.prepare({ name: 'usual-coffee' });
  if (scenario === 'pending') { f.dropPlace = true; f.reconcilePending = true; await f.ordering.confirmOrder({ planId: plan.planId }); }
  if (scenario === 'ambiguous') f.ambiguous = true;
  const prompts = {
    fresh: 'Prepare one Large 16 oz Cappuccino with Whole Milk, for pickup at Venice. Show me the price for review. Do not place an order.',
    saved: 'Prepare my usual-coffee for pickup and show me its current price. Do not buy it yet.',
    interrupted: `My tap got interrupted and the card says completed. Did my coffee actually get ordered? The review plan is ${plan?.planId}. Check; do not place another order.`,
    pending: `The connection dropped after I tapped pay. Review plan ${plan?.planId}. Check whether my order went through, without placing another one.`,
    approved: `I approve the Cappuccino review ${plan?.planId}: one Large 16 oz, Whole Milk, Venice pickup ASAP, total $9.97 on Mastercard ending 1234. Place exactly this approved order once and report the result.`,
    repeat: 'The usual-coffee preparation card retried. Prepare the same usual-coffee again for review, but make sure there is only one coffee. Do not purchase.',
    ambiguous: 'Prepare my usual-coffee. If you cannot establish which exact product is intended, ask me; do not guess and do not purchase.',
  };
  const originalCallCount = f.calls.length;
  record({ type: 'setup', scenario, prompt: prompts[scenario], seedPlanId: plan?.planId });
  pi.on('before_agent_start', () => ({ systemPrompt: 'You are a shopping assistant. Use the provided tools to fulfill the user request. Report actual outcomes accurately.' }));
  pi.on('input', event => event.text === '__EREWHON_SCENARIO__' ? { action: 'transform', text: prompts[scenario] } : { action: 'continue' });
  const allowed = new Set(['product_find','product_options','recipe_save','recipe_show','recipe_reset','order_status','stores','fulfillment','fulfillment_select','search','product','cart','cart_add','cart_update','cart_remove','checkout','order_prepare','order_confirm','order_detail','order_operation']);
  let count = 0;
  for (const tool of (process.env.EREWHON_EVAL_PROFILE==='advanced'?advancedToolManifest:process.env.EREWHON_EVAL_PROFILE==='ordering'?orderingToolManifest:toolManifest).tools.filter(tool => allowed.has(tool.name))) pi.registerTool({
    name: tool.name, label: tool.name, description: tool.description,
    parameters: tool.inputSchema,
    async execute(_id, args) {
      count++;
      record({ type: 'call', name: tool.name, args });
      let result;
      try {
        if (count > 12) throw new Error('Evaluation tool-call budget exceeded. Explain what is blocking you.');
        switch (tool.name) {
          case 'product_find': result = await f.api.find(args); break;
          case 'product_options': result = await f.api.options(args); break;
          case 'recipe_save': result = await f.api.save(args); break;
          case 'recipe_show': result = await f.api.show(args); break;
          case 'recipe_reset': result = await f.api.reset(args); break;
          case 'order_status': result = await f.ordering.orderStatus(args); break;
          case 'stores': result = await catalog.stores(args); break;
          case 'fulfillment': result = await catalog.fulfillment(); break;
          case 'fulfillment_select': result = await catalog.selectFulfillment(args); break;
          case 'search': result = await catalog.search(args); break;
          case 'product': result = await catalog.product(args); break;
          case 'cart': result = await f.ordering.cart(); break;
          case 'cart_add': if(args.modifiersFile) throw new Error('This model has only CLI tools; no modifier-file writer is available.'); result = await f.ordering.addCartItem(args); break;
          case 'cart_update': throw new Error('This tool requires a cart update file. Use a recipe or inspect the cart.');
          case 'cart_remove': result = await f.ordering.removeCartItem(args); break;
          case 'checkout': result = await f.ordering.checkout(args); break;
          case 'order_prepare': result = args.request ? await f.api.prepareRequest({request:args.request}) : args.recipe ? await f.api.prepare({name:args.recipe,checkoutOptions:Object.fromEntries(Object.entries(args).filter(([key])=>key!=='recipe'))}) : await f.ordering.prepareOrder(args); break;
          case 'order_confirm': result = await f.ordering.confirmOrder(args); break;
          case 'order_detail': throw new Error('Use order status or operation to inspect the recorded result.');
          case 'order_operation': result = await f.ordering.inspectOrderOperation(args); break;
        }
        record({ type: 'result', name: tool.name, result });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
      } catch (error) {
        result = { error: { code: error.code ?? 'TOOL_ERROR', message: error.message,...(error.details?{details:error.details}:{}) } };
        record({ type: 'result', name: tool.name, result });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {}, isError: true };
      } finally {
        record({ type: 'state', rows: f.rows.length, quantity: f.rows.reduce((sum,row)=>sum+row.quantity,0),
          placements: f.calls.slice(originalCallCount).filter(call=>call.path==='/v1/place_order').length });
      }
    },
  });
}
