import test from 'node:test';
import assert from 'node:assert/strict';
import { periodBounds } from '../src/periods.mjs';
import { compareResult, pearson } from '../src/compare.mjs';
import { createCharts } from '../src/service.mjs';
import { quote } from '../src/normalize.mjs';
import { modelView } from '../src/presentation.mjs';
const candle=(time,close)=>({time,open:close,high:close,low:close,close,volume:null});
const store={load:async()=>null};

test('calendar periods preserve year boundaries and leap-month endpoints',()=>{
  const a=periodBounds('last_calendar_month',Date.parse('2026-01-15T12:00:00Z'));
  assert.equal(new Date(a.from*1000).toISOString(),'2025-12-01T00:00:00.000Z');
  assert.equal(new Date(a.to*1000).toISOString(),'2025-12-31T23:59:59.000Z');
  const b=periodBounds('last_calendar_month',Date.parse('2024-03-10T00:00:00Z'));
  assert.equal(new Date(b.to*1000).toISOString(),'2024-02-29T23:59:59.000Z');
});

test('comparison uses matched timestamps, independent baselines and genuine units',()=>{
  const rows=[[candle(1,100),candle(2,125),candle(3,150)], [candle(1,50),candle(3,40),candle(4,60)]];
  const queries=['BITFINEX:BTCUSD','BITFINEX:BTCUSDLONGS'].map(symbol=>({symbol,count:3,timeframe:'D',from:1,to:4}));
  const {data,warnings}=compareResult(rows,queries,{includeData:true});
  assert.deepEqual(data.chart.rows,[[1,0,0],[3,50,-20]]);
  assert.deepEqual(data.chart.rawRows,[[1,100,50],[3,150,40]]);
  assert.equal(data.series[0].changePercent,50);assert.equal(data.series[1].changePercent,-20);
  assert.equal(data.series[1].unit,'BTC');assert.equal(data.chart.rendered,false);
  assert.equal(data.correlations[0].returnCorrelation,null);
  assert.ok(warnings.includes('UNMATCHED_TIMESTAMPS_EXCLUDED'));
  assert.equal(data.alignment.filledMissingValues,false);
});

test('undefined normalization and correlation stay null rather than invented zeros',()=>{
  const queries=['X:A','X:B'].map(symbol=>({symbol,count:3,timeframe:'D'}));
  const result=compareResult([[candle(1,0),candle(2,1),candle(3,2)],[candle(1,3),candle(2,3),candle(3,3)]],queries,{includeData:true});
  assert.equal(result.data.series[0].changePercent,null);
  assert.equal(result.data.chart.rows[0][1],null);
  assert.equal(result.data.correlations[0].returnCorrelation,null);
  assert.equal(pearson([1,2,3],[2,4,6]),1);assert.equal(pearson([1,2,3],[6,4,2]),-1);
});

test('model preview contains exact observations while renderer keeps every point',()=>{
  const start=Date.parse('2026-01-01T00:00:00Z')/1000;
  const raw=[Array.from({length:311},(_,i)=>candle(start+i*86400,100+i)),Array.from({length:311},(_,i)=>candle(start+i*86400,100-i/10))];
  const result=compareResult(raw,['X:A','X:B'].map(symbol=>({symbol,timeframe:'D',count:400})),{includeData:true});
  const view=modelView(result);
  assert.equal(view.data.chart.rows,undefined);assert.equal(view.data.chart.rawRows,undefined);
  assert.equal(result.data.chart.rows.length,311);assert.equal(result.data.chart.rawRows.length,311);
  assert.equal(view.data.chart.preview,undefined);
  assert.ok(result.data.chart.preview.length<=12);
  for(const observation of result.data.chart.preview){
    const time=Date.parse(observation.at)/1000;
    const row=result.data.chart.rows.find(row=>row[0]===time);
    assert.deepEqual(Object.values(observation.values),row.slice(1));
  }
  assert.equal(modelView({data:{price:12}}).data.price,12);
});

test('multi-series tool fetches sequentially and supplies compact aligned summaries',async()=>{
  let active=0,maxActive=0;const requests=[];
  const t=Date.parse('2026-01-01T00:00:00Z')/1000;
  const service=createCharts({store,now:()=> '2026-11-07T00:00:00Z',sdk:{getCandles:async q=>{
    requests.push(q);active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setImmediate(resolve));active--;
    return[candle(t,100),candle(t+86400,q.symbol.endsWith('LONGS')?90:110)];
  }}});
  const r=await service.execute('compare',{symbols:['BITFINEX:BTCUSD','BITFINEX:BTCUSDLONGS']});
  assert.equal(maxActive,1);assert.equal(requests.length,2);assert.equal(requests[0].from,t);
  assert.equal(r.data.series[0].changePercent,10);assert.equal(r.data.series[1].changePercent,-10);
  assert.equal(r.data.chart.dataIncluded,false);assert.equal(r.data.chart.rows,undefined);
});

test('invalid comparison windows and symbol counts are refused before provider access',async()=>{
  let touched=false;const service=createCharts({store:{load:async()=>{touched=true;}},sdk:{}});
  for(const args of [{symbols:['X:A']},{symbols:['X:A','X:A']},{symbols:['X:A','X:B'],period:'year_to_date',from:'1'}])await assert.rejects(service.execute('compare',args));
  assert.equal(touched,false);
});

test('daily period requests include ISO dates and computed changes',async()=>{
  let query;const service=createCharts({store,now:()=> '2026-11-07T12:00:00Z',sdk:{getCandles:async q=>{query=q;return[candle(q.from,100),candle(q.to,110)];}}});
  const r=await service.execute('candles',{symbol:'X:A',period:'last_calendar_month'});
  assert.equal(new Date(query.from*1000).toISOString(),'2026-10-01T00:00:00.000Z');
  assert.equal(r.coverage.lastObservation,'2026-10-31T23:59:59.000Z');assert.equal(r.summary.changePercent,10);
  assert.equal(r.data[0].timeIso,'2026-10-01T00:00:00.000Z');
});

test('position quotes carry BTC units and a human-readable observation timestamp',()=>{
  const r=quote('BITFINEX:BTCUSDLONGS',{lp:90000,lp_time:1794009600,currency_code:'USD',type:'index'});
  assert.equal(r.instrument.unit,'BTC');assert.equal(r.instrument.currency,null);assert.equal(r.fields.currency_code,'USD');
  assert.equal(r.asOf,'2026-11-07T00:00:00.000Z');
});

test('watchlist truncation offers an executable continuation and preserves the final entries',async()=>{
  const service=createCharts({store:{load:async()=>({credentials:{session:'fixture'}})},sdk:{getWatchlists:async()=>[{id:1,name:'Large',symbols:Array.from({length:250},(_,i)=>`TEST:S${i}`)}]}});
  const first=await service.execute('watchlists',{});
  assert.equal(first.status,'partial');assert.equal(first.complete,false);assert.equal(first.data[0].entries.length,200);
  const next=first.nextRequests[0];assert.equal(next.arguments['entry-offset'],200);
  const second=await service.execute(next.tool,next.arguments);
  assert.equal(second.complete,true);assert.equal(second.data[0].entries.length,50);assert.equal(second.data[0].entries.at(-1).value,'TEST:S249');
});
