import test,{beforeEach,afterEach,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {cart,checkout} from './commerce-fixtures.mjs';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'amazon-commerce-'));
process.env.AMAZON_CLI_STATE_DIR=directory;
const commerce=await import('../src/commerce.mjs');
const state=await import('../src/state.mjs');
const originalFetch=globalThis.fetch,originalRm=fs.rm;
let calls;
function responses(...values){globalThis.fetch=async(url,options)=>{
 calls.push({url:String(url),...options});const next=values.shift();
 if(next instanceof Error)throw next;
 if(next===undefined)throw Error('Unexpected request');
 return new Response(next,{status:200});
};}
beforeEach(async()=>{
 await fs.rm(directory,{recursive:true,force:true});await fs.mkdir(directory,{mode:0o700});
 await state.saveState('session',{customerId:'example-customer',profile:{deviceSerial:'example-device'},cookies:[]});
 calls=[];responses();
});
afterEach(()=>{globalThis.fetch=originalFetch;fs.rm=originalRm;});
after(async()=>{await fs.rm(directory,{recursive:true,force:true});});
async function plan(){responses(cart(),checkout());return commerce.prepareCheckout();}
const postCount=()=>calls.filter(c=>c.method==='POST').length;
test('preparing checkout makes only GET requests and hides source credentials',async()=>{
 const result=await plan();assert.equal(result.review.total.amount,10);assert.equal(postCount(),0);
 assert.equal(JSON.stringify(result).includes('private-csrf'),false);assert.equal(JSON.stringify(result).includes('private-session'),false);
});
test('a changed cart, payment, shipping, address or price prevents any purchase POST',async()=>{
 for(const change of [{cart:cart({quantity:2})},{review:checkout({payment:'Different card'})},{review:checkout({address:'2 Other Street'})},{review:checkout({shipping:'Different delivery'})},{review:checkout({total:'11.00'})}]){
  const prepared=await plan();responses(change.cart||cart(),change.review||checkout());
  await assert.rejects(commerce.placeOrder({planId:prepared.planId,confirmTotal:'10.00',currency:'USD'}),e=>['CART_CHANGED','CHECKOUT_CHANGED'].includes(e.code));assert.equal(postCount(),0);
 }
});
test('approval of a different total or account cannot use a purchase plan',async()=>{
 const prepared=await plan();responses();
 await assert.rejects(commerce.placeOrder({planId:prepared.planId,confirmTotal:'9.00',currency:'USD'}),{code:'TOTAL_NOT_CONFIRMED'});
 await state.saveState('session',{customerId:'different-customer',profile:{deviceSerial:'example-device'},cookies:[]});
 await assert.rejects(commerce.placeOrder({planId:prepared.planId,confirmTotal:'10.00',currency:'USD'}),{code:'PLAN_NOT_FOUND'});assert.equal(postCount(),0);
});
test('an unknown POST outcome is durable and neither repeated nor bypassed by a new plan',async()=>{
 const prepared=await plan();responses(cart(),checkout(),new Error('Connection lost after possible commit'));
 await assert.rejects(commerce.placeOrder({planId:prepared.planId,confirmTotal:'10.00',currency:'USD'}),{code:'NETWORK_ERROR'});
 assert.equal(postCount(),1);const again=await commerce.placeOrder({planId:prepared.planId,confirmTotal:'10.00',currency:'USD'});assert.equal(again.status,'submission_pending');assert.equal(postCount(),1);
 const another=await plan();responses();await assert.rejects(commerce.placeOrder({planId:another.planId,confirmTotal:'10.00',currency:'USD'}),{code:'COMMERCE_OUTCOME_UNKNOWN'});
});
test('confirmed results are returned on repeated calls without another submission',async()=>{
 const prepared=await plan();responses(cart(),checkout(),'<html><body>Thank you for your order. 111-1111111-1111111</body></html>');
 const result=await commerce.placeOrder({planId:prepared.planId,confirmTotal:'10.00',currency:'USD'});
 assert.equal(result.status,'confirmed');assert.equal(postCount(),1);
 assert.deepEqual(await commerce.placeOrder({planId:prepared.planId,confirmTotal:'10.00',currency:'USD'}),result);assert.equal(postCount(),1);
 assert.equal(await state.readState('commerce-pending'),null);
});
test('a disabled or destination-overriding purchase button is never submitted',async()=>{
 const prepared=await plan();responses(cart(),checkout({disabled:true}));
 await assert.rejects(commerce.placeOrder({planId:prepared.planId,confirmTotal:'10.00',currency:'USD'}),{code:'CHECKOUT_NOT_READY'});assert.equal(postCount(),0);
 responses(cart(),checkout().replace('name="placeYourOrder1"','formaction="/hp/prime/signup" name="placeYourOrder1"'));
 await assert.rejects(commerce.placeOrder({planId:prepared.planId,confirmTotal:'10.00',currency:'USD'}),{code:'INVALID_SUBMISSION'});assert.equal(postCount(),0);
});
test('a confirmed purchase recovers failed local cleanup without submitting again',async()=>{
 const prepared=await plan();responses(cart(),checkout(),'<html><body>Thank you for your order. 111-1111111-1111111</body></html>');
 let armed=true;
 fs.rm=async(file,options)=>{if(armed&&path.basename(file)==='commerce-pending.json'){armed=false;throw Error('Cleanup interrupted');}return originalRm(file,options);};
 await assert.rejects(commerce.placeOrder({planId:prepared.planId,confirmTotal:'10.00',currency:'USD'}));
 assert.equal(postCount(),1);assert.equal((await commerce.placeOrder({planId:prepared.planId,confirmTotal:'10.00',currency:'USD'})).status,'confirmed');
 assert.equal(postCount(),1);assert.equal(await state.readState('commerce-pending'),null);
});
test('expiry and missing user confirmation fail locally',async()=>{
 const prepared=await plan();const record=await state.readState(`commerce-${prepared.planId}`);record.expiresAt='2000-01-01T00:00:00Z';await state.saveState(`commerce-${prepared.planId}`,record);responses();
 await assert.rejects(commerce.placeOrder({planId:prepared.planId,confirmTotal:'10.00',currency:'USD'}),{code:'PLAN_EXPIRED'});
 await assert.rejects(commerce.cancelOrder({planId:prepared.planId}),{code:'CONFIRMATION_REQUIRED'});assert.equal(calls.at(-1).method,'GET');
});
