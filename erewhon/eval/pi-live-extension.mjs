import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { orderingToolManifest } from '../src/tools.mjs';
const exec=promisify(execFile);
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";

// Deliberately excludes order_confirm: this evaluation cannot place or pay.
export default function (pi) {
  const host=process.env.EREWHON_EVAL_SSH_HOST;
  const socket=process.env.EREWHON_EVAL_SSH_SOCKET;
  if(!host||!socket)throw new Error('Set EREWHON_EVAL_SSH_HOST and EREWHON_EVAL_SSH_SOCKET.');
  const cli=process.env.EREWHON_EVAL_REMOTE_CLI ?? '/home/truffle/.local/bin/erewhon';
  const allowed=new Set(['product_find','product_options','recipe_show','order_prepare','order_prepare_saved','order_status','addresses','cart_add_saved','cart_set_quantity','cart_view','order_prepare_cart']);
  for(const tool of orderingToolManifest.tools.filter(tool=>allowed.has(tool.name)))pi.registerTool({
    name:tool.name,label:tool.name,description:tool.description,parameters:tool.inputSchema,
    async execute(_id,args){
      const commands={cart_add_saved:['cart','add-saved','--name',args.name,...(args.quantity!==undefined?['--quantity',String(args.quantity)]:[])],cart_set_quantity:['cart','set-quantity','--item-ref',args.itemRef,'--quantity',String(args.quantity)],cart_view:['cart','view'],order_prepare_cart:['order','prepare'],order_prepare_saved:['order','prepare','--recipe',args.name],addresses:['addresses'],product_find:['product','find','--json',JSON.stringify(args)],product_options:['product','options','--product-ref',args.productRef],recipe_show:['recipe','show','--name',args.name],order_status:['order','status','--plan-id',args.planId],
        order_prepare:args.recipe?['order','prepare','--recipe',args.recipe]:['order','prepare','--json',JSON.stringify(args)]};
      let result;
      const readOnly=process.env.EREWHON_EVAL_READ_ONLY==='1';
      const mutations=new Set(['order_prepare','order_prepare_saved','order_prepare_cart','cart_add_saved','cart_set_quantity']);
      if(readOnly&&mutations.has(tool.name))result={error:{code:'EVALUATION_READ_ONLY',message:'This evaluation stops before cart changes or checkout. No mutation was submitted. Report the selected proposal only; do not retry.'},orderPrepared:false,orderPlaced:false,proposedRequest:args};
      else try{
        const response=await exec('ssh',['-S',socket,'-o','BatchMode=yes','-o',`HostKeyAlias=${process.env.EREWHON_EVAL_SSH_ALIAS??'truffle-2217.local'}`,'-o','StrictHostKeyChecking=yes',host,[cli,...commands[tool.name]].map(quote).join(' ')],{timeout:60_000,maxBuffer:2*1024*1024});
        result=JSON.parse(response.stdout);
      }catch(error){try{result=JSON.parse(error.stderr);}catch{result={error:{message:'The remote CLI did not return a confirmed result. No request was repeated.'}};}}
      if(process.env.EREWHON_EVAL_TRACE)fs.appendFileSync(process.env.EREWHON_EVAL_TRACE,JSON.stringify({name:tool.name,args,result})+'\n',{mode:0o600});
      return {content:[{type:'text',text:JSON.stringify(result)}],details:{},...(result.error?{isError:true}:{})};
    }
  });
  pi.on('before_agent_start',()=>({systemPrompt:'You are a shopping assistant. Use the provided tools to fulfill the user request. Report actual outcomes accurately.'}));
}
