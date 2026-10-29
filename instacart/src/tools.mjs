const text = { type: 'string', minLength: 1 };
const number = { type: 'number' };
const integer = { type: 'integer', minimum: 1, maximum: 100 };
const boolean = { type: 'boolean' };
const ids = { type: 'array', items: text, minItems: 1, maxItems: 100 };
const location = { postalCode: text, latitude: number, longitude: number, addressId: text };

function tool(name, command, description, properties = {}, required = [], authenticated = true, mutation = false) {
  return { name, command, description, authenticated, mutation,
    inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

export const tools = [
  tool('login', 'login', 'Start native phone or email verification. Choose exactly one destination. Reuses an unexpired pending code.',
    { phone: text, email: text, countryCallingCode: text, resend: boolean, replacePending: boolean }, [], false, true),
  tool('auth_complete', 'auth complete', 'Verify the pending code, validate the session, then save it privately.', { code: text }, [], false, true),
  tool('auth_status', 'auth status', 'Read local login state, without revealing session credentials.', {}, [], false),
  tool('auth_check', 'auth check', 'Validate the saved session against the customer API.'),
  tool('logout', 'logout', 'Remove local session credentials; does not revoke other devices.', {}, [], false, true),
  tool('account', 'account', 'Read the signed-in account identifier and account type.'),
  tool('addresses', 'addresses', 'List saved delivery addresses with zone identifiers.'),
  tool('stores', 'stores', 'Find delivery or pickup stores at coordinates and postal code. Optional name filtering.',
    { ...location, query: text, retailerIds: ids, serviceType: { enum: ['delivery', 'pickup'] } }, ['postalCode', 'latitude', 'longitude'], false),
  tool('shop', 'shop', 'Read a store and its retailer and fulfillment identifiers.', { shopId: text }, ['shopId'], false),
  tool('search', 'search', 'Search a store, returning structured products and a continuation cursor. Repeat the same search context with that cursor.',
    { shopId: text, postalCode: text, zoneId: text, query: text, limit: integer, cursor: { type: 'string', minLength: 1, maxLength: 1000000 }, includeAds: boolean }, ['shopId', 'postalCode', 'query']),
  tool('items', 'items', 'Retrieve products by their Instacart item IDs.', { shopId: text, ids, zoneId: text, postalCode: text }, ['shopId', 'ids']),
  tool('item', 'item', 'Retrieve product details, ingredients and nutrition where available.', { shopId: text, id: text, zoneId: text, postalCode: text }, ['shopId', 'id']),
  tool('prices', 'prices', 'Read location-specific prices for products.', { shopId: text, zoneId: text, postalCode: text, ids }, ['shopId', 'zoneId', 'postalCode', 'ids']),
  tool('carts', 'carts', 'List the account’s carts.', { limit: integer, empty: boolean, shopId: text }),
  tool('cart_get', 'cart get', 'Read a cart. Supply shopId and postalCode together to include an estimated item subtotal; final checkout fees are separate.', { cartId: text, shopId: text, postalCode: text, includeTotals: boolean }, ['cartId']),
  tool('cart_set', 'cart set', 'Set absolute item quantity. Zero removes the item. No order is placed.',
    { cartId: text, itemId: text, quantity: { type: 'number', minimum: 0, maximum: 1000 }, quantityType: { enum: ['each', 'weight'] }, specialInstructions: { type: 'string', maxLength: 4096 } }, ['cartId', 'itemId', 'quantity'], true, true),
  tool('orders', 'orders', 'List prior order deliveries with pagination.', { first: integer, after: text, addressId: text }),
  tool('order', 'order', 'Read delivery status and purchased items for an order.', { orderId: text }, ['orderId']),
  tool('checkout_prepare', 'checkout prepare', 'Prepare a checkout invoice showing items, fees, tip, payment, address and window. Returns a preview only; does not place an order.',
    { cartId: text, shopId: text, addressId: text, service: { enum: ['delivery', 'pickup'] } }, ['cartId', 'shopId', 'addressId'], true, true),
];

export function validateArguments(tool, input) {
  const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Tool input must be a JSON object.');
  for (const key of tool.inputSchema.required) if (input[key] === undefined) fail(`Missing required argument: ${key}.`);
  for (const [key, value] of Object.entries(input)) {
    const schema = tool.inputSchema.properties[key];
    if (!schema) fail(`Unknown argument: ${key}.`);
    if (schema.enum && !schema.enum.includes(value)) fail(`Invalid value for ${key}.`);
    if (schema.type === 'string' && (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 65536))) fail(`Invalid text for ${key}.`);
    if (schema.type === 'boolean' && typeof value !== 'boolean') fail(`${key} must be true or false.`);
    if (['number', 'integer'].includes(schema.type) && (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) fail(`Invalid number for ${key}.`);
    if (schema.type === 'array' && (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems || value.some(item => typeof item !== 'string' || !item))) fail(`${key} must be a nonempty list of IDs.`);
  }
  return input;
}
