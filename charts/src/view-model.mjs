import { ChartsError } from './errors.mjs';
import { validateArguments, chartQuery } from './validation.mjs';

const text=(description,extra={})=>({type:'string',description,maxLength:120,...extra});
const color={type:'string',pattern:'^#[0-9a-fA-F]{6}$'};
const integer=(minimum,maximum)=>({type:'integer',minimum,maximum});
const point={type:'object',additionalProperties:false,required:['time','value'],properties:{time:integer(0,10000000000),value:{type:'number'}}};
const entries=(properties,maxItems=12,required=['id'])=>({type:'array',maxItems,items:{type:'object',additionalProperties:false,required,properties}});
export const viewProperties={
 title:text('Chart title.'),timeframe:text('D, W, 1h, 15m etc.'),
 count:integer(2,5000),period:{type:'string',enum:['year_to_date','last_calendar_month','last_30_days','last_90_days','last_365_days']},
 from:text('ISO timestamp with timezone or Unix seconds.'),to:text('ISO timestamp with timezone or Unix seconds.'),
 normalization:{type:'string',enum:['price','percent','indexed'],description:'Raw price, percent change from zero, or index starting at 100. Applies separately to each price series.'},
 theme:{type:'string',enum:['dark','light']},scale:{type:'string',enum:['linear','log']},
 chartType:{type:'string',enum:['line','candlestick'],description:'Primary series display style. Set candlestick explicitly when switching to candles.'},
 removeSeries:{type:'array',items:text('Series ID to remove.'),maxItems:6},
 removeStudies:{type:'array',items:text('Study ID to remove.'),maxItems:12},
 removeDrawings:{type:'array',items:text('Drawing ID to remove.'),maxItems:40},
 series:entries({id:text('Stable series ID from view state.'),symbol:text('Exchange-qualified market symbol.'),color,kind:{type:'string',enum:['line','candlestick']},pane:integer(0,5),visible:{type:'boolean'}},6),
 studies:entries({id:text('Optional stable study ID; generated for new entries.'),symbol:text('Symbol present in series; defaults to the first series when adding a study.'),kind:{type:'string',enum:['SMA','EMA','RSI']},length:integer(2,300),pane:integer(0,5),color},12,[]),
 drawings:entries({id:text('Optional stable drawing ID; generated for new entries.'),series:text('Series ID whose displayed units the drawing uses.'),kind:{type:'string',enum:['horizontal','trendline']},start:point,end:point,color,label:text('Drawing label.')},40,[]),
 range:{type:'object',additionalProperties:false,properties:{from:integer(0,10000000000),to:integer(0,10000000000)},required:['from','to']},
};
export const viewChangeSchema={type:'object',properties:viewProperties,additionalProperties:false};
const invalid=message=>{throw new ChartsError('INVALID_ARGUMENT',message);};
export function validateView(config){
 const c=validateArguments({inputSchema:viewChangeSchema},config);
 if(!c.series?.length)invalid('A view needs at least one series.');
 if(new Set(c.series.map(s=>s.id)).size!==c.series.length)invalid('Series IDs must be unique.');
 const ids=new Set(c.series.map(s=>s.id)),symbols=new Set(c.series.map(s=>s.symbol));
 for(const [i,s] of c.series.entries()){
  if(!s.symbol)invalid('Each series needs a symbol.');
  s.kind??='line';s.color??=palette[i];s.pane??=0;s.visible??=true;
  chartQuery({...c,symbol:s.symbol},Date.now());
 }
 const query=chartQuery({...c,symbol:c.series[0].symbol},Date.now());
 const match=/^(\d+)?([SDW])$/u.exec(query.timeframe);
 const seconds=/^\d+$/u.test(query.timeframe)?Number(query.timeframe)*60:match?Number(match[1]??1)*({S:1,D:86400,W:604800}[match[2]]):null;
 if(query.from!==undefined&&seconds){
  const needed=Math.ceil(((query.to??Date.now()/1000)-query.from)/seconds)+1;
  if(needed>5000)invalid('This date window exceeds 5000 bars. Choose a wider timeframe or shorter date window.');
  c.count=Math.max(c.count??1000,needed);
 }
 for(const collection of [c.studies??[],c.drawings??[]])if(new Set(collection.map(s=>s.id)).size!==collection.length)invalid('Study and drawing IDs must be unique.');
 for(const s of c.studies??[]){s.symbol??=c.series[0].symbol;if(!symbols.has(s.symbol)||!s.kind||!s.length)invalid('A study needs a symbol in this view, kind and length.');s.pane??=s.kind==='RSI'?1:0;s.color??='#c695ff';}
 for(const d of c.drawings??[]){
  if(!ids.has(d.series)||!d.kind||!d.start)invalid('A drawing needs a series ID, kind and start point.');
  if(d.kind==='trendline'&&(!d.end||d.end.time===d.start.time))invalid('A trendline needs two points at different times.');
  if(c.scale==='log'&&(d.start.value<=0||d.end?.value<=0))invalid('Log-scale drawings need positive values in displayed price units.');
 }
 if(c.range&&c.range.from>=c.range.to)invalid('Visible range must have from before to.');
 if(c.scale==='log'&&c.normalization!=='price')invalid('Log scale requires raw positive prices; switch normalization to price.');
 return c;
}
const palette=['#5b8cff','#ffb454','#2ed3b7','#c695ff','#ff6b8b','#8bd450'];
export function initialView(args){
 if(args.period&&(args.from!==undefined||args.to!==undefined))invalid('Use period or from/to, not both.');
 return validateView({title:args.title??'Market chart',timeframe:args.timeframe??'D',count:args.count??1000,
  ...(args.from!==undefined||args.to!==undefined?{...(args.from!==undefined?{from:args.from}:{}),...(args.to!==undefined?{to:args.to}:{})}:{period:args.period??'year_to_date'}),
  normalization:args.normalization??(args.symbols.length>1?'percent':'price'),theme:args.theme??'dark',scale:'linear',
  series:args.symbols.map((symbol,i)=>({id:`s${i+1}`,symbol,kind:args.symbols.length===1?'candlestick':'line',color:palette[i],pane:0,visible:true})),studies:[],drawings:[]});
}
export function changeView(current,input){
 const change=validateArguments({inputSchema:viewChangeSchema},input),next={...current,...change};
 for(const key of ['series','studies','drawings'])if(change[key])next[key]=change[key].map((item,i)=>{
  const old=current[key].find(existing=>item.id&&existing.id===item.id);
  return{...old,...item,id:item.id??`${key}-${i+1}`};
 });
 for(const [key,removeKey]of [['series','removeSeries'],['studies','removeStudies'],['drawings','removeDrawings']]){if(change[removeKey])next[key]=next[key].filter(item=>!change[removeKey].includes(item.id));delete next[removeKey];}
 if(change.chartType&&next.series[0])next.series=next.series.map((s,i)=>i===0?{...s,kind:change.chartType}:s);
 delete next.chartType;
 const symbols=new Set(next.series.map(s=>s.symbol)),ids=new Set(next.series.map(s=>s.id));
 if(change.removeSeries){next.studies=next.studies.filter(s=>symbols.has(s.symbol));next.drawings=next.drawings.filter(s=>ids.has(s.series));}
 if(change.period!==undefined){delete next.from;delete next.to;}
 if(change.from!==undefined||change.to!==undefined)delete next.period;
 return validateView(next);
}
export function calculateStudy(rows,kind,length){
 const out=[];let seed=0,ema,gain=0,loss=0;
 for(let i=0;i<rows.length;i++){
  const value=rows[i].close;
  if(kind==='SMA'){seed+=value;if(i>=length)seed-=rows[i-length].close;if(i>=length-1)out.push({time:rows[i].time,value:seed/length});}
  else if(kind==='EMA'){if(i<length)seed+=value;if(i===length-1)ema=seed/length;else if(i>=length)ema=value*(2/(length+1))+ema*(1-2/(length+1));if(ema!==undefined)out.push({time:rows[i].time,value:ema});}
  else if(i>0){const delta=value-rows[i-1].close;
   if(i<=length){gain+=Math.max(delta,0)/length;loss+=Math.max(-delta,0)/length;}
   else{gain=(gain*(length-1)+Math.max(delta,0))/length;loss=(loss*(length-1)+Math.max(-delta,0))/length;}
   if(i>=length)out.push({time:rows[i].time,value:loss===0?(gain===0?50:100):100-100/(1+gain/loss)});
  }
 }
 return out;
}
export async function buildView(config,service,auth='anonymous'){
 const histories=new Map(),warnings=[];
 for(const symbol of new Set(config.series.map(s=>s.symbol))){
  const args={symbol,timeframe:config.timeframe,count:config.count,auth,'timeout-ms':30000};
  for(const key of ['period','from','to'])if(config[key]!==undefined)args[key]=config[key];
  const r=await service.execute('candles',args);histories.set(symbol,r);warnings.push(...r.warnings);
 }
 const scale=(symbol,value)=>{const base=histories.get(symbol).data[0]?.close;
  return config.normalization==='price'?value:base===0?null:(value/base-1)*100+(config.normalization==='indexed'?100:0);};
 const series=config.series.map(s=>{const r=histories.get(s.symbol);
  return{...s,instrument:r.instrument,coverage:r.coverage,data:r.data.map(row=>s.kind==='candlestick'?{time:row.time,open:scale(s.symbol,row.open),high:scale(s.symbol,row.high),low:scale(s.symbol,row.low),close:scale(s.symbol,row.close)}:{time:row.time,value:scale(s.symbol,row.close)}).filter(row=>Object.values(row).every(Number.isFinite))};});
 const studies=config.studies.map(s=>({...s,calculation:'local',data:calculateStudy(histories.get(s.symbol).data,s.kind,s.length).map(row=>({...row,value:s.kind==='RSI'?row.value:scale(s.symbol,row.value)})).filter(row=>Number.isFinite(row.value))}));
 if(config.scale==='log'&&series.some(s=>s.data.some(row=>(row.value??row.low)<=0)))invalid('Log scale cannot display non-positive values.');
 return{series,studies,warnings:[...new Set([...warnings,...(studies.length?['LOCAL_STUDIES_NOT_PINE']:[])])],fetchedAt:new Date().toISOString()};
}
