import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const source=process.env.CHARTS_EVAL_APP_ROOT?pathToFileURL(path.resolve(process.env.CHARTS_EVAL_APP_ROOT)+'/src/'):new URL('../../src/',import.meta.url);
const {createSessionStore}=await import(new URL('session.mjs',source));
const {createCharts}=await import(new URL('service.mjs',source));
const {ChartsError,publicError}=await import(new URL('errors.mjs',source));

export const NOW = '2026-11-07T12:00:00.000Z';
const begin = Date.parse('2025-11-01T00:00:00Z') / 1000;
const end = Date.parse('2026-11-07T00:00:00Z') / 1000;
export const marketRows = Object.fromEntries(['BITFINEX:BTCUSD','BITFINEX:BTCUSDLONGS','BITFINEX:ETHUSD'].map(symbol => {
  const rows = [];
  for(let time=begin;time<=end;time+=86400){
    const i=(time-Date.parse('2026-01-01T00:00:00Z')/1000)/86400;
    const close = Math.round((symbol.endsWith('LONGS') ? 50000+i*90+700*Math.sin(i/15) : symbol.includes('ETH') ? 3000-i*2+70*Math.sin(i/9) : 100000-i*65+2400*Math.sin(i/12))*100)/100;
    rows.push({time,open:close,high:close+10,low:close-10,close,volume:symbol.endsWith('LONGS')?0:100});
  }
  return [symbol,rows];
}));

export async function fixture(directory, scenario) {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const store=createSessionStore(path.join(directory,'state'));
  if(scenario!=='login')await store.save({version:1,credentials:{session:'synthetic-session'},account:{id:42,username:'example_user'},savedAt:NOW});
  const backendCalls=[];
  const listSymbols=Object.keys(marketRows);
  const metadata=symbol=>({symbol:symbol.split(':')[1],full_name:symbol,description:symbol.endsWith('LONGS')?'BTCUSD Longs':symbol.includes('ETH')?'Ethereum / Dollar':'Bitcoin / Dollar',type:symbol.endsWith('LONGS')?'index':'crypto',exchange:'Bitfinex',currency_code:'USD'});
  const sdk={
    async getUser(){backendCalls.push({operation:'getUser'});return{id:42,username:'example_user'};},
    async searchMarkets(query,options){backendCalls.push({operation:'searchMarkets',query});return listSymbols.filter(s=>s.includes(query.toUpperCase().replace('BITFINEX:',''))&&(!options.type||options.type===metadata(s).type)).map(s=>({id:s,exchange:'Bitfinex',symbol:s.split(':')[1],description:metadata(s).description,type:metadata(s).type}));},
    async getSymbolInfo({symbol}){backendCalls.push({operation:'getSymbolInfo',symbol});if(!marketRows[symbol])throw new ChartsError('SYMBOL_ERROR','Unknown fixture symbol.');return metadata(symbol);},
    async getCandles(query){
      backendCalls.push({operation:'getCandles',query});let data=marketRows[query.symbol];if(!data)throw new ChartsError('SYMBOL_ERROR','Unknown fixture symbol.');
      if(/^\d+$/u.test(query.timeframe)){
        const step=Number(query.timeframe)*60,stop=Math.floor(Date.parse(NOW)/1000/step)*step;
        const start=Math.max(begin,query.from??(stop-(query.count-1)*step));data=[];
        for(let time=Math.ceil(start/step)*step;time<=Math.min(stop,query.to??stop);time+=step){
          const i=(time-Date.parse('2026-01-01T00:00:00Z')/1000)/86400;
          const close=Math.round((query.symbol.endsWith('LONGS')?50000+i*90+700*Math.sin(i/15):query.symbol.includes('ETH')?3000-i*2+70*Math.sin(i/9):100000-i*65+2400*Math.sin(i/12))*100)/100;
          data.push({time,open:close,high:close+10,low:close-10,close,volume:query.symbol.endsWith('LONGS')?0:100});
        }
      }
      return data.filter(d=>(query.from===undefined||d.time>=query.from)&&(query.to===undefined||d.time<=query.to)).slice(-query.count);
    },
    async getQuotes({symbols}){backendCalls.push({operation:'getQuotes',symbols});return Object.fromEntries(symbols.filter(s=>marketRows[s]).map(s=>[s,{lp:marketRows[s].at(-1).close,lp_time:end,currency_code:'USD',type:metadata(s).type,description:metadata(s).description,update_mode:'streaming'}]));},
    async getWatchlists(){backendCalls.push({operation:'getWatchlists'});return[{id:10,name:'Markets',symbols:['###Crypto',...Array.from({length:75},(_,i)=>`TEST:COIN${i+1}`),'###Equities','NASDAQ:AAPL','NASDAQ:MSFT']},{id:20,name:'Favorites',symbols:['BITFINEX:BTCUSD','BITFINEX:ETHUSD']}];},
    async getPrivateIndicators(){return[];},
    async searchIndicators(){backendCalls.push({operation:'searchIndicators'});return[{id:'STD;RSI',name:'Relative strength index',version:'47.0',type:'study',access:'closed_source'}];},
    async getIndicator(){return{id:'STD;RSI',version:'47.0',description:'Relative strength index',inputs:{},plots:{plot_0:'RSI'}};},
    async getIndicatorData(){backendCalls.push({operation:'getIndicatorData'});throw Object.assign(new Error("Study error: Can't parse pine"),{code:'STUDY_ERROR'});},
    async getScreener(query){backendCalls.push({operation:'getScreener',query});return{totalCount:1,rows:[{symbol:'BITFINEX:BTCUSD',values:{RSI:62.5,'RSI|60':48,'Recommend.All':0.3,'Recommend.MA':0.5,'Recommend.Other':0.1}}]};},
  };
  const service=createCharts({store,sdk,now:()=>NOW});
  const trace=[];
  return {
    backendCalls,trace,store,
    async call(name,args){
      let result;
      if(['charts_auth_complete','charts_auth_cancel','charts_logout'].includes(name)||(name==='charts_login'&&scenario!=='login')){
        result={status:'error',error:{code:'EVALUATION_MUTATION_BLOCKED',message:'This scenario does not authorize an account change.'}};
      }else try{result=await service.execute(name,args);}catch(error){const detail=publicError(error);result={status:'error',message:detail.message,error:detail};}
      trace.push({name,args,result});
      await fs.writeFile(path.join(directory,'trace.json'),JSON.stringify({trace,backendCalls},null,2),{mode:0o600});
      return result;
    },
  };
}
