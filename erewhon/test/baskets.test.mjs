import test from 'node:test';
import assert from 'node:assert/strict';
import {backend} from '../eval/complex/backend.mjs';
import {scenarios} from '../eval/complex/scenarios.mjs';
import {validateRecipe} from '../src/recipes.mjs';

test('mixed baskets preserve quantities, counts, instructions and separately customized rows',async()=>{
 for(const key of ['mixed','split','shots']){
  const f=backend();const plan=await f.api.prepareRequest({request:scenarios[key].request});
  assert.equal(plan.orderPlaced,false);assert.equal(plan.review.products.length,key==='mixed'?3:key==='split'?2:1);
  if(key==='mixed')assert.equal(plan.review.products.find(p=>p.name==='Breakfast Burrito').instruction,'Cut in half');
  if(key==='shots')assert.equal(plan.review.products[0].choices.find(c=>c.option==='Espresso Shot').count,2);
  assert.equal(f.calls.some(c=>c.path==='/v1/place_order'),false);
 }
});
test('entire basket is preflighted; unavailable last line leaves zero additions and no replay journal',async()=>{
 const f=backend();await assert.rejects(f.api.prepareRequest({request:scenarios.invalidtail.request}),{code:'CHOICE_UNAVAILABLE'});
 assert.equal(f.rows.length,0);assert.equal(f.calls.some(c=>c.path.startsWith('/v1/addtocart/')),false);
 assert.equal([...f.records.entries()].some(([k,v])=>k.startsWith('recipe-draft-')&&v?.status==='adding'),false);
});
test('response lost on second addition blocks replay without duplicating or clearing partial basket',async()=>{
 const f=backend();f.dropAt=2;const args={request:scenarios.mixed.request};
 await assert.rejects(f.api.prepareRequest(args),/Lost addition/);const before=structuredClone(f.rows);
 await assert.rejects(f.api.prepareRequest(args),{code:'RECIPE_DRAFT_UNRESOLVED'});
 assert.deepEqual(f.rows,before);assert.equal(f.addCount,2);
});
test('mixed recipe survives fresh references and native IDs, and retry adds nothing',async()=>{
 const f=backend();await f.api.save({name:'team',recipe:scenarios.mixed.request});f.rotation='fresh';
 const first=await f.api.prepare({name:'team'});const second=await f.api.prepare({name:'team'});
 assert.deepEqual(first.review.products,second.review.products);assert.equal(f.addCount,3);
 assert.equal(f.calls.filter(c=>c.path.startsWith('/v1/addtocart/')).every(c=>c.path.endsWith('-fresh')),true);
});
test('server row reordering preserves association between review and named customizations',async()=>{
 const f=backend();f.reverseRows=true;const {review}=await f.api.prepareRequest({request:scenarios.split.request});
 assert.deepEqual(review.products.map(p=>p.size),['Large 16 oz','Small 8 oz']);
 assert.equal(review.products[0].choices.find(c=>c.group==='Milk').option,'Oat Milk');
});
test('identical lines merge quantities; conflicting one-product and basket requests are rejected',()=>{
 const item=scenarios.shots.request;const {fulfillment,...line}=item;
 const recipe=validateRecipe({items:[line,{...line,quantity:1}],fulfillment});assert.equal(recipe.items.length,1);assert.equal(recipe.items[0].quantity,4);
 assert.throws(()=>validateRecipe({...item,items:[line]}),{code:'INVALID_RECIPE'});
 assert.throws(()=>validateRecipe({items:[],fulfillment}),{code:'INVALID_RECIPE'});
});
test('fresh product SKU mismatch is rejected before any basket mutation',async()=>{
 const f=backend();await assert.rejects(f.ordering.addCartItem({productId:'ref-CAP-initial',expectedSku:'not-CAP',choices:[],size:'Small 8 oz'}),{code:'PRODUCT_CHANGED'});
 assert.equal(f.addCount,0);
});

