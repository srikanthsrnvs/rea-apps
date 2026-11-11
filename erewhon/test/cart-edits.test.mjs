import test from 'node:test';
import assert from 'node:assert/strict';
import {backend} from '../eval/complex/backend.mjs';
import {scenarios} from '../eval/complex/scenarios.mjs';
const favorite={product:{name:'Cappuccino',brand:'Erewhon',sku:'CAP'},quantity:1,size:'Large 16 oz',choices:[{group:'Milk',option:'Whole Milk'},{group:'Extras',option:'Vanilla Syrup'}],instruction:'Extra hot please',fulfillment:{type:'pickup',store:'Venice'}};
async function setup(){const f=backend();await f.api.save({name:'morning-drink',recipe:favorite});return f;}
const writes=f=>f.calls.filter(c=>c.path==='/v1/cart_update');
const noCheckout=f=>assert.equal(f.calls.some(c=>['/v1/checkout_details','/v1/validate_cart','/v1/place_order'].includes(c.path)),false);

test('spoken saved labels add a cart-only favorite, then change total to three without rewriting preferences',async()=>{
 const f=await setup();f.rotation='rotated';
 const first=await f.api.addSaved({name:'my morning drink'});
 assert.equal(first.status,'cart_only');assert.equal(first.orderPrepared,false);assert.equal(first.orderPlaced,false);assert.equal(first.items[0].quantity,1);
 assert.equal(first.items[0].size,'Large 16 oz');assert.equal(first.items[0].instruction,favorite.instruction);
 const second=await f.ordering.setCartQuantity({itemRef:first.items[0].itemRef,quantity:3});
 assert.equal(second.items.length,1);assert.equal(second.items[0].quantity,3);assert.equal(second.totalQuantity,3);
 assert.equal(second.items[0].itemRef,first.items[0].itemRef);assert.deepEqual(second.items[0].choices,first.items[0].choices);
 assert.equal(f.addCount,1);assert.equal(writes(f).length,1);assert.equal((await f.api.show({name:'morning-drink'})).recipe.quantity,1);noCheckout(f);
});
test('quantity override changes this cart only; unchanged adds and absolute edits are idempotent',async()=>{
 const f=await setup();const a=await f.api.addSaved({name:'morning drink',quantity:3});
 await f.api.addSaved({name:'morning-drink',quantity:3});
 const b=await f.ordering.setCartQuantity({itemRef:a.items[0].itemRef,quantity:3});
 assert.equal(b.changed,false);assert.equal(f.addCount,1);assert.equal(writes(f).length,0);assert.equal((await f.api.show({name:'morning-drink'})).recipe.quantity,1);noCheckout(f);
});
test('editing one customized line preserves other customizations and their references',async()=>{
 const f=backend();await f.api.prepareRequest({request:scenarios.split.request});
 const first=await f.ordering.viewCart();assert.equal(first.items.length,2);
 const other=structuredClone(f.rows[1]);
 const result=await f.ordering.setCartQuantity({itemRef:first.items[0].itemRef,quantity:3});
 assert.deepEqual(f.rows[1],other);assert.equal(result.items[1].itemRef,first.items[1].itemRef);
 assert.equal(result.items[0].quantity,3);assert.equal(result.items[1].quantity,first.items[1].quantity);
});
test('reordered rows are selected by exact reference, not position',async()=>{
 const f=backend();await f.api.prepareRequest({request:scenarios.split.request});const first=await f.ordering.viewCart();f.reverseRows=true;
 await f.ordering.setCartQuantity({itemRef:first.items[0].itemRef,quantity:4});assert.equal(f.rows[0].quantity,4);assert.equal(f.rows[1].quantity,1);
});
test('stale customized item references and invalid quantities cannot dispatch writes',async()=>{
 const f=await setup();const a=await f.api.addSaved({name:'morning-drink'});f.rows[0].product_instruction='Changed elsewhere';
 await assert.rejects(f.ordering.setCartQuantity({itemRef:a.items[0].itemRef,quantity:3}),{code:'CART_ITEM_CHANGED'});
 for(const quantity of [undefined,-1,Infinity,1001,'3'])await assert.rejects(f.ordering.setCartQuantity({itemRef:a.items[0].itemRef,quantity}),{code:'INVALID_ARGUMENT'});
 assert.equal(writes(f).length,0);
});
test('cart references are bound to fulfillment and account',async()=>{
 const f=await setup();const a=await f.api.addSaved({name:'morning-drink'});f.storeName='Grove';
 await assert.rejects(f.ordering.setCartQuantity({itemRef:a.items[0].itemRef,quantity:3}),{code:'CART_ITEM_CHANGED'});assert.equal(writes(f).length,0);
});
test('lost update response can be inspected and an absolute retry does not add or repeat the write',async()=>{
 const f=await setup();const a=await f.api.addSaved({name:'morning-drink'});f.dropUpdate=true;
 await assert.rejects(f.ordering.setCartQuantity({itemRef:a.items[0].itemRef,quantity:3}),/Lost quantity/);
 assert.equal((await f.ordering.viewCart()).items[0].quantity,3);
 const b=await f.ordering.setCartQuantity({itemRef:a.items[0].itemRef,quantity:3});assert.equal(b.changed,false);assert.equal(writes(f).length,1);assert.equal(f.addCount,1);noCheckout(f);
});
test('a server change to other terms is not reported as a successful quantity edit',async()=>{
 const f=await setup();const a=await f.api.addSaved({name:'morning-drink'});f.changeUpdate=true;
 await assert.rejects(f.ordering.setCartQuantity({itemRef:a.items[0].itemRef,quantity:3}),{code:'CART_UPDATE_UNVERIFIED'});assert.equal(writes(f).length,1);noCheckout(f);
});
test('zero removes just the intended customized line and never touches checkout',async()=>{
 const f=backend();await f.api.prepareRequest({request:scenarios.split.request});const first=await f.ordering.viewCart();const other=structuredClone(f.rows[1]);f.calls=[];
 const result=await f.ordering.setCartQuantity({itemRef:first.items[0].itemRef,quantity:0});assert.equal(result.items.length,1);assert.deepEqual(f.rows,[other]);noCheckout(f);
});
test('saved cart additions preserve occupied carts, lost-add guards and unresolved payment guards',async()=>{
 const f=await setup();const a=await f.api.addSaved({name:'morning-drink'});await f.ordering.setCartQuantity({itemRef:a.items[0].itemRef,quantity:3});
 await assert.rejects(f.api.addSaved({name:'morning-drink'}),{code:'CART_NOT_EMPTY'});assert.equal(f.rows[0].quantity,3);assert.equal(f.addCount,1);
 f.records.set('order-active',{status:'uncertain',operationId:'pending'});
 await assert.rejects(f.ordering.setCartQuantity({itemRef:a.items[0].itemRef,quantity:2}),{code:'ORDER_UNRESOLVED'});
 await assert.rejects(f.api.addSaved({name:'morning-drink'}),{code:'ORDER_UNRESOLVED'});
 const lost=await setup();lost.dropAt=1;await assert.rejects(lost.api.addSaved({name:'morning-drink'}));
 await assert.rejects(lost.api.addSaved({name:'morning-drink'}),{code:'RECIPE_DRAFT_UNRESOLVED'});assert.equal(lost.addCount,1);noCheckout(lost);
});
test('old review cannot be confirmed after a quantity edit',async()=>{
 const f=await setup();const plan=await f.api.prepare({name:'morning-drink'});const a=await f.ordering.viewCart();
 await f.ordering.setCartQuantity({itemRef:a.items[0].itemRef,quantity:3});
 await assert.rejects(f.ordering.confirmOrder({planId:plan.planId}),{code:'ORDER_CHANGED'});
 assert.equal(f.calls.some(c=>c.path==='/v1/place_order'),false);
 const fresh=await f.ordering.prepareOrder();assert.equal(fresh.review.products[0].quantity,3);assert.equal(fresh.orderPlaced,false);
});

test('native cart rows without a size catalog expose their unambiguous selected size label',async()=>{
 const f=await setup();await f.api.addSaved({name:'morning-drink'});
 f.rows[0].selected_modifiers_items=['Large 16 oz','Whole Milk','Vanilla Syrup'];delete f.rows[0].product.modifier_size;
 const view=await f.ordering.viewCart();assert.equal(view.items[0].size,'Large 16 oz');
 f.rows[0].selected_modifiers_items.push('Unrecognized label');assert.equal((await f.ordering.viewCart()).items[0].size,undefined);
});
