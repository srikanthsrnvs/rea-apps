import { runEatsCli } from './cli.mjs';
const commands = {
  eats_locations: 'locations',
  eats_search: 'search',
  eats_menu: 'menu',
  eats_cart: 'cart',
  eats_checkout: 'checkout',
  eats_order: 'order',
  eats_track: 'track',
  eats_operation: 'operation',
};
const flags = {
  storeId: 'store-id',
  itemId: 'item-id',
  sectionId: 'section-id',
  subsectionId: 'subsection-id',
  draftId: 'draft-id',
  lineId: 'line-id',
  operationId: 'operation-id',
  paymentProfileId: 'payment-profile-id',
  tipAmount: 'tip-amount',
  planId: 'plan-id',
  orderId: 'order-id',
  requestFile: 'request',
  frameOrigin: 'frame-origin',
  publicUrl: 'public-url',
};
export function eatsToolArguments(name, args = {}, { compact = true } = {}) {
  if (!commands[name]) throw new Error('Unknown Eats tool');
  if (name === 'eats_cart') {
    args = { ...args };
    const fields = [
      'diningMode',
      'deliveryAddress',
      'paymentProfileId',
      'items',
      'quantity',
      'specialInstructions',
      'customizations',
      'customizationV2s',
    ];
    const supplied = fields.filter((key) => args[key] !== undefined);
    if (supplied.length) {
      if (args.request !== undefined || args.requestFile !== undefined)
        throw new Error('Use flat cart fields or request, not both');
      const request = Object.fromEntries(
        supplied.map((key) => [key, args[key]]),
      );
      if (args.storeId !== undefined && args.action === 'create')
        request.storeId = args.storeId;
      for (const key of supplied) delete args[key];
      args.request = request;
    }
  }
  const argv = [commands[name]];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (key === 'request') {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(
          'request must be a structured object, not a filename or JSON string',
        );
      argv.push('--json', JSON.stringify(value));
      continue;
    }
    if (typeof value === 'boolean') {
      if (value) argv.push('--' + (flags[key] ?? key));
    } else if (Array.isArray(value)) {
      for (const element of value)
        argv.push('--' + (flags[key] ?? key), String(element));
    } else argv.push('--' + (flags[key] ?? key), String(value));
  }
  if (compact && !args.raw && ['eats_search', 'eats_menu'].includes(name))
    argv.push('--compact');
  return argv;
}
export async function runEatsTool(name, args, dependencies = {}) {
  const { compact = true, ...rest } = dependencies;
  return runEatsCli(eatsToolArguments(name, args, { compact }), {
    ...rest,
    print: () => {},
  });
}
