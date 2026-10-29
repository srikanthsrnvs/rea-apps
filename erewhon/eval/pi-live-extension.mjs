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
  const allowed=new Set(['product_find','product_options','recipe_show','order_prepare','order_status']);
  for(const tool of orderingToolManifest.tools.filter(tool=>allowed.has(tool.name)))pi.registerTool({
    name:tool.name,label:tool.name,description:tool.description,parameters:tool.inputSchema,
    async execute(_id,args){
      const commands={product_find:['product','find','--query',args.query],product_options:['product','options','--product-ref',args.productRef],recipe_show:['recipe','show','--name',args.name],order_status:['order','status','--plan-id',args.planId],
        order_prepare:args.request?['order','prepare','--json',JSON.stringify(args.request)]:['order','prepare','--recipe',args.recipe]};
      let result;
      try{
        const response=await exec('ssh',['-S',socket,'-o','BatchMode=yes','-o','HostKeyAlias=truffle-2217.local','-o','StrictHostKeyChecking=yes',host,[cli,...commands[tool.name]].map(quote).join(' ')],{timeout:60_000,maxBuffer:2*1024*1024});
        result=JSON.parse(response.stdout);
      }catch(error){try{result=JSON.parse(error.stderr);}catch{result={error:{message:'The remote CLI did not return a confirmed result. No request was repeated.'}};}}
      if(process.env.EREWHON_EVAL_TRACE)fs.appendFileSync(process.env.EREWHON_EVAL_TRACE,JSON.stringify({name:tool.name,args,result})+'\n',{mode:0o600});
      return {content:[{type:'text',text:JSON.stringify(result)}],details:{},...(result.error?{isError:true}:{})};
    }
  });
  pi.on('before_agent_start',()=>({systemPrompt:'You are a shopping assistant. Use the provided tools to fulfill the user request. Report actual outcomes accurately.'}));
}
