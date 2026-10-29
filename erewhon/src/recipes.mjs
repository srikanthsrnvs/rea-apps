import * as disk from './state.mjs';
import { authenticatedOperation } from './http.mjs';
import { createCatalog } from './catalog.mjs';
import { createOrdering } from './ordering.mjs';
import { cartRows, endpoints, cartBinding, fingerprint, ownerBinding, fail } from './ordering-protocol.mjs';
import { normalizeLabel, productOptions } from './product-choices.mjs';

const blocked = new Set(['submitting', 'uncertain', 'additional_auth_required', 'pending']);
function nameKey(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) fail('INVALID_ARGUMENT', 'Recipe names use lowercase letters, numbers and hyphens.');
  return `recipe-${name}`;
}
function only(object, keys, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(key => !keys.includes(key))) fail('INVALID_RECIPE', `Invalid ${label}; use named product choices, not native IDs.`);
}
function text(value, label) { if (typeof value !== 'string' || !value.trim() || value.length > 500) fail('INVALID_RECIPE', `Supply ${label}.`); }
export function validateRecipe(recipe) {
  only(recipe, ['product', 'quantity', 'size', 'choices', 'instruction', 'fulfillment', 'redeemPoints', 'paymentLast4'], 'recipe');
  only(recipe.product, ['name', 'brand', 'sku'], 'product');
  text(recipe.product.name, 'the exact catalog product name');
  for (const key of ['brand', 'sku']) if (recipe.product[key] !== undefined) text(recipe.product[key], key);
  if (!Number.isFinite(recipe.quantity ?? 1) || (recipe.quantity ?? 1) <= 0 || (recipe.quantity ?? 1) > 1000) fail('INVALID_RECIPE', 'Supply a positive quantity no greater than 1000.');
  if (recipe.size !== undefined) text(recipe.size, 'a named size');
  if (!Array.isArray(recipe.choices ?? []) || (recipe.choices ?? []).length > 100) fail('INVALID_RECIPE', 'choices must be an array.');
  for (const choice of recipe.choices ?? []) {
    only(choice, ['group', 'option', 'count'], 'modifier choice');
    text(choice.group, 'a modifier group name'); text(choice.option, 'a modifier option name');
    if (!Number.isInteger(choice.count ?? 1) || (choice.count ?? 1) < 1 || (choice.count ?? 1) > 100) fail('INVALID_RECIPE', 'Modifier counts must be positive integers.');
  }
  if (recipe.instruction !== undefined && (typeof recipe.instruction !== 'string' || recipe.instruction.length > 2000)) fail('INVALID_RECIPE', 'Instructions must be text of at most 2000 characters.');
  only(recipe.fulfillment, ['type', 'store', 'addressId'], 'fulfillment');
  if (recipe.fulfillment.type === 'pickup') { text(recipe.fulfillment.store, 'a pickup store name'); if (recipe.fulfillment.addressId) fail('INVALID_RECIPE', 'Pickup does not use a delivery address.'); }
  else if (recipe.fulfillment.type === 'delivery') text(recipe.fulfillment.addressId, 'an existing delivery address ID');
  else fail('INVALID_RECIPE', 'Choose pickup or delivery.');
  if (recipe.redeemPoints !== undefined && recipe.redeemPoints !== false) fail('INVALID_RECIPE', 'Recipes support redeemPoints:false; spending rewards requires an explicit checkout review.');
  if (recipe.paymentLast4 !== undefined && !/^\d{4}$/.test(recipe.paymentLast4)) fail('INVALID_RECIPE', 'paymentLast4 must be four digits.');
  return structuredClone({ ...recipe, quantity: recipe.quantity ?? 1, choices: recipe.choices ?? [], redeemPoints: false });
}

function candidates(data, output = []) {
  if (Array.isArray(data)) data.forEach(value => candidates(value, output));
  else if (data && typeof data === 'object') {
    if (data._id && data.name) output.push(data);
    Object.values(data).forEach(value => { if (value && typeof value === 'object') candidates(value, output); });
  }
  return output;
}
function selectionDigest(groups) {
  if(typeof groups==='string'){try{groups=JSON.parse(groups);}catch{fail('CART_ADDITION_UNVERIFIED','The cart returned unreadable modifier selections.');}}
  return fingerprint((groups??[]).flatMap(group=>(group.modifiers??[]).filter(item=>item.is_selected===true||Number(item.count??item.quantity)>0).map(item=>({group:group._id,item:item._id,count:Number(item.count??item.quantity??1)}))).sort((a,b)=>`${a.group}:${a.item}`.localeCompare(`${b.group}:${b.item}`)));
}
function rowDigest(response) { return fingerprint(cartRows(response).filter(row => row.quantity > 0).map(row=>({row:row.cart_product_id,quantity:row.quantity,name:row.product?.name,sku:row.product?.sku,size:row.modifier_size_id,modifiers:row.selected_modifiers,description:row.selected_modifiers_desc,instruction:row.product_instruction}))); }

