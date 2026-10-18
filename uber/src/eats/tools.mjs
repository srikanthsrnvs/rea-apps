const coordinate = {
  type: 'string',
  description:
    'Latitude,longitude for the selected delivery address or pickup area.',
};
const id = { type: 'string', minLength: 1 };
const mode = {
  type: 'string',
  enum: ['delivery', 'pickup'],
  default: 'delivery',
};
const schema = (properties, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

export const eatsTools = [
  {
    name: 'eats_locations',
    command: 'uber eats locations [--near <near>]',
    description:
      'Inspect Eats account location context and recent delivery addresses. Use the selected address coordinates for search and menu availability.',
    inputSchema: schema({ near: coordinate }),
  },
  {
    name: 'eats_search',
    command:
      'uber eats search --query <query> --near <near> [--mode delivery|pickup] [--offset <offset>] [--limit <limit>]',
    description:
      'Search food and restaurants near the selected address. Returns ranked restaurants, matching items and server pagination metadata. Keep location, query and fulfillment mode unchanged while paging.',
    inputSchema: schema(
      {
        query: { type: 'string', minLength: 1 },
        near: coordinate,
        mode,
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      ['query', 'near'],
    ),
  },
  {
    name: 'eats_menu',
    command:
      'uber eats menu --store-id <storeId> --near <near> [--mode delivery|pickup] [--item-id <itemId>] [--section-id <sectionId>] [--subsection-id <subsectionId>] [--offset <offset>]',
    description:
      'Read a restaurant menu, or inspect one item and its nested customization choices. Preserve returned item, section and option identifiers when constructing a cart. Availability depends on location and fulfillment mode.',
    inputSchema: schema(
      {
        storeId: id,
        near: coordinate,
        mode,
        itemId: id,
        sectionId: id,
        subsectionId: id,
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
      ['storeId', 'near'],
    ),
  },
  {
    name: 'eats_cart',
    command:
      'uber eats cart --action list|get|create|add|update|remove|discard [--draft-id <draftId>] [--line-id <lineId>] [--store-id <storeId>] [--request <requestFile>] [--operation-id <operationId>]',
    description:
      'Manage a draft food cart without placing an order. Supply a JSON request file for creation or item changes; use the exact identifiers and nested selections returned by menu/item inspection. Inspect the draft after changes before preparing checkout. Reuse the same operationId to recover a mutation; do not create a new operation when its outcome is uncertain.',
    inputSchema: schema({
      action: {
        type: 'string',
        enum: ['list', 'get', 'create', 'add', 'update', 'remove', 'discard'],
        default: 'list',
      },
      draftId: id,
      lineId: id,
      storeId: id,
      operationId: { type: 'string', format: 'uuid' },
      requestFile: {
        type: 'string',
        description:
          'Path to a UTF-8 JSON object. Public cart fields include storeId, deliveryAddress, diningMode, items with itemId/sectionId/subsectionId/quantity/specialInstructions/customizationV2s, and line update fields quantity/specialInstructions/customizations.',
      },
    }),
  },
  {
    name: 'eats_checkout',
    command:
      'uber eats checkout --draft-id <draftId> --tip-amount <tipAmount> [--payment-profile-id <paymentProfileId>]',
    description:
      'Prepare a priced order plan for review without submitting it. Choose the tip explicitly, including zero; the decimal amount uses the server-returned checkout currency. Review items, address, payment, fees, tip and total before confirming the returned plan.',
    inputSchema: schema(
      {
        draftId: id,
        paymentProfileId: id,
        tipAmount: {
          type: 'string',
          pattern: '^(0|[1-9][0-9]*)(\\.[0-9]{1,2})?$',
          description:
            'Explicit nonnegative decimal amount in the checkout currency, such as "0" or "3.50".',
        },
      },
      ['draftId', 'tipAmount'],
    ),
  },
  {
    name: 'eats_order',
    command:
      'uber eats order --action confirm|status|history|cancel [--plan-id <planId>] [--order-id <orderId>] [--near <near>] [--limit <limit>] [--cursor <cursor>] [--confirm]',
    description:
      'Confirm a reviewed order plan, inspect one order or active orders, page through past orders, or prepare/confirm a cancellation. For cancellation, first provide orderId without confirm to inspect terms; submit only a returned cancellation planId with confirm. Cancellation remains unavailable when fee eligibility cannot be verified. Order confirmation can charge the selected payment method; require authorization for the specific order and total. For an uncertain mutation result, inspect its operation with uber eats operation --operation-id ID instead of retrying.',
    inputSchema: schema({
      action: {
        type: 'string',
        enum: ['confirm', 'status', 'history', 'cancel'],
        default: 'status',
      },
      planId: id,
      orderId: id,
      near: coordinate,
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
      cursor: {
        type: 'string',
        minLength: 1,
        description: 'Opaque continuation cursor returned by order history.',
      },
      confirm: { type: 'boolean', default: false },
    }),
  },
];

export const eatsToolManifest = {
  name: 'uber-eats',
  version: 1,
  transport: 'CLI',
  output: 'JSON on stdout; errors are handled by the parent Uber CLI.',
  authentication:
    'Shares the saved Uber CLI login. Use uber login and auth complete for verification-code login; no Android device or browser is required at runtime.',
  tools: eatsTools,
};
