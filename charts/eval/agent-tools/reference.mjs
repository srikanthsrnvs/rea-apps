// Authored reference, never included in Qwen's prompt. Both run through the
// production service and same deterministic backend. This is not a lower bound.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, marketRows } from './fixture.mjs';
import { scenarios } from './scenarios.mjs';
import { modelView } from '../../src/presentation.mjs';
const output=process.env.CHARTS_REFERENCE_OUTPUT;
if(!path.isAbsolute(output??''))throw new Error('Set CHARTS_REFERENCE_OUTPUT.');
await fs.mkdir(output,{recursive:true,mode:0o700});
const summaries=[];
for(const name of Object.keys(scenarios)){
 const world=await fixture(path.join(output,name),name);
 if(['overlay','ytd'].includes(name)){
  for(let turn=0;turn<(name==='overlay'?2:1);turn++){
   if(process.env.CHARTS_REFERENCE_COMPARE==='1')await world.call('charts_compare',{symbols:['BITFINEX:BTCUSD','BITFINEX:BTCUSDLONGS'],timeframe:'1d',from:'2026-01-01T00:00:00Z',to:'2026-11-07T12:00:00Z',count:400,...(name==='overlay'?{'include-data':true}:{})});
   else for(const symbol of ['BITFINEX:BTCUSD','BITFINEX:BTCUSDLONGS'])await world.call('charts_candles',{symbol,timeframe:'1d',from:'2026-01-01T00:00:00Z',to:'2026-11-07T12:00:00Z',count:400});
  }
 } else if(name==='quotes')await world.call('charts_quotes',{symbols:['BITFINEX:BTCUSD','BITFINEX:ETHUSD']});
 else if(name==='calendar')await world.call('charts_candles',{symbol:'BITFINEX:BTCUSD',timeframe:'1d',from:'2026-10-01T00:00:00Z',to:'2026-10-31T23:59:59Z',count:31});
 else if(name==='login')await world.call('charts_login',{'client-profile':'orin'});
 else if(name==='watchlists')await world.call('charts_watchlists',{limit:100,'symbol-limit':200});
 else if(name==='study_error')await world.call(process.env.CHARTS_REFERENCE_COMPARE==='1'?'charts_technicals':'charts_screener',process.env.CHARTS_REFERENCE_COMPARE==='1'?{symbol:'BITFINEX:BTCUSD'}:{market:'global',symbols:['BITFINEX:BTCUSD'],columns:['RSI'],limit:1});
 summaries.push({case:name,calls:world.trace.length,outputBytes:world.trace.reduce((n,t)=>n+Buffer.byteLength(JSON.stringify(t.result)),0),modelOutputBytes:world.trace.reduce((n,t)=>n+Buffer.byteLength(JSON.stringify(process.env.CHARTS_REFERENCE_COMPARE==='1'?modelView(t.result):t.result)),0),backendCalls:world.backendCalls.length});
}
const jan=Date.parse('2026-01-01T00:00:00Z')/1000;
const expected=Object.fromEntries(Object.entries(marketRows).map(([symbol,rows])=>{
 const window=rows.filter(d=>d.time>=jan);return[symbol,{first:window[0].close,last:window.at(-1).close,changePercent:(window.at(-1).close/window[0].close-1)*100,bars:window.length}];
}));
await fs.writeFile(path.join(output,'summary.json'),JSON.stringify({author:'primary coding agent',summaries,expected},null,2),{mode:0o600});
console.log(JSON.stringify(summaries));
