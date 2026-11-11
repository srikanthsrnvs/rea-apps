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

export const legacyEatsTools = [
  {
    name: 'eats_track',
    command:
      'uber eats track --order-id <orderId> [--action snapshot|stream|serve] [--after <cursor>] [--duration <seconds>] [--host <host>] [--port <port>] [--public-url <url>] [--frame-origin <origin>]',
    description:
      'Track one selected food delivery. Snapshot returns native status, ETA, restaurant, courier, map geometry and recent lifecycle events. Stream emits NDJSON snapshots and delivery events; resume using the last numeric event cursor. Serve returns an expiring read-only iframe map URL and authenticated SSE events, and stays running. Uses saved Uber credentials; requires no server browser or Android. Delivery completion is verified, never inferred from disappearance. No messages, tips or order mutations are sent.',
    inputSchema: schema(
      {
        orderId: { type: 'string', format: 'uuid' },
        action: {
          type: 'string',
          enum: ['snapshot', 'stream', 'serve'],
          default: 'snapshot',
        },
        after: { type: 'integer', minimum: 0 },
        duration: { type: 'integer', minimum: 10, maximum: 86400 },
        host: { type: 'string' },
        port: { type: 'integer', minimum: 0, maximum: 65535 },
        publicUrl: { type: 'string', format: 'uri' },
        frameOrigin: {
          type: 'array',
          items: { type: 'string', format: 'uri' },
        },
      },
      ['orderId'],
    ),
  },
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

const baseManifest = {
  name: 'uber-eats',
  version: 1,
  transport: 'CLI',
  output: 'JSON on stdout; errors are handled by the parent Uber CLI.',
  authentication:
    'Shares the saved Uber CLI login. Use uber login and auth complete for verification-code login; no Android device or browser is required at runtime.',
  tools: legacyEatsTools,
};

const customization = {
  type: 'array',
  maxItems: 100,
  items: {
    type: 'object',
    required: ['uuid', 'childOptions'],
    properties: {
      uuid: id,
      childOptions: {
        type: 'object',
        required: ['options'],
        properties: {
          options: {
            type: 'array',
            maxItems: 100,
            items: {
              type: 'object',
              required: ['uuid', 'quantity'],
              properties: {
                uuid: id,
                quantity: { type: 'integer', minimum: 0 },
                customizationV2List: {
                  type: 'array',
                  items: { type: 'object', additionalProperties: true },
                },
              },
              additionalProperties: true,
            },
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: true,
  },
};
const cartItem = schema(
  {
    itemId: id,
    sectionId: id,
    subsectionId: id,
    choices: {
      type: 'array',
      maxItems: 100,
      description:
        'Preferred: exact group/option names from item detail. Overrides that group; unspecified groups keep verified native defaults. Quantities are per drink/item. Empty array requests the standard recipe.',
      items: schema(
        {
          group: id,
          option: id,
          quantity: { type: 'integer', minimum: 0, default: 1 },
          path: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Ancestor group/option path, optionally ending with this group name. Only needed when names are ambiguous.',
          },
        },
        ['group', 'option'],
      ),
    },
    quantity: { type: 'integer', minimum: 1 },
    specialInstructions: {
      type: 'string',
      maxLength: 2000,
      description:
        'Literal kitchen/preparation requests from the user. These are requests, not guaranteed recipe changes.',
    },
    customizationV2s: customization,
    customizations: customization,
  },
  ['itemId', 'sectionId', 'quantity'],
);
const cartRequest = schema({
  storeId: id,
  diningMode: {
    type: 'string',
    enum: ['delivery', 'pickup', 'DELIVERY', 'PICKUP'],
  },
  deliveryAddress: {
    type: 'object',
    required: ['latitude', 'longitude'],
    properties: {
      latitude: { type: 'number', minimum: -90, maximum: 90 },
      longitude: { type: 'number', minimum: -180, maximum: 180 },
      address: { type: 'object', additionalProperties: true },
    },
    additionalProperties: true,
    description:
      'Copy the complete selected address from eats_locations, including latitude and longitude. Never invent address details.',
  },
  paymentProfileId: id,
  items: { type: 'array', minItems: 1, maxItems: 100, items: cartItem },
  lineId: id,
  quantity: { type: 'integer', minimum: 0 },
  specialInstructions: { type: 'string', maxLength: 2000 },
  customizations: customization,
  customizationV2s: customization,
});
const rawView = {
  type: 'boolean',
  description:
    'Return the complete native response when additional fields are needed. Default false uses the compact agent view.',
};
const operationTool = {
  name: 'eats_operation',
  command: 'uber eats operation --operation-id <operationId>',
  description:
    'Read a recorded mutation result after interruption or uncertainty. Use the exact operationId returned by the failed call. Unknown/submitting means the operation may have succeeded: do not resend with a new ID, clear a cart, or claim failure/success. This tool does not mutate anything.',
  inputSchema: schema({ operationId: { type: 'string', format: 'uuid' } }, [
    'operationId',
  ]),
};
export const advancedEatsToolManifest = {
  ...baseManifest,
  profile: 'advanced',
  tools: [...legacyEatsTools, operationTool],
};
export const eatsTools = [
  ...legacyEatsTools.map((tool) => {
    if (tool.name === 'eats_cart')
      return {
        ...tool,
        command:
          'uber eats cart --action ACTION --json REQUEST_JSON [--draft-id ID --line-id ID --operation-id ID]',
        description:
          'Manage a food cart without buying. Preferred flat arguments for create: action, storeId, diningMode, deliveryAddress, items. Copy address from eats_locations. Read item options first; items use itemId, sectionId, quantity, choices:[{group:"Size",option:"Large 16 oz"},{group:"Milk",option:"Oat Milk"}], and literal specialInstructions. Use exact displayed names; the CLI resolves current IDs and nested choices and validates availability before writes. Unspecified groups retain native defaults. Choice quantities are per item: two shots per drink means quantity:2 even for three drinks. To update only quantity, use action:update, draftId, lineId, quantity:3 (THREE TOTAL), preserving other choices/lines; no model search/menu/get needed. Errors are not success: never claim a cart is ready without a successful cart response. Unknown outcome: eats_operation with returned operationId; do not retry. Checkout is separate.',
        inputSchema: {
          ...tool.inputSchema,
          properties: {
            action: tool.inputSchema.properties.action,
            draftId: id,
            lineId: id,
            operationId: tool.inputSchema.properties.operationId,
            ...cartRequest.properties,
          },
        },
      };
    if (tool.name === 'eats_search')
      return {
        ...tool,
        inputSchema: {
          ...tool.inputSchema,
          properties: {
            ...tool.inputSchema.properties,
            limit: { ...tool.inputSchema.properties.limit, default: 5 },
            raw: rawView,
          },
        },
        command: tool.command + ' --compact',
        description:
          tool.description +
          ' Agent view defaults to five feed entries per page, retaining all returned item/store identities and paging information. Use nextOffset for more results; limit can be increased when needed. Use a small shortlist; do not copy a whole menu to the user. Ingredient claims and customization defaults require eats_menu item detail. Menu prices exclude final fees/tip; never call them checkout totals.',
      };
    if (tool.name === 'eats_menu')
      return {
        ...tool,
        inputSchema: {
          ...tool.inputSchema,
          properties: { ...tool.inputSchema.properties, raw: rawView },
        },
        command: tool.command + ' --compact',
        description:
          tool.description +
          ' Agent view preserves the entire nested choice hierarchy and constraints without duplicate raw DTOs. Copy standardItem for a regular recipe only when standardSelectionsVerified:true; prefer named choices for custom orders. Otherwise ask about required choices; do not guess or use maximum counts as defaults. Prices are menu prices, not a confirmed checkout total.',
      };
    return tool;
  }),
  operationTool,
];
export const eatsToolManifest = {
  ...baseManifest,
  profile: 'agent',
  advancedTools: 'uber eats tools --advanced',
  tools: eatsTools,
};
