// Authored reference using only public Charts operations. No account changes.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createCharts} from '../../src/service.mjs';
import {publicError} from '../../src/errors.mjs';
const directory=process.env.CHARTS_REFERENCE_OUTPUT;
if(!path.isAbsolute(directory??''))throw new Error('Set an absolute CHARTS_REFERENCE_OUTPUT.');
await fs.mkdir(directory,{recursive:true,mode:0o700});
const charts=createCharts(),report=[];
const symbols=['BITFINEX:BTCUSD','BITFINEX:ETHUSD','BITFINEX:BTCUSDLONGS'];
async function call(scenario,command,args){
 let result;
 try{result=await charts.execute(command,{...args,auth:'anonymous','timeout-ms':30000});}
 catch(e){result={status:'error',error:publicError(e)};}
 report.push({scenario,command,args,result});
 await fs.writeFile(path.join(directory,'reference.json'),JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({scenario,command,status:result.status,code:result.error?.code,rows:result.data?.length??result.data?.window?.observations}));
 return result;
}
await call('three_series','compare',{symbols,period:'last_calendar_month',timeframe:'D',count:40,'include-data':true});
await call('three_series','compare',{symbols,period:'last_90_days',timeframe:'1h',count:3000,'include-data':true});
const fields=['RSI','MACD.macd','MACD.signal','EMA200'];
await call('multi_timeframe','screener',{market:'crypto',symbols:symbols.slice(0,2),columns:[...fields,...fields.map(x=>x+'|60')],limit:2});
const screen={market:'america',columns:['name','market_cap_basic','RSI','volume','average_volume_10d_calc'],filters:[
 {left:'type',operation:'equal',right:'stock'},
 {left:'market_cap_basic',operation:'greater',right:1e10},
 {left:'RSI',operation:'in_range',right:[30,45]},
 {left:'average_volume_10d_calc',operation:'greater',right:1e6}
],'sort-by':'volume','sort-order':'desc',limit:5};
await call('screener_pages','screener',{...screen,offset:0});
await call('screener_pages','screener',{...screen,offset:5});
for(const chartType of [undefined,'HeikinAshi'])await call('synthetic_bars','candles',{symbol:symbols[0],timeframe:'1h',count:40,...(chartType?{'chart-type':chartType}:{})});
await call('finite_stream','stream quotes',{symbols:symbols.slice(0,2),seconds:8,'max-updates':6});
for(const [scenario,reason] of [
 ['formula_statistics','No CLI operation currently computes ratio series, rebasing to 100, maximum drawdown or rolling correlation. Raw price data is available.'],
 ['chart_editor_boundary','No chart editor, saved-layout writes, alerts, footprint generation, anchored VWAP or replay operation.'],
 ['pine_boundary','No arbitrary Pine source compilation, parameter optimization or custom backtest operation. Existing strategy-report reads are a different capability.']
])report.push({scenario,command:null,result:{status:'unsupported',reason}});
await fs.writeFile(path.join(directory,'reference.json'),JSON.stringify(report,null,2),{mode:0o600});
