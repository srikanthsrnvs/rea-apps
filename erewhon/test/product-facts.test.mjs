import test from 'node:test';
import assert from 'node:assert/strict';
import {backend} from '../eval/complex/backend.mjs';
import {productFacts} from '../src/product-choices.mjs';

test('broad discovery enriches a bounded shortlist without pretending every result has known ingredients',async()=>{
 const f=backend();f.factsBySku={CAP:{description:'Coffee with milk',ingredients:'Coffee, milk'},MAT:{ingredients:'Matcha, milk'}};
 const result=await f.api.find({queries:['Erewhon']});const products=result.results[0].products;
 assert.equal(products.length,3);assert.equal(f.calls.filter(c=>c.path==='/v1/getproduct').length,3);
 assert.equal(products[0].details.ingredients,'Coffee, milk');assert.equal(products[1].details.ingredients,'Matcha, milk');
 assert.equal(products[2].details.ingredients,null);assert.equal(f.rows.length,0);
 assert.equal(f.calls.some(c=>['/v1/checkout_details','/v1/place_order'].includes(c.path)),false);
});
test('fixed serving facts distinguish the display amount from selectable size arguments',async()=>{
 const f=backend();f.factsBySku={WAT:{size:'500 ml',description:'Spring water',ingredients:'Spring water',allergens:''}};
 const product=(await f.api.find({query:'Spring Water'})).products.find(p=>p.sku==='WAT');
 assert.equal(product.details.servingSize,'500 ml');assert.equal(product.details.sizeSelectionRequired,false);
 assert.deepEqual(product.details.selectableSizes,[]);assert.equal(product.details.standardOrderable,true);
 assert.equal(product.item.size,undefined);assert.equal(product.details.allergens,null);
 const options=await f.api.options({productRef:product.productRef});assert.equal(options.ingredients,'Spring water');assert.equal(options.servingSize,'500 ml');
});
test('required size selection or required modifier choices prevent a default-orderable claim',()=>{
 assert.equal(productFacts({modifier_size:[{name:'Small'},{name:'Large'}]}).standardOrderable,false);
 assert.equal(productFacts({modifier_groups:{modifier_sets:[{required:'true',minimum:0}]}}).standardOrderable,false);
 assert.equal(productFacts({modifier_groups:{modifier_sets:[{required:false,minimum:1}]}}).standardOrderable,false);
 assert.deepEqual(productFacts({modifier_size:[{name:'Small'}]}).selectableSizes,['Small']);
});
test('one preview failure retains other candidate facts and never hides a stale product identity',async()=>{
 const f=backend();f.failDetailsFor='CAP';f.staleDetailsFor='MAT';
 const result=await f.api.find({queries:['Erewhon']});const products=result.results[0].products;
 assert.ok(products[0].detailsError);assert.equal(products[1].detailsError.code,'PRODUCT_CHANGED');
 assert.equal(products[1].details,undefined);assert.ok(products[2].details);assert.equal(f.rows.length,0);
});
test('unknown facts never become allergen-free or inferred ingredients',()=>{
 const facts=productFacts({name:'Blueberry Protein Shake',allergens:'',ingredients:[]});
 assert.equal(facts.ingredients,null);assert.equal(facts.allergens,null);assert.equal(facts.servingSize,null);
 assert.match(facts.interpretation,/unknown/);
});
