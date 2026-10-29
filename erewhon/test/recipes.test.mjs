import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecipes, validateRecipe } from '../src/recipes.mjs';
import { createOrdering } from '../src/ordering.mjs';
import { namedSelections } from '../src/product-choices.mjs';

import { recipe, fixture } from './helpers/recipe-fixture.mjs';

test('recipes survive rotation of every native identity and even the search reference', async () => {
  const f = fixture();
  await f.api.save({ name: 'usual-coffee', recipe });
  const first = await f.api.prepare({ name: 'usual-coffee' });
  assert.equal(first.orderPlaced, false);
  assert.equal(first.review.products[0].size, 'Large 16 oz');
  assert.equal(JSON.stringify(first.review).includes('native-one'),false);
  f.rows = []; f.rotation = 'two';
  const second = await f.api.prepare({ name: 'usual-coffee' });
  const add = f.calls.find(call => call.path === '/v1/addtocart/native-two');
  assert.ok(add);
  assert.equal(add.form.modifier_size_id, 'size-two');
  assert.equal(JSON.parse(add.form.modifier_sets)[0].modifiers[0]._id, 'whole-two');
  assert.equal(second.orderPlaced, false);
  assert.equal(f.calls.filter(call => call.path === '/v1/place_order').length, 0);
  assert.equal(JSON.stringify(f.records.get('recipe-usual-coffee')).includes('native-'), false);
});

test('repeated preparation reuses the unchanged cart without adding another coffee', async () => {
  const f = fixture(); await f.api.save({ name: 'usual-coffee', recipe });
  await f.api.prepare({ name: 'usual-coffee' });
  await f.api.prepare({ name: 'usual-coffee' });
  assert.equal(f.calls.filter(call => call.path.startsWith('/v1/addtocart/')).length, 1);
});

test('lost add response blocks replay even if the item is visible in the cart', async () => {
  const f = fixture(); await f.api.save({ name: 'usual-coffee', recipe }); f.dropAdd = true;
  await assert.rejects(f.api.prepare({ name: 'usual-coffee' }), /Connection lost/);
  await assert.rejects(f.api.prepare({ name: 'usual-coffee' }), { code: 'RECIPE_DRAFT_UNRESOLVED' });
  await assert.rejects(f.api.reset({ name: 'usual-coffee' }), { code: 'CART_NOT_EMPTY' });
  assert.equal(f.calls.filter(call => call.path.startsWith('/v1/addtocart/')).length, 1);
  f.rows = []; await f.api.reset({ name: 'usual-coffee' });
  assert.equal(f.records.get('recipe-draft-usual-coffee'), null);
});

test('occupied carts, ambiguous products and missing choices never dispatch additions', async () => {
  const occupied = fixture(); await occupied.api.save({ name: 'usual-coffee', recipe }); occupied.rows = [{ quantity: 1 }];
  await assert.rejects(occupied.api.prepare({ name: 'usual-coffee' }), { code: 'CART_NOT_EMPTY' });
  const ambiguous = fixture(); await ambiguous.api.save({ name: 'usual-coffee', recipe }); ambiguous.ambiguous = true;
  await assert.rejects(ambiguous.api.prepare({ name: 'usual-coffee' }), { code: 'PRODUCT_AMBIGUOUS' });
  const missing = fixture(); await missing.api.save({ name: 'usual-coffee', recipe: { ...recipe, size: 'Retired size' } });
  await assert.rejects(missing.api.prepare({ name: 'usual-coffee' }), { code: 'CHOICE_UNAVAILABLE' });
  assert.equal(missing.records.has('recipe-draft-usual-coffee'), false);
  for (const f of [occupied, ambiguous, missing]) assert.equal(f.calls.some(call => call.path.startsWith('/v1/addtocart/')), false);
});

test('native IDs and imprecise size names cannot become persistent recipe choices', () => {
  assert.throws(() => validateRecipe({ ...recipe, product: { name: 'Cappuccino', productId: 'old-native-id' } }), { code: 'INVALID_RECIPE' });
  assert.throws(() => validateRecipe({ ...recipe, choices: [{ groupId: 'old-group', modifierId: 'old-choice' }] }), { code: 'INVALID_RECIPE' });
  assert.throws(() => namedSelections({ modifier_size: [{ name: 'Large 16 oz' }] }, { size: 'Large' }), { code: 'CHOICE_UNAVAILABLE' });
});

test('durable status distinguishes an unsubmitted review from server-confirmed placement', async () => {
  const f = fixture(); await f.api.save({ name: 'usual-coffee', recipe });
  const plan = await f.api.prepare({ name: 'usual-coffee' });
  assert.equal((await f.ordering.orderStatus({ planId: plan.planId })).orderPlaced, false);
  assert.equal(f.calls.some(call => call.path === '/v1/place_order'), false);
  const result = await f.ordering.confirmOrder({ planId: plan.planId });
  assert.equal(result.orderPlaced, true);
  const status = await f.ordering.orderStatus({ planId: plan.planId });
  assert.equal(status.orderPlaced, true); assert.equal(status.orderId, 'server-order');
  assert.equal(f.calls.filter(call => call.path === '/v1/place_order').length, 1);
});

test('server dropping a chosen modifier stops preparation and blocks duplicate additions',async()=>{
 const f=fixture();await f.api.save({name:'usual-coffee',recipe});f.dropSelections=true;
 await assert.rejects(f.api.prepare({name:'usual-coffee'}),{code:'CART_ADDITION_UNVERIFIED'});
 await assert.rejects(f.api.prepare({name:'usual-coffee'}),{code:'RECIPE_DRAFT_UNRESOLVED'});
 assert.equal(f.calls.some(c=>c.path==='/v1/place_order'),false);
});
test('lost payment response remains unknown until reconciliation and never resubmits',async()=>{
 const f=fixture();await f.api.save({name:'usual-coffee',recipe});const plan=await f.api.prepare({name:'usual-coffee'});
 f.dropPlace=true;f.reconcilePending=true;
 const result=await f.ordering.confirmOrder({planId:plan.planId});assert.equal(result.orderPlaced,null);
 assert.equal((await f.ordering.orderStatus({planId:plan.planId})).orderPlaced,null);
 f.reconcilePending=false;f.session.token='renewed-token';
 const reconciled=await f.ordering.orderStatus({planId:plan.planId});assert.equal(reconciled.orderPlaced,true);assert.equal(reconciled.orderId,'server-order');
 assert.equal(f.calls.filter(c=>c.path==='/v1/place_order').length,1);
});

test('one-off inline requests reuse a deterministic draft and return an actual prepared review',async()=>{
 const f=fixture();const first=await f.api.prepareRequest({request:recipe});
 const second=await f.api.prepareRequest({request:recipe});
 assert.equal(first.orderPrepared,true);assert.equal(second.review.amounts.order_total,'9.97');
 assert.equal(f.calls.filter(c=>c.path.startsWith('/v1/addtocart/')).length,1);
 assert.equal(f.calls.some(c=>c.path==='/v1/place_order'),false);
});
test('unavailable choice errors expose exact valid labels and explicitly deny preparation',async()=>{
 const f=fixture();await f.api.save({name:'usual-coffee',recipe:{...recipe,size:'Large'}});
 await assert.rejects(f.api.prepare({name:'usual-coffee'}),error=>error.details.orderPrepared===false&&error.details.available.includes('Large 16 oz'));
 assert.equal(f.calls.some(c=>c.path.startsWith('/v1/addtocart/')),false);
});