test('flat agent arguments retain exact brand/SKU, counts and empty notes without native IDs',async()=>{
 const f=backend();const result=await f.api.prepareRequest({request:{pickupStore:'Venice',items:[{name:'Spring Water',brand:'Mountain',sku:'WAT',quantity:3,choices:[],instruction:''}]}});
 assert.equal(result.review.amounts.order_total,'9.86');assert.equal(result.review.products[0].quantity,3);
 const saved=[...f.records.values()].find(v=>v?.specification);assert.deepEqual(saved.specification.items[0].product,{name:'Spring Water',brand:'Mountain',sku:'WAT'});
});
test('reordered server rows do not cause a retry to add duplicates or relabel customizations',async()=>{
 const f=backend();await f.api.prepareRequest({request:scenarios.split.request});f.reverseRows=true;
 const second=await f.api.prepareRequest({request:scenarios.split.request});assert.equal(f.addCount,2);
 assert.equal(second.review.products[0].size,'Large 16 oz');assert.equal(second.review.products[1].size,'Small 8 oz');
});
test('changing fulfillment outside the recipe cannot reuse a draft with the wrong pickup store',async()=>{
 const f=backend();await f.api.prepareRequest({request:scenarios.split.request});f.storeName='Grove';
 await assert.rejects(f.api.prepareRequest({request:scenarios.split.request}),{code:'CART_NOT_EMPTY'});assert.equal(f.addCount,2);
});
test('ordering profile separates fresh baskets from saved preparations and requires full identity',async()=>{
 const {orderingToolManifest}=await import('../src/tools.mjs');const tools=orderingToolManifest.tools;
 assert.equal(tools.length,7);assert.equal(new Set(tools.map(t=>t.name)).size,7);
 assert.equal(tools.some(t=>t.name==='recipe_show'||t.name==='recipe_reset'||t.name==='recipe_save'),false);
 assert.deepEqual(tools.find(t=>t.name==='order_prepare_saved').inputSchema.required,['name']);
 const schema=tools.find(t=>t.name==='order_prepare').inputSchema;
 assert.equal(schema.properties.request,undefined);assert.equal(schema.properties.recipe,undefined);
 assert.ok(schema.properties.items.items.required.includes('brand'));assert.ok(schema.properties.items.items.required.includes('sku'));
});
test('no-purchase evaluation backend rejects the payment endpoint even outside tool exposure',async()=>{
 const f=backend();const prepared=await f.api.prepareRequest({request:scenarios.shots.request});
 const result=await f.ordering.confirmOrder({planId:prepared.planId});assert.equal(result.orderPlaced,null);assert.equal(result.status,'uncertain');
});

test('saved recipe reads explicitly require a preparation and cannot masquerade as a quote',async()=>{
 const f=backend();await f.api.save({name:'team',recipe:scenarios.mixed.request});
 const read=await f.api.show({name:'team'});assert.equal(read.orderPrepared,false);assert.equal(read.status,'recipe_only');
 assert.deepEqual(read.nextCall,{tool:'order_prepare_saved',arguments:{name:'team'}});assert.equal(f.addCount,0);
});
test('search exposes a copyable identity and options while withholding non-checkout price estimates',async()=>{
 const f=backend();const found=await f.api.find({query:'Cappuccino'});
 assert.deepEqual(found.products[0].item,{name:'Cappuccino',brand:'Erewhon',sku:'CAP',quantity:1,choices:[],instruction:''});
 assert.equal(found.options.sizes.length,2);assert.equal(found.options.sizes[0].price,undefined);
 assert.equal(found.products[0].price,undefined);assert.equal(found.nextTool,'order_prepare');assert.equal(found.orderPrepared,false);
});

test('a no-size packaged row reported as null verifies in a mixed kitchen basket',async()=>{
 const f=backend();const result=await f.api.prepareRequest({request:scenarios.mixed.request});
 assert.equal(f.rows.find(r=>r.product.sku==='WAT').modifier_size_id,null);
 assert.equal(result.status,'prepared');assert.equal(result.review.products.find(p=>p.name==='Spring Water').size,undefined);
});
test('modifier capacity is separate from the default one portion and an omitted count stays one',async()=>{
 const f=backend();f.generousLimits=true;
 const options=(await f.api.find({query:'Cappuccino'})).options;
 const syrup=options.sizes[0].groups.find(g=>g.group==='Extras').options.find(o=>o.option==='Vanilla Syrup');
 assert.equal(syrup.defaultCount,1);assert.equal(syrup.maxAllowedCount,3);assert.equal(syrup.maximum,undefined);
 const request=structuredClone(scenarios['modifier-defaults'].request);request.choices.forEach(c=>delete c.count);
 const result=await f.api.prepareRequest({request});assert.equal(result.status,'prepared');
 const selected=f.rows[0].selected_modifiers.flatMap(g=>g.modifiers).filter(m=>m.is_selected);
 assert.equal(selected.find(m=>m.name==='Vanilla Syrup').count,1);
});
test('count omission does not prevent an explicit request for multiple portions',async()=>{
 const f=backend();const request=structuredClone(scenarios.shots.request);request.choices.forEach(c=>{if(c.option!=='Espresso Shot')delete c.count;});
 const result=await f.api.prepareRequest({request});assert.equal(result.review.amounts.order_total,'41.88');
 assert.equal(f.rows[0].selected_modifiers.flatMap(g=>g.modifiers).find(m=>m.name==='Espresso Shot').count,2);
});
test('partial basket errors explicitly forbid resume or starting over',async()=>{
 const f=backend();f.dropAt=2;await assert.rejects(f.api.prepareRequest({request:scenarios.mixed.request}));
 await assert.rejects(f.api.prepareRequest({request:scenarios.mixed.request}),e=>e.code==='RECIPE_DRAFT_UNRESOLVED'&&e.details.canStartOver===false&&e.details.canResume===false&&e.details.doNotResubmit===true);
});
