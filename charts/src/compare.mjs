import { ChartsError } from './errors.mjs';
import { candleResult, instrument, seriesSummary } from './normalize.mjs';
const rounded=n=>Number.isFinite(n)?Math.round(n*1e6)/1e6:null;
export function pearson(a,b){
  if(a.length!==b.length||a.length<2)return null;
  const am=a.reduce((s,x)=>s+x,0)/a.length,bm=b.reduce((s,x)=>s+x,0)/b.length;
  let aa=0,bb=0,ab=0;
  for(let i=0;i<a.length;i++){const x=a[i]-am,y=b[i]-bm;aa+=x*x;bb+=y*y;ab+=x*y;}
  return aa&&bb?rounded(Math.max(-1,Math.min(1,ab/Math.sqrt(aa*bb)))):null;
}
export function compareResult(raw,queries,{includeData=false}={}){
  const normalized=raw.map((rows,i)=>candleResult(rows,queries[i]));
  const indexes=normalized.map(series=>new Map(series.data.map(row=>[row.time,row])));
  const times=normalized[0].data.map(row=>row.time).filter(t=>indexes.every(index=>index.has(t)));
  if(times.length<2)throw new ChartsError('NO_DATA','Comparison requires at least two timestamps shared by every series. No missing values were invented.');
  const aligned=indexes.map(index=>times.map(t=>index.get(t)));
  const returns=aligned.map(rows=>rows.slice(1).map((row,i)=>rows[i].close===0?null:(row.close/rows[i].close-1)*100));
  const correlations=[];
  for(let i=0;i<aligned.length;i++)for(let j=i+1;j<aligned.length;j++){
    const points=returns[i].flatMap((x,k)=>x!==null&&returns[j][k]!==null?[[x,returns[j][k]]]:[]);
    correlations.push({left:queries[i].symbol,right:queries[j].symbol,returnCorrelation:pearson(points.map(x=>x[0]),points.map(x=>x[1])),observations:points.length});
  }
  const dropped=normalized.map((series,i)=>({symbol:queries[i].symbol,count:series.data.length-times.length}));
  const query=queries[0];
  let previewIndexes=[...new Set([0,...times.map((t,i)=>i===times.length-1||new Date(t*1000).getUTCMonth()!==new Date(times[i+1]*1000).getUTCMonth()?i:-1).filter(i=>i>=0)])];
  if(previewIndexes.length>12)previewIndexes=Array.from({length:12},(_,i)=>previewIndexes[Math.round(i*(previewIndexes.length-1)/11)]);
  const data={window:{requestedFrom:query.from===undefined?null:new Date(query.from*1000).toISOString(),requestedTo:query.to===undefined?null:new Date(query.to*1000).toISOString(),
    firstObservation:new Date(times[0]*1000).toISOString(),lastObservation:new Date(times.at(-1)*1000).toISOString(),timeframe:query.timeframe,observations:times.length,lastBarMayBeOpen:true},
    series:aligned.map((rows,i)=>({...instrument(queries[i].symbol),...seriesSummary(rows),sourceObservations:normalized[i].data.length})),
    correlations,correlationMethod:'Pearson correlation of percentage changes between consecutive matched observations in the same interval; this does not establish causation.',
    interpretationLimits:['Correlation compares same-interval changes, not next-day prediction or profit/loss.',
      'Position quantities alone do not establish trader motives, leverage ratios, liquidation risk or buying-the-dip behavior.',
      'Report the measured changes and strength of linear association; explanations of why they occurred are not available in this result.'],
    alignment:{method:'timestamp_intersection',filledMissingValues:false,droppedObservations:dropped},
    chart:{kind:'line_overlay',normalization:'percent_change_from_first_shared_observation',timeUnit:'unix_seconds',rendered:false,availablePoints:times.length,dataIncluded:includeData,
      preview:previewIndexes.map(k=>({at:new Date(times[k]*1000).toISOString(),values:Object.fromEntries(queries.map((q,i)=>[q.symbol,aligned[i][0].close===0?null:rounded((aligned[i][k].close/aligned[i][0].close-1)*100)]))})),
      ...(includeData?{columns:['time',...queries.map(q=>q.symbol)],rows:times.map((time,k)=>[time,...aligned.map(rows=>rows[0].close===0?null:rounded((rows[k].close/rows[0].close-1)*100))]),rawRows:times.map((time,k)=>[time,...aligned.map(rows=>rows[k].close)])}:{})}};
  return{data,warnings:[...new Set(normalized.flatMap(s=>s.warnings)),...(dropped.some(x=>x.count)?['UNMATCHED_TIMESTAMPS_EXCLUDED']:[]),'CORRELATION_IS_NOT_CAUSATION']};
}