export function createRecipes({ operation = authenticatedOperation, store = disk, now = () => new Date(), fetchImpl = fetch } = {}) {
  async function save({ name, recipe }) {
    const key = nameKey(name), specification = validateRecipe(recipe);
    await store.withStateLock(async () => store.saveState(key, { version: 1, name, specification }));
    return { status: 'saved', name, recipe: specification, next: `erewhon order prepare --recipe ${name}`, orderPlaced: false };
  }
  async function show({ name }) {
    const record = await store.readState(nameKey(name));
    if (!record?.specification) fail('RECIPE_NOT_FOUND', 'No such recipe. Save one before preparing it.');
    return { name, recipe: validateRecipe(record.specification) };
  }
  async function options({ productRef }) {
    return operation(async context => {
      const catalog = createCatalog({ operation: fn => fn(context), store, now, fetchImpl });
      const detail = await catalog.product({ productId: productRef });
      if (!detail.product) fail('PRODUCT_NOT_FOUND', 'No current product exists for this catalog reference. Search by name again.');
      return productOptions(detail.product);
    });
  }
  async function find({ query }) {
    text(query, 'a product search query');
    return operation(async context => {
      const catalog = createCatalog({ operation: fn => fn(context), store, now, fetchImpl });
      await catalog.loadCart(context);
      const result = await catalog.search({ query, limit: 20 });
      return { products: result.items.map(item => ({ name: item.ProductName, brand: item.BrandName, sku: item.SKU,
        productRef: String(item.ECRSID ?? item.objectID), referenceKind: 'catalog_reference', price: item.DisplayPrice, hasOptions: item.has_modifier })),
        status:'search_results_only',orderPrepared:false,orderPlaced:false,nextTool:'product_options',next: 'Read product options for this reference, then call order_prepare with exact labels. Search prices are not checkout totals. Never invent a total or native IDs.', hasMore: result.hasMore };
    });
  }
  async function prepare({ name, checkoutOptions = {} }) {
    nameKey(name);
    return operation(async context => {
      let active = await store.readState('order-active');
      if(active&&blocked.has(active.status)){const recorded=await store.readState(`order-operation-${active.operationId}`);if(recorded&&['confirmed','rejected'].includes(recorded.status)){active=recorded;await store.saveState('order-active',recorded);}}
      if (active && blocked.has(active.status)) fail('ORDER_UNRESOLVED', 'Resolve the recorded order operation before preparing another recipe.');
      const { recipe } = await show({ name });
      const unlocked = fn => fn(context);
      const catalog = createCatalog({ operation: unlocked, store, now, fetchImpl });
      const ordering = createOrdering({ operation: unlocked, store });
      let cart = await catalog.loadCart(context);
      let contents = await context.send(endpoints.cart, { form: cartBinding(cart), readOnly: true });
      const journalName = `recipe-draft-${name}`;
      const previous = await store.readState(journalName);
      const intent = fingerprint({ recipe, owner: ownerBinding(context.session) });
      const rows = cartRows(contents).filter(row => row.quantity > 0);
      const reusable = previous?.status === 'cart_ready' && previous.intent === intent
        && previous.cartId === cart.cartId && previous.digest === rowDigest(contents) && rows.length > 0;
      if (previous?.status === 'adding' || previous?.status === 'uncertain') fail('RECIPE_DRAFT_UNRESOLVED', 'A prior recipe addition may have succeeded. Inspect the cart; no addition or payment was repeated.');
      if (rows.length && !reusable) fail('CART_NOT_EMPTY', 'The cart already contains items outside this unchanged recipe draft. Review it before proceeding; nothing was replaced.');
      if (!reusable) {
        if (recipe.fulfillment.type === 'pickup') {
          const listing = await catalog.stores();
          const matches = [...new Map(candidates(listing).filter(value => normalizeLabel(value.name) === normalizeLabel(recipe.fulfillment.store)).map(value => [value._id, value])).values()];
          if (matches.length !== 1) fail('STORE_AMBIGUOUS', 'The requested pickup store is missing or ambiguous. Read stores and update the recipe.');
          await catalog.selectFulfillment({ type: 'pickup', storeId: matches[0]._id });
        } else await catalog.selectFulfillment({ type: 'delivery', addressId: recipe.fulfillment.addressId });
        // Fulfillment changes may switch carts. Never overwrite an occupied one.
        cart = await catalog.loadCart(context);
        contents = await context.send(endpoints.cart, { form: cartBinding(cart), readOnly: true });
        if (cartRows(contents).some(row => row.quantity > 0)) fail('CART_NOT_EMPTY', 'The selected fulfillment has an occupied cart. Review it before preparing this recipe.');
        const matches = new Map();
        for (let page = 0; ; page++) {
          const result = await catalog.search({ query: recipe.product.name, page, limit: 100 });
          for (const item of result.items) if (normalizeLabel(item.ProductName) === normalizeLabel(recipe.product.name)
            && (!recipe.product.brand || normalizeLabel(item.BrandName) === normalizeLabel(recipe.product.brand))
            && (!recipe.product.sku || item.SKU === recipe.product.sku)) matches.set(String(item.ECRSID ?? item.objectID), item);
          if (!result.hasMore) break;
          if (page >= 19) fail('PRODUCT_AMBIGUOUS', 'This search is too broad. Add the exact brand and SKU to the recipe.');
        }
        if (matches.size !== 1) fail(matches.size?'PRODUCT_AMBIGUOUS':'PRODUCT_NOT_FOUND',matches.size?'Multiple current catalog entries match this recipe. No item was added.':'No current catalog entry matches this exact recipe. No item was added.',{orderPrepared:false,orderPlaced:false,reason:matches.size?'multiple_matches':'not_found',candidates:[...matches].map(([productRef,item])=>({productRef,name:item.ProductName,brand:item.BrandName,sku:item.SKU})),nextAction:'Ask the user to clarify the intended product. Do not suggest any alternative products or prices unless another tool actually returned them. Do not claim an item was absent when multiple matches were returned.'});
        const [productRef] = matches.keys();
        const journal = { status: 'adding', intent, cartId: cart.cartId, startedAt: now().toISOString() };
        let submitted = false;
        try {
          await ordering.addCartItem({ productId: productRef, expectedName: recipe.product.name, quantity: recipe.quantity,
            size: recipe.size, choices: recipe.choices, instruction: recipe.instruction,
            beforeAdd: async selection => { journal.expectedSelection={size:selection.modifierSizeId,modifiers:selectionDigest(selection.selectedModifiers)};await store.saveState(journalName, journal); submitted = true; } });
          contents = await ordering.cart();
          const added = cartRows(contents).filter(row => row.quantity > 0);
          if (added.length !== 1 || added[0].quantity !== recipe.quantity
            || normalizeLabel(added[0].product?.name) !== normalizeLabel(recipe.product.name)
            || (recipe.product.sku && added[0].product?.sku !== recipe.product.sku)) fail('CART_ADDITION_UNVERIFIED', 'The cart did not confirm the requested recipe item. Inspect it before proceeding.');
          if(added[0].modifier_size_id!==journal.expectedSelection.size||selectionDigest(added[0].selected_modifiers)!==journal.expectedSelection.modifiers)fail('CART_ADDITION_UNVERIFIED','The cart did not retain the exact requested size and modifiers. Inspect it before proceeding.');
          journal.status = 'cart_ready'; journal.digest = rowDigest(contents);
          journal.cartId = (await store.readState('cart')).cartId;
          await store.saveState(journalName, journal);
        } catch (error) {
          if(submitted){journal.status = 'uncertain'; await store.saveState(journalName, journal);}throw error;
        }
      }
      const quote = await ordering.checkout();
      const asap = quote.schedule_types?.filter(value => value.type === 'schedule_asap');
      if (asap?.length !== 1) fail('ASAP_UNAVAILABLE', 'The server did not offer one unambiguous ASAP option. Review checkout manually.');
      const prepared = await ordering.prepareOrder({ ...checkoutOptions, scheduleTypeId: asap[0]._id, redeem: false });
      if (recipe.paymentLast4 && prepared.review.payment.last4 !== recipe.paymentLast4) fail('PAYMENT_CHANGED', 'The selected saved card does not match this recipe. Review checkout and select the correct card.');
      const { cart: ignoredCart, products, ...terms } = prepared.review;
      const review = { ...terms, products: products.map(item => ({
        name: item.product?.name, quantity: item.quantity, size: recipe.size,
        choices: recipe.choices, description: item.modifierDescription,
        instruction: item.instruction, linePrice: item.linePrice,
      })) };
      return { ...prepared, orderPrepared:true, review, recipe: name, nextAction: 'show_review_then_confirm_after_user_approval',
        confirmCommand: `erewhon order confirm --plan-id ${prepared.planId} --confirm`,
        statusCommand: `erewhon order status --plan-id ${prepared.planId}` };
    });
  }
  async function reset({name}) {
    const key=nameKey(name);
    return operation(async context=>{
      const catalog=createCatalog({operation:fn=>fn(context),store,now,fetchImpl});
      const cart=await catalog.loadCart(context);
      const response=await context.send(endpoints.cart,{form:cartBinding(cart),readOnly:true});
      if(cartRows(response).some(row=>row.quantity>0))fail('CART_NOT_EMPTY','Inspect and remove the previous recipe item before resetting its draft.');
      await store.saveState(`recipe-draft-${name}`,null);
      return {status:'reset',name,orderPlaced:false};
    });
  }
  async function prepareRequest({request,checkoutOptions={}}) {
    const specification=validateRecipe(request);
    const name=`draft-${fingerprint(specification).slice(0,24)}`;
    await save({name,recipe:specification});
    return prepare({name,checkoutOptions});
  }
  return { save, show, find, options, prepare, prepareRequest, reset };
}

export const recipes = createRecipes();
