import { createRecipes } from '../../src/recipes.mjs';
import { createOrdering } from '../../src/ordering.mjs';
export const recipe = { product: { name: 'Cappuccino', brand: 'Erewhon', sku: 'coffee-sku' }, quantity: 1, size: 'Large 16 oz',
  choices: [{ group: 'Milk', option: 'Whole Milk' }], fulfillment: { type: 'pickup', store: 'Venice' } };
const clone = value => structuredClone(value);

export function fixture() {
  const records = new Map(), calls = [];
  const f = { rotation: 'one', rows: [], dropAdd: false, ambiguous: false };
  const session = { token: 'test-token', deviceId: 'test-device', account: { id: 'test-account' } };
  const store = { readState: async name => clone(records.get(name) ?? null), saveState: async (name, value) => records.set(name, clone(value)), withStateLock: fn => fn() };
  const storeData = { _id: 'venice-store', name: 'Venice', time_zone: 'America/Los_Angeles', algolia: { search_index: 'VEN_SEARCH_INDEX' } };
  const product = () => ({ _id: `native-${f.rotation}`, internal_product_id: `catalog-${f.rotation}`, name: 'Cappuccino', sku: 'coffee-sku',
    modifier_size: [{ _id: `size-${f.rotation}`, name: 'Large 16 oz', modifier_groups: { modifier_sets: [{ _id: `milk-${f.rotation}`, name: 'Milk', required: 'true', minimum: 1, maximum: 1, type: 'radio', modifiers: [{ _id: `whole-${f.rotation}`, name: 'Whole Milk', maximum: 1 }] }] } }] });
  const quote = { error: 0, allow_checkout: true, order_type: 'pickup', payment_process_type: 'erewhon',
    cart_amount_dtls: { order_total: '9.97' }, schedule_types: [{ _id: 'asap', type: 'schedule_asap', is_selected: true, order_time: { time: 'ASAP', is_default: true } }],
    default_payment_method: { id: 'pm-test', brand: 'mastercard', last4: '1234' } };
  async function send(path, options = {}) {
    calls.push({ path, ...clone(options) });
    if (path === '/v1/ordermethod') return { error: 0, cart_id: 'cart-one', all_cart_types: [{ _id: 'primary', type: 'primary' }], store: storeData, order_type: 'pickup' };
    if (path === '/v1/usercart') return { error: 0, cart: { allow_checkout: true, all_product_available: true, departments: [{ products: clone(f.rows) }] } };
    if (path === '/v1/stores') return { error: 0, stores: [storeData] };
    if (['/v1/default_stores', '/v1/select_ordermethod', '/v1/validate_cart'].includes(path)) return { error: 0 };
    if (path === '/v1/getproduct') return { error: 0, product: product() };
    if (path.startsWith('/v1/addtocart/')) {
      f.rows = [{ _id: `row-${f.rotation}`, cart_product_id: `cp-${f.rotation}`, product: product(), quantity: options.form.product_quantity,
        modifier_size_id: options.form.modifier_size_id, selected_modifiers: options.form.modifier_sets }];
      if (f.dropSelections) f.rows[0].selected_modifiers=[];
      if (f.dropAdd) throw new Error('Connection lost after addition');
      return { error: 0 };
    }
    if (path === '/v1/checkout_details') return clone(quote);
    if (path === '/v1/place_order') {if(f.dropPlace)throw new Error('Lost payment response');return { error: 0, order: { _id: 'server-order' } };}
    if (path === '/v1/get_order_place') {if(f.reconcilePending)return {error:2};return { error: 0, order: { _id: 'server-order' } };}
    throw new Error(`Unexpected endpoint ${path}`);
  }
  let queue=Promise.resolve();
  const enqueue=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
  store.withStateLock=enqueue;
  const operation = fn => enqueue(()=>fn({ session, send }));
  const fetchImpl = async () => ({ ok: true, json: async () => ({ page: 0, nbPages: 1, hits: [
    { ProductName: 'Cappuccino', BrandName: 'Erewhon', SKU: 'coffee-sku', ECRSID: `catalog-${f.rotation}` },
    ...(f.ambiguous ? [{ ProductName: 'Cappuccino', BrandName: 'Erewhon', SKU: 'coffee-sku', ECRSID: 'other-catalog' }] : []),
  ] }) });
  return Object.assign(f, { api: createRecipes({ store, operation, fetchImpl }), ordering: createOrdering({ store, operation }), records, calls, session, dependencies:{store,operation,fetchImpl} });
}

