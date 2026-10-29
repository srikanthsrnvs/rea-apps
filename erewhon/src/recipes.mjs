import * as disk from './state.mjs';
import { authenticatedOperation } from './http.mjs';
import { createCatalog } from './catalog.mjs';
import { createOrdering } from './ordering.mjs';
import { cartRows, endpoints, cartBinding, fingerprint, ownerBinding, fail, publicData } from './ordering-protocol.mjs';
import { normalizeLabel, productOptions, productFacts } from './product-choices.mjs';

const blocked = new Set(['submitting', 'uncertain', 'additional_auth_required', 'pending']);
function nameKey(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) fail('INVALID_ARGUMENT', 'Recipe names use lowercase letters, numbers and hyphens.');
  return `recipe-${name}`;
}
function savedName(value) {
  if(typeof value!=='string'||value.length>100)fail('INVALID_ARGUMENT','Supply a saved recipe name.');
  const name=value.trim().toLowerCase().replace(/^my\s+/, '').replace(/\s+/g,'-');
  nameKey(name);return name;
}
function only(object, keys, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(key => !keys.includes(key))) fail('INVALID_RECIPE', `Invalid ${label}; use named product choices, not native IDs.`);
}
function text(value, label) { if (typeof value !== 'string' || !value.trim() || value.length > 500) fail('INVALID_RECIPE', `Supply ${label}.`); }
const itemKeys = ['product', 'quantity', 'size', 'choices', 'instruction'];
function validateItem(item) {
  only(item, itemKeys, 'basket item');
  only(item.product, ['name', 'brand', 'sku'], 'product');
  text(item.product.name, 'the exact catalog product name');
  for (const key of ['brand', 'sku']) if (item.product[key] !== undefined) text(item.product[key], key);
  if (!Number.isFinite(item.quantity ?? 1) || (item.quantity ?? 1) <= 0 || (item.quantity ?? 1) > 1000) fail('INVALID_RECIPE', 'Supply a positive quantity no greater than 1000.');
  if (item.size !== undefined) text(item.size, 'a named size');
  if (!Array.isArray(item.choices ?? []) || (item.choices ?? []).length > 100) fail('INVALID_RECIPE', 'choices must be an array.');
  for (const choice of item.choices ?? []) {
    only(choice, ['group', 'option', 'count'], 'modifier choice');
    text(choice.group, 'a modifier group name'); text(choice.option, 'a modifier option name');
    if (!Number.isInteger(choice.count ?? 1) || (choice.count ?? 1) < 1 || (choice.count ?? 1) > 100) fail('INVALID_RECIPE', 'Modifier counts must be positive integers.');
  }
  if (item.instruction !== undefined && (typeof item.instruction !== 'string' || item.instruction.length > 2000)) fail('INVALID_RECIPE', 'Instructions must be text of at most 2000 characters.');
  return structuredClone({ ...item, quantity: item.quantity ?? 1, choices: item.choices ?? [] });
}
export const recipeItems = recipe => recipe.items ?? [Object.fromEntries(itemKeys.filter(key => recipe[key] !== undefined).map(key => [key, recipe[key]]))];
// Flat tool arguments avoid nested request/fulfillment objects for small models.
export function agentRequest(args) {
  only(args,['items','pickupStore','deliveryAddressId','paymentLast4'],'ordering tool arguments');
  if(!Array.isArray(args.items)||!args.items.length)fail('INVALID_RECIPE','Supply items:[{name,quantity,size,choices}] and pickupStore OR deliveryAddressId.');
  if(Boolean(args.pickupStore)===Boolean(args.deliveryAddressId))fail('INVALID_RECIPE','Supply exactly one of pickupStore or deliveryAddressId.');
  const items=args.items.map(item=>{
    only(item,['name','brand','sku','quantity','size','choices','instruction'],'ordering tool item');
    const {name,brand,sku,...rest}=item;
    return {...rest,product:{name,...(brand?{brand}:{}),...(sku?{sku}:{})}};
  });
  return {items,fulfillment:args.pickupStore?{type:'pickup',store:args.pickupStore}:{type:'delivery',addressId:args.deliveryAddressId},...(args.paymentLast4!==undefined?{paymentLast4:args.paymentLast4}:{})};
}
export function validateRecipe(recipe) {
  only(recipe, [...itemKeys, 'items', 'fulfillment', 'redeemPoints', 'paymentLast4'], 'recipe');
  const basket = recipe.items !== undefined;
  let items;
  if (basket) {
    if (itemKeys.some(key => recipe[key] !== undefined) || !Array.isArray(recipe.items) || !recipe.items.length || recipe.items.length > 30) fail('INVALID_RECIPE', 'Supply either one product or items (1–30 basket lines), not both.');
    items = recipe.items.map(validateItem);
    // Identical lines represent more of the same item; different customizations
    // stay separate. This avoids depending on native cart merging behavior.
    const merged = new Map();
    for (const item of items) {
      const key = fingerprint({ ...item, quantity: undefined, choices: [...item.choices].sort((a,b) => fingerprint(a).localeCompare(fingerprint(b))) });
      if (merged.has(key)) merged.get(key).quantity += item.quantity;
      else merged.set(key, item);
      if (merged.get(key).quantity > 1000) fail('INVALID_RECIPE', 'Combined quantity exceeds 1000.');
    }
    items = [...merged.values()];
  } else items = [validateItem(Object.fromEntries(itemKeys.filter(key => recipe[key] !== undefined).map(key => [key, recipe[key]])))];
  only(recipe.fulfillment, ['type', 'store', 'addressId'], 'fulfillment');
  if (recipe.fulfillment.type === 'pickup') { text(recipe.fulfillment.store, 'a pickup store name'); if (recipe.fulfillment.addressId) fail('INVALID_RECIPE', 'Pickup does not use a delivery address.'); }
  else if (recipe.fulfillment.type === 'delivery') { text(recipe.fulfillment.addressId, 'an existing delivery address ID'); if(recipe.fulfillment.store)fail('INVALID_RECIPE','Delivery uses an existing address, not a pickup store.'); }
  else fail('INVALID_RECIPE', 'Choose pickup or delivery.');
  if (recipe.redeemPoints !== undefined && recipe.redeemPoints !== false) fail('INVALID_RECIPE', 'Recipes support redeemPoints:false; spending rewards requires an explicit checkout review.');
  if (recipe.paymentLast4 !== undefined && !/^\d{4}$/.test(recipe.paymentLast4)) fail('INVALID_RECIPE', 'paymentLast4 must be four digits.');
  return structuredClone({ ...(basket ? {items} : items[0]), fulfillment: recipe.fulfillment, redeemPoints: false, ...(recipe.paymentLast4 !== undefined ? {paymentLast4:recipe.paymentLast4} : {}) });
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
function rowDigest(response) { return fingerprint(cartRows(response).filter(row => row.quantity > 0).map(row=>({row:row.cart_product_id,quantity:row.quantity,name:row.product?.name,sku:row.product?.sku,size:row.modifier_size_id,modifiers:row.selected_modifiers,description:row.selected_modifiers_desc,instruction:row.product_instruction})).sort((a,b)=>String(a.row).localeCompare(String(b.row)))); }

function fulfillmentMatches(recipe,type,store,address) {
 return type===recipe.fulfillment.type && (type==='pickup'
  ? normalizeLabel(store?.name)===normalizeLabel(recipe.fulfillment.store)
  : String(address?.address_id??address?.id??'')===recipe.fulfillment.addressId);
}

function matchRows(recipe, expected, rows) {
  const remaining = recipeItems(recipe).map((item,index) => ({item, selection:expected[index]}));
  if (remaining.length !== rows.length) fail('CART_ADDITION_UNVERIFIED','The cart did not confirm every requested basket line. Inspect it before proceeding.');
  return rows.map(row => {
    const index = remaining.findIndex(({item,selection}) => selection && row.quantity === item.quantity
      && normalizeLabel(row.product?.name) === normalizeLabel(item.product.name)
      && (!item.product.sku || row.product?.sku === item.product.sku)
      && (row.modifier_size_id ?? undefined) === (selection.size ?? undefined) && selectionDigest(row.selected_modifiers) === selection.modifiers
      && (row.product_instruction ?? '') === (item.instruction ?? ''));
    if (index < 0) fail('CART_ADDITION_UNVERIFIED','The cart did not retain the exact requested products, quantities, sizes, modifiers and instructions. Inspect it before proceeding.');
    return remaining.splice(index,1)[0].item;
  });
}

export function createRecipes({ operation = authenticatedOperation, store = disk, now = () => new Date(), fetchImpl = fetch } = {}) {
  async function save({ name, recipe }) {
    const key = nameKey(name), specification = validateRecipe(recipe);
    await store.withStateLock(async () => store.saveState(key, { version: 1, name, specification }));
    return { status: 'saved', name, recipe: specification, next: `erewhon order prepare --recipe ${name}`, orderPlaced: false };
  }
  async function show({ name }) {
    const record = await store.readState(nameKey(name));
    if (!record?.specification) fail('RECIPE_NOT_FOUND', 'No such recipe. Save one before preparing it.');
    return { status:'recipe_only', name, recipe:validateRecipe(record.specification), orderPrepared:false, orderPlaced:false, nextCall:{tool:'order_prepare_saved',arguments:{name}}, nextAction:'This only reads saved preferences. Call order_prepare_saved now for current availability, actual checkout total and a review plan. Do not claim this recipe is prepared.' };
  }
  async function options({ productRef }) {
    return operation(async context => {
      const catalog = createCatalog({ operation: fn => fn(context), store, now, fetchImpl });
      const detail = await catalog.product({ productId: productRef });
      if (!detail.product) fail('PRODUCT_NOT_FOUND', 'No current product exists for this catalog reference. Search by name again.');
      return productOptions(detail.product);
    });
  }
  async function find(args={}) {
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['query','queries','includeAddresses'].includes(key)))fail('INVALID_ARGUMENT','Discovery accepts queries and optional includeAddresses.');
    const {query,queries,includeAddresses=false}=args;
    if(typeof includeAddresses!=='boolean')fail('INVALID_ARGUMENT','includeAddresses must be a boolean.');
    if(query!==undefined&&queries!==undefined)fail('INVALID_ARGUMENT','Supply queries or query, not both.');
    const batch=queries!==undefined;
    const requested=batch?queries:[query];
    if(!Array.isArray(requested)||(!requested.length&&!includeAddresses)||requested.length>12)fail('INVALID_ARGUMENT','Supply up to 12 queries; an empty list is allowed only with includeAddresses:true.');
    requested.forEach(value=>text(value,'a product search query'));
    const unique=[...new Map(requested.map(value=>[normalizeLabel(value),value.trim()])).values()];
    return operation(async context => {
      const catalog=createCatalog({operation:fn=>fn(context),store,now,fetchImpl});
      const cart=await catalog.loadCart(context);
      const addressRequest=includeAddresses?context.send(endpoints.addresses,{form:cartBinding(cart),readOnly:true}).then(value=>({addresses:publicData(value).address})).catch(error=>({addressesError:{code:error.code??'ADDRESSES_FAILED',message:error.message}})):Promise.resolve({});
      const settled=await Promise.allSettled(unique.map(async searchQuery=>{
        const result=await catalog.search({query:searchQuery,limit:20});
        const exact=result.items.filter(item=>normalizeLabel(item.ProductName)===normalizeLabel(searchQuery));
        const selected=exact.length===1?exact[0]:result.items.length===1?result.items[0]:null;
        let options;
        // Bound native detail reads while giving broad searches a useful,
        // grounded shortlist in the same model tool call.
        const previews=selected?[selected]:result.items.slice(0,3);
        const details=await Promise.allSettled(previews.map(async hit=>{
          const detail=await context.send(endpoints.product,{form:{internal_product_id:String(hit.ECRSID??hit.objectID),cart_id:cart.cartId},readOnly:true});
          if(!detail.product)fail('PRODUCT_NOT_FOUND','No current details exist for this product.');
          if(normalizeLabel(detail.product.name)!==normalizeLabel(hit.ProductName)||(hit.SKU&&detail.product.sku!==hit.SKU))fail('PRODUCT_CHANGED','The current product differs from the search result. Search again before recommending it.');
          return detail.product;
        }));
        const facts=new Map();
        details.forEach((entry,index)=>{
          const ref=String(previews[index].ECRSID??previews[index].objectID);
          if(entry.status==='fulfilled'){
            facts.set(ref,{details:productFacts(entry.value)});
            if(selected)options=productOptions(entry.value);
          }else facts.set(ref,{detailsError:{code:entry.reason.code??'DETAILS_FAILED',message:entry.reason.message}});
        });
        const products=result.items.map(item=>({name:item.ProductName,brand:item.BrandName,sku:item.SKU,
          item:{name:item.ProductName,brand:item.BrandName??'',sku:item.SKU??'',quantity:1,choices:[],instruction:''},
          productRef:String(item.ECRSID??item.objectID),referenceKind:'catalog_reference',hasOptions:item.has_modifier,
          ...facts.get(String(item.ECRSID??item.objectID))}));
        return {query:searchQuery,...(options?{options}:{}),products,
          status:'search_results_only',orderPrepared:false,orderPlaced:false,
          nextTool:options||products.length&&products.every(item=>item.hasOptions===false)?'order_prepare':'product_options',
          next:'For open-ended browsing, offer a small grounded shortlist or ask one useful preference question. Use native details for ingredient claims; fetch product_options only for a candidate missing needed facts or customization choices. Do not ask for sizes when details.sizeSelectionRequired is false. A standardOrderable item needs no optional add-ons; preserve literal preparation requests as kitchen instructions without promising they can be fulfilled. Use included options without fetching them again. Once the user has chosen, copy the item identity, quantity and exact choices into order_prepare. Never invent ingredients, sizes or totals.',hasMore:result.hasMore};
      }));
      const addressResult=await addressRequest;
      if(!batch){if(settled[0].status==='rejected')throw settled[0].reason;return {...settled[0].value,...addressResult};}
      const results=settled.map((entry,index)=>entry.status==='fulfilled'?entry.value:{query:unique[index],status:'discovery_failed',error:{code:entry.reason.code??'DISCOVERY_FAILED',message:entry.reason.message},orderPrepared:false,orderPlaced:false});
      return {status:results.some(entry=>entry.error)||addressResult.addressesError?'partial_search_results':'search_results_only',
        ...addressResult, results,orderPrepared:false,orderPlaced:false,
        nextTool:results.some(entry=>entry.error)?'product_find':addressResult.addressesError?'product_find':unique.length?'order_prepare':undefined,
        next:'All requested searches are returned together. Reuse included options and do not search completed products again. Retry only failed queries; for a failed address read use queries:[] and includeAddresses:true. If each intended product and its choices are established, call order_prepare ONCE for the entire basket; ask about unresolved ambiguity instead of choosing for the user.'};
    });
  }
  async function prepare({ name, checkoutOptions = {}, cartOnly = false, quantity }) {
    name=savedName(name);
    if(quantity!==undefined&&(!Number.isFinite(quantity)||quantity<=0||quantity>1000))fail('INVALID_ARGUMENT','Supply a positive total quantity no greater than 1000.');
    return operation(async context => {
      let active = await store.readState('order-active');
      if(active&&blocked.has(active.status)){const recorded=await store.readState(`order-operation-${active.operationId}`);if(recorded&&['confirmed','rejected'].includes(recorded.status)){active=recorded;await store.saveState('order-active',recorded);}}
      if (active && blocked.has(active.status)) fail('ORDER_UNRESOLVED', 'Resolve the recorded order operation before preparing another recipe.');
      const { recipe } = await show({ name });
      if(quantity!==undefined){
        const items=recipeItems(recipe);
        if(items.length!==1)fail('RECIPE_QUANTITY_AMBIGUOUS','Quantity overrides require a single-item saved recipe. A basket recipe keeps each saved quantity.');
        items[0].quantity=quantity;
        if(!recipe.items)recipe.quantity=quantity;
      }
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
        && fulfillmentMatches(recipe,cart.orderType,cart.store,cart.address) && previous.cartId === cart.cartId && previous.digest === rowDigest(contents) && rows.length > 0;
      if (previous?.status === 'adding' || previous?.status === 'uncertain') fail('RECIPE_DRAFT_UNRESOLVED','A prior addition may have succeeded. This draft cannot be safely resumed or started over. Inspect its existing cart; no addition or payment was repeated.',{orderPrepared:false,orderPlaced:false,canResume:false,canStartOver:false,doNotResubmit:true,nextAction:'Inspect existing cart before any further mutation. Do not offer to start fresh, clear or finalize it automatically.'});
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
        // Resolve and validate the WHOLE basket before dispatching any addition.
        // A missing choice on line 3 must not leave lines 1 and 2 in the cart.
        const resolved = [];
        for (const item of recipeItems(recipe)) {
          const matches = new Map();
          for (let page = 0; ; page++) {
            const result = await catalog.search({ query: item.product.name, page, limit: 100 });
            for (const hit of result.items) if (normalizeLabel(hit.ProductName) === normalizeLabel(item.product.name)
              && (!item.product.brand || normalizeLabel(hit.BrandName) === normalizeLabel(item.product.brand))
              && (!item.product.sku || hit.SKU === item.product.sku)) matches.set(String(hit.ECRSID ?? hit.objectID), hit);
            if (!result.hasMore) break;
            if (page >= 19) fail('PRODUCT_AMBIGUOUS', 'This search is too broad. Add the exact brand and SKU to the recipe.');
          }
          if (matches.size !== 1) fail(matches.size?'PRODUCT_AMBIGUOUS':'PRODUCT_NOT_FOUND',matches.size?'Multiple current catalog entries match this recipe. No item was added.':'No current catalog entry matches this exact recipe. No item was added.',{orderPrepared:false,orderPlaced:false,product:item.product,reason:matches.size?'multiple_matches':'not_found',candidates:[...matches].map(([productRef,hit])=>({productRef,name:hit.ProductName,brand:hit.BrandName,sku:hit.SKU})),nextAction:'Ask the user to clarify the intended product. Do not suggest any alternative products or prices unless another tool actually returned them. Do not claim an item was absent when multiple matches were returned.'});
          const [productRef] = matches.keys();
          const args = { productId:productRef, expectedName:item.product.name, expectedSku:item.product.sku,
            quantity:item.quantity, size:item.size, choices:item.choices, instruction:item.instruction };
          await ordering.addCartItem({...args, validateOnly:true});
          resolved.push(args);
        }
        const journal = { status:'adding', intent, cartId:cart.cartId, startedAt:now().toISOString(), expected:[] };
        let submitted = false;
        try {
          for (const args of resolved) {
            await ordering.addCartItem({...args, beforeAdd:async selection => {
              journal.expected.push({size:selection.modifierSizeId, modifiers:selectionDigest(selection.selectedModifiers)});
              await store.saveState(journalName,journal); submitted=true;
            }});
          }
          contents = await ordering.cart();
          matchRows(recipe, journal.expected, cartRows(contents).filter(row => row.quantity > 0));
          journal.status='cart_ready'; journal.digest=rowDigest(contents);
          journal.cartId=(await store.readState('cart')).cartId;
          await store.saveState(journalName,journal);
        } catch(error) {
          if(submitted){journal.status='uncertain';await store.saveState(journalName,journal);}throw error;
        }
      }

      if(cartOnly)return {...await ordering.viewCart(),recipe:name};
      const quote = await ordering.checkout();
      const asap = quote.schedule_types?.filter(value => value.type === 'schedule_asap');
      if (asap?.length !== 1) fail('ASAP_UNAVAILABLE', 'The server did not offer one unambiguous ASAP option. Review checkout manually.');
      const prepared = await ordering.prepareOrder({ ...checkoutOptions, scheduleTypeId: asap[0]._id, redeem: false });
      if(!fulfillmentMatches(recipe,prepared.review.method,prepared.review.store,prepared.review.address))fail('FULFILLMENT_CHANGED','The reviewed location does not match this request. No order was placed.');
      if (recipe.paymentLast4 && prepared.review.payment.last4 !== recipe.paymentLast4) fail('PAYMENT_CHANGED', 'The selected saved card does not match this recipe. Review checkout and select the correct card.');
      const { cart: ignoredCart, products, ...terms } = prepared.review;
      const expected = (await store.readState(journalName)).expected ?? [(await store.readState(journalName)).expectedSelection];
      const specifications = matchRows(recipe, expected, products.map(item => ({product:item.product,quantity:item.quantity,modifier_size_id:item.modifierSizeId,selected_modifiers:item.selectedModifiers,product_instruction:item.instruction})));
      const review = { ...terms, products:products.map((item,index) => ({
        name:item.product?.name, quantity:item.quantity, size:specifications[index].size,
        choices:specifications[index].choices, description:item.modifierDescription,
        instruction:item.instruction, linePrice:item.linePrice,
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
    const specification=validateRecipe(request?.pickupStore!==undefined||request?.deliveryAddressId!==undefined?agentRequest(request):request);
    const name=`draft-${fingerprint(specification).slice(0,24)}`;
    await save({name,recipe:specification});
    return prepare({name,checkoutOptions});
  }
  async function addSaved(args={}) {
    only(args,['name','quantity'],'saved cart request');
    return prepare({...args,cartOnly:true});
  }
  return { save, show, find, options, prepare, prepareRequest, reset, addSaved };
}

export const recipes = createRecipes();
