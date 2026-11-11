import test from 'node:test';
import assert from 'node:assert/strict';
import extension from '../eval/pi-live-extension.mjs';

test('open-ended live evaluation blocks every exposed cart/checkout mutation before SSH',async()=>{
 const keys=['EREWHON_EVAL_SSH_HOST','EREWHON_EVAL_SSH_SOCKET','EREWHON_EVAL_READ_ONLY','EREWHON_EVAL_TRACE'];
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 Object.assign(process.env,{EREWHON_EVAL_SSH_HOST:'unreachable.invalid',EREWHON_EVAL_SSH_SOCKET:'/does-not-exist',EREWHON_EVAL_READ_ONLY:'1'});delete process.env.EREWHON_EVAL_TRACE;
 try{
  const tools=[];extension({registerTool:tool=>tools.push(tool),on:()=>{}});
  assert.equal(tools.some(tool=>tool.name==='order_confirm'),false);
  for(const name of ['order_prepare','order_prepare_saved','order_prepare_cart','cart_add_saved','cart_set_quantity']){
   const tool=tools.find(tool=>tool.name===name);assert.ok(tool);
   const result=await tool.execute('test',{name:'test',itemRef:'test',quantity:1});
   const data=JSON.parse(result.content[0].text);assert.equal(result.isError,true);
   assert.equal(data.error.code,'EVALUATION_READ_ONLY');assert.equal(data.orderPrepared,false);assert.equal(data.orderPlaced,false);
  }
 }finally{for(const [key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
