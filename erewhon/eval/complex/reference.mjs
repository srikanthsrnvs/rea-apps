import fs from 'node:fs/promises';
import path from 'node:path';
import {session} from './session.mjs';
import {scenarios} from './scenarios.mjs';
import {recipeItems} from '../../src/recipes.mjs';
// These reference trajectories are authored by the primary coding agent. They
// execute the same production tools and backend; they are never shown to Qwen.
const output=process.env.EREWHON_EVAL_OUTPUT;
if(!path.isAbsolute(output??''))throw new Error('Set an absolute private output directory.');
await fs.mkdir(output,{recursive:true,mode:0o700});const summaries=[];
for(const [key,s] of Object.entries(scenarios)){
 const trace=path.join(output,`${key}-trace.jsonl`);await fs.writeFile(trace,'',{mode:0o600});const run=await session(key,trace);
 if(!s.saved){
  if(s.delivery)await run.call('addresses',{});
  const seen=new Set();
  for(const item of recipeItems(s.request)){
   if(seen.has(item.product.name))continue;seen.add(item.product.name);
   const result=await run.call('product_find',{query:item.product.name});
   const found=result.products.filter(p=>(!item.product.brand||p.brand===item.product.brand)&&(!item.product.sku||p.sku===item.product.sku));
   if(found.length===1&&found[0].hasOptions&&!result.options)await run.call('product_options',{productRef:found[0].productRef});
  }
 }
 const result=await run.call(s.saved?'order_prepare_saved':'order_prepare',s.saved?{name:run.s.recipeName}:{items:recipeItems(s.request).map(({product,...rest})=>({...product,...rest,choices:rest.choices??[],quantity:rest.quantity??1,instruction:rest.instruction??''})),...(s.request.fulfillment.type==='pickup'?{pickupStore:s.request.fulfillment.store}:{deliveryAddressId:s.request.fulfillment.addressId}),...(s.request.paymentLast4?{paymentLast4:s.request.paymentLast4}:{})});
 const summary=run.grade(result.status==='prepared'?`Prepared for review: $${result.review.amounts.order_total}.${s.budget?' Above the $20 limit.':''} Not purchased.`:`Stopped: ${result.error?.code}. Not purchased.`);summaries.push(summary);console.log(JSON.stringify(summary));
}
await fs.writeFile(path.join(output,'summary.json'),JSON.stringify({author:'primary coding agent',summaries},null,2),{mode:0o600});
if(summaries.some(s=>!s.passed))process.exitCode=1;
