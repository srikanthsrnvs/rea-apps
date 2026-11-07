import {createChart,LineSeries,CandlestickSeries,LineStyle} from '/charts.mjs';
const $=id=>document.getElementById(id),key=new URLSearchParams(location.hash.slice(1)).get('key');
let state,chart,priceSeries=new Map(),applying=false,drawingMode=null,drawingStart=null,polling=false,drawPointHandler,pointerStart;
const status=(text,error=false)=>{$('status').textContent=text;$('status').classList.toggle('error',error);};
async function request(route,body){
 if(!key)throw Error('Open the complete chart link, including its access key.');
 const res=await fetch(route,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store',credentials:'omit'});
 const data=await res.json();if(!res.ok)throw Error(data.error?.message??'Chart connection failed.');return data;
}
async function edit(changes){
 try{status('Applying changes…');const next=await request('/api/edit',{revision:state.revision,changes});render(next);}
 catch(error){status(error.message,true);try{const next=await request('/api/view');if(next.revision!==state.revision)render(next);}catch{}}
}
function element(tag,props={}){const el=document.createElement(tag);for(const[k,v]of Object.entries(props)){if(k==='text')el.textContent=v;else el[k]=v;}return el;}
function options(values,current){const el=element('select');for(const value of values)el.append(element('option',{value,text:value,selected:value===current}));return el;}
function render(next){
 const oldRange=chart?.timeScale().getVisibleRange(),old=state?.config;
 state=next;applying=true;chart?.remove();priceSeries=new Map();
 const c=state.config,dark=c.theme==='dark';document.body.classList.toggle('light',!dark);$('title').textContent=c.title;document.title=c.title;
 chart=createChart($('chart'),{autoSize:true,layout:{background:{color:dark?'#10141d':'#ffffff'},textColor:dark?'#aebbd0':'#536276',attributionLogo:true},grid:{vertLines:{color:dark?'#1d2738':'#edf0f5'},horzLines:{color:dark?'#1d2738':'#edf0f5'}},rightPriceScale:{mode:c.scale==='log'?1:0,borderColor:dark?'#2a3447':'#dbe1ea'},timeScale:{timeVisible:c.timeframe!=='D'&&c.timeframe!=='W',secondsVisible:false,borderColor:dark?'#2a3447':'#dbe1ea'},crosshair:{mode:0}});
 const panes=[...new Set([...state.data.series.filter(s=>s.visible!==false).map(s=>s.pane??0),...state.data.studies.map(s=>s.pane??(s.kind==='RSI'?1:0))])].sort((a,b)=>a-b),paneIndex=p=>Math.max(0,panes.indexOf(p));
 $('legend').replaceChildren();
 for(const series of state.data.series){if(series.visible===false)continue;
  const api=chart.addSeries(series.kind==='candlestick'?CandlestickSeries:LineSeries,{title:series.symbol,color:series.color,lineWidth:2,upColor:'#2ed3b7',downColor:'#ff6b8b',borderVisible:false,wickUpColor:'#2ed3b7',wickDownColor:'#ff6b8b',priceFormat:{type:'price',precision:2,minMove:.01}},paneIndex(series.pane??0));
  api.setData(series.data);priceSeries.set(series.id,api);
  const last=series.data.at(-1),unit=c.normalization==='percent'?'%':c.normalization==='indexed'?'index':series.instrument.unit??'';
  const label=element('span',{text:`${series.symbol}  ${Number(last?.value??last?.close).toLocaleString(undefined,{maximumFractionDigits:2})} ${unit}`});label.style.color=series.color;$('legend').append(label);
 }
 for(const study of state.data.studies){const api=chart.addSeries(LineSeries,{title:`${study.kind} ${study.length}`,color:study.color??'#c695ff',lineWidth:2,priceLineVisible:false,lastValueVisible:true},paneIndex(study.pane??(study.kind==='RSI'?1:0)));api.setData(study.data);}
 for(const drawing of c.drawings){const target=priceSeries.get(drawing.series);if(!target)continue;
  if(drawing.kind==='horizontal')target.createPriceLine({price:drawing.start.value,color:drawing.color??'#ffb454',lineWidth:2,lineStyle:LineStyle.Dashed,axisLabelVisible:true,title:drawing.label??''});
  else{const source=c.series.find(s=>s.id===drawing.series);const line=chart.addSeries(LineSeries,{color:drawing.color??'#ffb454',lineWidth:2,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false},paneIndex(source.pane??0));line.setData([drawing.start,drawing.end].sort((a,b)=>a.time-b.time).map(p=>({time:p.time,value:p.value})));}
 }
 if(c.range)chart.timeScale().setVisibleRange(c.range);
 else if(oldRange&&old?.timeframe===c.timeframe&&old?.period===c.period&&old?.from===c.from&&old?.to===c.to)chart.timeScale().setVisibleRange(oldRange);
 else chart.timeScale().fitContent();
 const drawPoint=event=>{
  if(!drawingMode||!event.point||!event.time)return;
  const entry=[...priceSeries.entries()][0];if(!entry)return;
  const [series,api]=entry,value=api.coordinateToPrice(event.point.y),time=typeof event.time==='number'?event.time:Date.parse(event.time)/1000;
  if(event.paneIndex!==paneIndex(c.series.find(s=>s.id===series).pane??0))return;
  if(!Number.isFinite(value)||!Number.isFinite(time))return;
  const point={time,value};if(drawingMode==='trendline'&&!drawingStart){drawingStart=point;status('Click the second point.');return;}
  const drawing={id:newId(),kind:drawingMode,series,start:drawingStart??point,color:'#ffb454',...(drawingStart?{end:point}:{})};drawingMode=null;drawingStart=null;chart.applyOptions({handleScroll:true,handleScale:true});$('chart').style.cursor='';edit({drawings:[...state.config.drawings,drawing]});
 };
 drawPointHandler=drawPoint;
 populateEditor();$('details').textContent=`${state.data.series[0]?.coverage.firstObservation?.slice(0,10)??''} — ${state.data.series[0]?.coverage.lastObservation?.slice(0,10)??''} · ${c.normalization==='percent'?'0% baseline':c.normalization==='indexed'?'100 baseline':'raw prices'} · ${state.data.studies.length?'Local indicators · ':''}Snapshot ${state.data.fetchedAt} · revision ${state.revision}`;
 status(`Connected · ${c.timeframe} · ${c.scale} · revision ${state.revision} · ${state.data.series.reduce((n,s)=>n+s.data.length,0).toLocaleString()} points`);applying=false;
 window.chartEditor={get state(){return state;},get chart(){return chart;},edit};
}
function populateEditor(){
 const c=state.config;$('title-input').value=c.title;
 for(const id of ['timeframe','period','normalization','scale','theme']){if(c[id]!==undefined){if(![...$(id).options].some(o=>o.value===c[id]))$(id).append(element('option',{value:c[id],text:c[id]}));$(id).value=c[id];}}
 $('series-editor').replaceChildren();$('study-source').replaceChildren();
 c.series.forEach((s,index)=>{
  $('study-source').append(element('option',{value:s.symbol,text:s.symbol}));const box=element('div',{className:'item'});box.append(element('strong',{text:s.symbol}));
  const row=element('div',{className:'row'}),color=element('input',{type:'color',value:s.color}),kind=options(['line','candlestick'],s.kind),pane=element('input',{type:'number',min:0,max:5,value:s.pane??0,title:'Pane'}),remove=element('button',{text:'×',title:'Remove series'});
  const replace=change=>edit({series:c.series.map((x,i)=>i===index?{...x,...change}:x)});color.onchange=()=>replace({color:color.value});kind.onchange=()=>replace({kind:kind.value});pane.onchange=()=>replace({pane:Number(pane.value)});remove.onclick=()=>edit({series:c.series.filter((_,i)=>i!==index),studies:c.studies.filter(x=>x.symbol!==s.symbol),drawings:c.drawings.filter(x=>x.series!==s.id)});
  row.append(color,kind,pane,remove);box.append(row);$('series-editor').append(box);
 });
 for(const [id,items]of [['studies-editor',c.studies],['drawings-editor',c.drawings]]){$(id).replaceChildren();items.forEach((item,index)=>{const row=element('div',{className:'item row'}),remove=element('button',{text:'Remove'});row.append(element('span',{text:item.kind+(item.length?` ${item.length}`:'')}),remove);remove.onclick=()=>edit({[id==='studies-editor'?'studies':'drawings']:items.filter((_,i)=>i!==index)});$(id).append(row);});}
}
$('edit-toggle').onclick=()=>$('editor').classList.toggle('hidden');
$('fit').onclick=()=>chart.timeScale().fitContent();
$('save-zoom').onclick=()=>{const range=chart.timeScale().getVisibleRange();if(range)edit({range});};
$('apply-settings').onclick=()=>edit({title:$('title-input').value,timeframe:$('timeframe').value,period:$('period').value,normalization:$('normalization').value,scale:$('scale').value,theme:$('theme').value});
const newId=()=>globalThis.crypto?.randomUUID?.()??`item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
$('add-series').onclick=()=>{const symbol=$('new-symbol').value.trim().toUpperCase();if(symbol)edit({series:[...state.config.series,{id:newId(),symbol,kind:'line',color:'#ffb454',pane:0,visible:true}]});};
$('add-study').onclick=()=>edit({studies:[...state.config.studies,{id:newId(),symbol:$('study-source').value,kind:$('study-kind').value,length:Number($('study-length').value),pane:$('study-kind').value==='RSI'?1:0,color:'#c695ff'}]});
for(const[kind,id]of [['trendline','draw-line'],['horizontal','draw-level']])$(id).onclick=()=>{drawingMode=kind;drawingStart=null;chart.applyOptions({handleScroll:false,handleScale:false});$('chart').style.cursor='crosshair';status(kind==='trendline'?'Click the first point of the trendline.':'Click the level on the first visible series.');};
$('chart').addEventListener('pointerdown',e=>{pointerStart={x:e.clientX,y:e.clientY};},true);
$('chart').addEventListener('pointerup',e=>{
 if(!drawingMode||!pointerStart||Math.hypot(e.clientX-pointerStart.x,e.clientY-pointerStart.y)>5)return;
 const rect=$('chart').getBoundingClientRect(),point={x:e.clientX-rect.left,y:e.clientY-rect.top};
 if(point.y>chart.panes()[0].getHeight())return;
 drawPointHandler({point,time:chart.timeScale().coordinateToTime(point.x),paneIndex:0});
},true);
async function poll(){if(polling||applying)return;polling=true;try{const next=await request(`/api/view?revision=${state?.revision??0}`);if(!next.unchanged&&(!state||next.revision!==state.revision))render(next);}catch(error){applying=false;status(error.message,true);}finally{polling=false;}}
await poll();setInterval(poll,1200);
