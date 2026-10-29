import test from 'node:test';
import assert from 'node:assert/strict';
import {backend} from '../eval/complex/backend.mjs';

test('whole basket discovery includes each identity/options and initializes cart just once',async()=>{
 const f=backend();const result=await f.api.find({queries:['Cappuccino','Breakfast Burrito','Mountain Spring Water']});
 assert.equal(result.results.length,3);assert.equal(result.orderPlaced,false);
 assert.deepEqual(result.results.map(r=>r.options?.name),['Cappuccino','Breakfast Burrito','Spring Water']);
 assert.equal(f.calls.filter(c=>c.path==='/v1/ordermethod').length,1);
 assert.equal(f.calls.filter(c=>c.path==='/v1/getproduct').length,3);
 assert.equal(f.rows.length,0);assert.equal(f.calls.some(c=>c.path==='/v1/place_order'),false);
});
test('repeated product names are deduplicated without conflating multiple brands',async()=>{
 const f=backend();const result=await f.api.find({queries:['Cappuccino',' cappuccino ','Spring Water']});
 assert.equal(result.results.length,2);assert.equal(result.results[1].products.length,2);
 assert.equal(result.results[1].options,undefined);assert.equal(f.calls.filter(c=>c.path==='/v1/getproduct').length,1);
});
test('one failed lookup retains the other results and retries can target just that query',async()=>{
 // Inject an error only for one query using the same production module/backend.
 const g=backend({failQuery:'Cappuccino'});
 const result=await g.api.find({queries:['Cappuccino','Breakfast Burrito']});
 assert.equal(result.status,'partial_search_results');assert.ok(result.results[0].error);
 assert.equal(result.results[1].options.name,'Breakfast Burrito');assert.equal(g.rows.length,0);
});
test('legacy single query stays compatible; empty, mixed and oversized batches reject before any I/O',async()=>{
 const f=backend();assert.equal((await f.api.find({query:'Cappuccino'})).options.name,'Cappuccino');
 const count=f.calls.length;
 for(const args of [{queries:[]},{queries:Array(13).fill('Cappuccino')},{query:'Cappuccino',queries:['Cappuccino']},{queries:['']}])await assert.rejects(f.api.find(args));
 assert.equal(f.calls.length,count);
});

test('delivery discovery can include saved addresses without a separate tool or cart initialization',async()=>{
 const f=backend();const result=await f.api.find({queries:['Spring Water'],includeAddresses:true});
 assert.equal(result.addresses[0].address_id,'saved-home');assert.equal(f.calls.filter(c=>c.path==='/v1/ordermethod').length,1);
 assert.equal(f.calls.filter(c=>c.path==='/v1/alladdress').length,1);assert.equal(f.rows.length,0);
 const g=backend();await g.api.find({queries:['Cappuccino']});assert.equal(g.calls.some(c=>c.path==='/v1/alladdress'),false);
});
test('discovery refuses ignored fields and malformed address flags before network activity',async()=>{
 const f=backend();for(const args of [{queries:['Cappuccino'],quantity:3},{queries:['Cappuccino'],includeAddresses:'true'},null])await assert.rejects(f.api.find(args),{code:'INVALID_ARGUMENT'});
 assert.equal(f.calls.length,0);
});

test('address-only discovery retains the standalone address-read capability with no product requests',async()=>{
 const f=backend();const result=await f.api.find({queries:[],includeAddresses:true});
 assert.equal(result.addresses[0].address_id,'saved-home');assert.equal(result.results.length,0);
 assert.equal(f.calls.some(c=>c.path==='/v1/getproduct'),false);assert.equal(result.nextTool,undefined);
});

test('address failures retain discovered products and can be retried without repeating product lookups',async()=>{
 const f=backend({failAddress:true});const result=await f.api.find({queries:['Cappuccino'],includeAddresses:true});
 assert.equal(result.results[0].options.name,'Cappuccino');assert.ok(result.addressesError);
 assert.equal(result.nextTool,'product_find');assert.equal(result.orderPlaced,false);
 const retry=await f.api.find({queries:[],includeAddresses:true});assert.ok(retry.addressesError);
 assert.equal(f.calls.filter(c=>c.path==='/v1/getproduct').length,1);
});
