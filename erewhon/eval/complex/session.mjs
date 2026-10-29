import fs from 'node:fs';
import {backend} from './backend.mjs';
import {scenarios,setup} from './scenarios.mjs';
import {orderingToolManifest,advancedToolManifest} from '../../src/tools.mjs';
import {recipeItems,validateRecipe} from '../../src/recipes.mjs';
const norm=v=>String(v??'').trim().toLowerCase();
export const tools=orderingToolManifest.tools.filter(t=>t.name!=='order_confirm');
export async function session(key,trace,{includeLegacyTools=false}={}){
 const legacyNames=new Set(['addresses','recipe_save','recipe_show','recipe_reset']);
 const availableTools=includeLegacyTools?[...tools,...advancedToolManifest.tools.filter(tool=>legacyNames.has(tool.name))]:tools;
 const f=backend(),s=await setup(f,key),start=f.calls.length,initial=structuredClone(f.rows),events=[];
 const record=e=>{events.push(e);if(trace)fs.appendFileSync(trace,JSON.stringify(e)+'\n',{mode:0o600});};
 record({type:'setup',scenario:key,prompt:s.prompt,initialRows:initial.length,confirmationExposed:false});
 let count=0;
 async function call(name,args){
  if(!availableTools.some(t=>t.name===name))throw new Error(`Tool unavailable: ${name}`);
  record({type:'call',name,args});let result;
  try {
   if(++count>16)throw new Error('Tool-call limit reached. Explain the blocker.');
   if(name==='order_prepare')result=await f.api.prepareRequest({request:args});
   else if(name==='cart_add_saved')result=await f.api.addSaved(args);
   else if(name==='cart_set_quantity')result=await f.ordering.setCartQuantity(args);
   else if(name==='cart_view')result=await f.ordering.viewCart();
   else if(name==='order_prepare_cart')result=await f.ordering.prepareOrder();
   else if(name==='order_prepare_saved')result=await f.api.prepare(args);
   else if(name==='addresses')result=await f.catalog.addresses();
   else if(name==='recipe_save')result=await f.api.save(args);
   else if(name==='recipe_show')result=await f.api.show(args);
   else if(name==='recipe_reset')result=await f.api.reset(args);
   else if(name==='product_find')result=await f.api.find(args);
   else if(name==='product_options')result=await f.api.options(args);
   else if(name==='order_status')result=await f.ordering.orderStatus(args);
   else throw new Error(`Unavailable tool ${name}`);
  }catch(e){result={error:{code:e.code??'TOOL_ERROR',message:e.message,...(e.details?{details:e.details}:{})}};}
  record({type:'result',name,result});return result;
 }
 function grade(final=''){
  const calls=events.filter(e=>e.type==='call'),results=events.filter(e=>e.type==='result');
  const actual=f.rows.map(row=>({name:row.product.name,brand:row.product.brands?.name,sku:row.product.sku,quantity:row.quantity,size:row.product.modifier_size?.find(s=>s._id===row.modifier_size_id)?.name,choices:(typeof row.selected_modifiers==='string'?JSON.parse(row.selected_modifiers):row.selected_modifiers??[]).flatMap(g=>g.modifiers.filter(m=>m.is_selected).map(m=>({group:g.name,option:m.name,count:m.count}))),instruction:row.product_instruction??''}));
  const shape=item=>JSON.stringify({name:norm(item.product?.name??item.name),brand:norm(item.product?.brand??item.brand),sku:item.product?.sku??item.sku,quantity:item.quantity??1,size:norm(item.size),choices:(item.choices??[]).map(c=>[norm(c.group),norm(c.option),c.count??1]).sort(),instruction:norm(item.instruction)});
  const sameBasket=JSON.stringify(actual.map(shape).sort())===JSON.stringify(recipeItems(validateRecipe(s.request)).map(shape).sort());
  const prepared=results.findLast(e=>e.result.status==='prepared')?.result;
  const endpointCalls=f.calls.slice(start);
  const placements=endpointCalls.filter(c=>c.path==='/v1/place_order').length;
  let passed=!placements;
  if(s.error){
   const discoveryStop = ['missing','ambiguous','unavailable','invalidtail'].includes(key) && results.some(e=>e.name==='product_find'||e.name==='product_options')
    && (key==='missing'?/cannot find|unable to find|could not find|not find|not.*available|unavailable/i.test(final):key==='ambiguous'?/which|brand|prefer|choose/i.test(final):/unavailable|not available|not.*offer|not.*available|only.*whole|isn.t listed|not listed/i.test(final));
   passed&&=(results.some(e=>e.result.error?.code===s.error)||discoveryStop)&&!prepared;
   if(s.occupied||s.partial)passed&&=JSON.stringify(f.rows)===JSON.stringify(initial);
   else if(s.error!=='PAYMENT_CHANGED')passed&&=f.rows.length===0;
  }else passed&&=sameBasket&&Boolean(prepared)&&prepared.orderPlaced===false&&final.includes(prepared.review.amounts.order_total);
  if(s.budget)passed&&=/exceed|over|above|does not fit|doesn.t fit/i.test(final);
  return {scenario:key,passed,calls:calls.map(e=>e.name),errors:results.filter(e=>e.result.error).map(e=>e.result.error.code),rows:f.rows.length,quantity:f.rows.reduce((n,r)=>n+r.quantity,0),adds:endpointCalls.filter(c=>c.path.startsWith('/v1/addtocart/')).length,placements,correctBasket:sameBasket,total:prepared?.review.amounts.order_total,final};
 }
 return {f,s,call,grade,tools:availableTools};
}
