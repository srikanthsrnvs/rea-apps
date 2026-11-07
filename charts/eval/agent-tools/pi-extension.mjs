import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { toolDefinitions } from '../../src/tool-definitions.mjs';
import { fixture } from './fixture.mjs';
import { systemPrompt as defaultSystemPrompt } from './scenarios.mjs';
import { createCharts } from '../../src/service.mjs';
import { publicError } from '../../src/errors.mjs';
import { modelView } from '../../src/presentation.mjs';

export default async function(pi){
  fs.writeFileSync(process.env.CHARTS_EVAL_CASE_DIR+'/runtime.json',JSON.stringify({node:process.version,platform:process.platform,arch:process.arch}),{mode:0o600});
  const {systemPrompt}=process.env.CHARTS_EVAL_SCENARIOS?await import(pathToFileURL(process.env.CHARTS_EVAL_SCENARIOS).href):{systemPrompt:defaultSystemPrompt};
  const live=process.env.CHARTS_EVAL_LIVE==='1';
  const world=live?null:await fixture(process.env.CHARTS_EVAL_CASE_DIR,process.env.CHARTS_EVAL_CASE);
  const service=live?createCharts():null;
  const tools=process.env.CHARTS_EVAL_PROFILE==='baseline'
    ?JSON.parse(fs.readFileSync(process.env.CHARTS_EVAL_BASELINE_TOOLS,'utf8')):toolDefinitions;
  for(const tool of tools)pi.registerTool({
    name:tool.name,label:tool.name,description:tool.description,parameters:tool.inputSchema,
    async execute(_id,args){
      let result;
      if(!live)result=await world.call(tool.name,args);
      else{
        const allowed=['symbols search','symbol','quotes','candles','compare','technicals','snapshot','screen','indicator','indicators search','indicator values','screener','screener fields','hotlist','chart','stream quotes','stream candles','stream indicator',...(process.env.CHARTS_EVAL_EDITOR==='1'?['view create','view state','view update','view close']:[])];
        if(!allowed.includes(tool.command)||args.auth==='required')result={status:'error',error:{code:'EVALUATION_MUTATION_BLOCKED',message:'This live evaluation allows public reads only.'}};
        else try{result=await service.execute(tool.name,{...args,...(tool.inputSchema.properties.auth?{auth:'anonymous'}:{})});}catch(error){const detail=publicError(error);result={status:'error',error:detail};}
        fs.appendFileSync(process.env.CHARTS_EVAL_CASE_DIR+'/live-trace.jsonl',JSON.stringify({name:tool.name,args,result})+'\n',{mode:0o600});
      }
      const text=JSON.stringify(process.env.CHARTS_EVAL_PROFILE==='baseline'?result:modelView(result));
      fs.appendFileSync(process.env.CHARTS_EVAL_CASE_DIR+'/model-output.jsonl',JSON.stringify({name:tool.name,args,bytes:Buffer.byteLength(text)})+'\n',{mode:0o600});
      return{content:[{type:'text',text}],details:{structuredContent:result},...(result.status==='error'?{isError:true}:{})};
    },
  });
  pi.on('before_agent_start',()=>({systemPrompt}));
}
