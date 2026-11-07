import http from 'node:http';
import fs from 'node:fs/promises';
import {timingSafeEqual} from 'node:crypto';
import {createCharts} from './service.mjs';
import {changeView,buildView,validateView} from './view-model.mjs';
import {ChartsError,publicError} from './errors.mjs';

const root=new URL('./view-web/',import.meta.url);
const assets=new Map([
 ['/',[new URL('index.html',root),'text/html; charset=utf-8']],
 ['/app.mjs',[new URL('app.mjs',root),'text/javascript; charset=utf-8']],
 ['/style.css',[new URL('style.css',root),'text/css; charset=utf-8']],
 ['/charts.mjs',[new URL('../node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.mjs',import.meta.url),'text/javascript; charset=utf-8']],
]);
export async function startViewServer({config,key,host='127.0.0.1',port=0,expiresAt,auth='anonymous',service=createCharts(),persist=async()=>{}}){
 let revision=1,busy=false,viewerSeenAt=null;
 config=validateView(config);
 let data=await buildView(config,service,auth);
 const state=()=>({revision,config,data,expiresAt,viewerSeenAt});
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors *; base-uri 'none'; form-action 'self'"};
 const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify(value));};
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');
   if(url.pathname==='/favicon.ico'){res.writeHead(204,headers);res.end();return;}
   if(Date.now()>=expiresAt)return send(res,410,{error:{code:'VIEW_EXPIRED',message:'This chart link expired.'}});
   if(assets.has(url.pathname)&&req.method==='GET'){
    const [file,type]=assets.get(url.pathname);res.writeHead(200,{'Content-Type':type,...headers});res.end(await fs.readFile(file));return;
   }
   const supplied=Buffer.from((req.headers.authorization??'').replace(/^Bearer /u,'')),expected=Buffer.from(key);
   if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return send(res,401,{error:{code:'VIEW_ACCESS_DENIED',message:'Open the complete chart link.'}});
   if(url.pathname==='/api/view'&&req.method==='GET'){
    if(req.headers['x-charts-client']!=='cli')viewerSeenAt=new Date().toISOString();
    return send(res,200,url.searchParams.get('revision')===String(revision)?{unchanged:true,revision}:state());
   }
   if(url.pathname==='/api/close'&&req.method==='POST'){send(res,200,{closed:true});setTimeout(()=>server.closeAllConnections(),25);setTimeout(()=>server.close(),30);return;}
   if(url.pathname==='/api/edit'&&req.method==='POST'){
    if(busy)return send(res,409,{error:{code:'VIEW_BUSY',message:'Another edit is in progress. Retry after it completes.'}});
    if(!String(req.headers['content-type']).startsWith('application/json'))return send(res,415,{error:{code:'INVALID_ARGUMENT',message:'Use JSON.'}});
    let size=0,parts=[];
    for await(const chunk of req){size+=chunk.length;if(size>65536)throw new ChartsError('INVALID_ARGUMENT','Chart edits must fit within 64 KiB.');parts.push(chunk);}
    let input;try{input=JSON.parse(Buffer.concat(parts).toString());}catch{throw new ChartsError('INVALID_ARGUMENT','Invalid edit JSON.');}
    if(input.revision!==undefined&&input.revision!==revision)return send(res,409,{error:{code:'VIEW_CONFLICT',message:'The view changed. Read its current state and retry.'}});
    const next=changeView(config,input.changes??{});busy=true;
    try{
     const queryKeys=['timeframe','count','period','from','to'];
     const seriesData=list=>JSON.stringify(list.map(s=>[s.id,s.symbol,s.kind]));
     const studyData=list=>JSON.stringify(list.map(s=>[s.id,s.symbol,s.kind,s.length]));
     const mustFetch=queryKeys.some(k=>next[k]!==config[k])||seriesData(next.series)!==seriesData(config.series)||studyData(next.studies)!==studyData(config.studies)||next.normalization!==config.normalization||next.scale!==config.scale;
     const nextData=mustFetch?await buildView(next,service,auth):{...data,series:data.series.map(s=>({...s,...next.series.find(x=>x.id===s.id)})),studies:data.studies.map(s=>({...s,...next.studies.find(x=>x.id===s.id)}))};
     await persist(next);
     config=next;data=nextData;revision++;
    }finally{busy=false;}
    return send(res,200,state());
   }
   send(res,404,{error:{code:'NOT_FOUND',message:'Unknown chart operation.'}});
  }catch(e){send(res,400,{error:publicError(e)});}
 });
 server.requestTimeout=35000;server.headersTimeout=10000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
 const timer=setTimeout(()=>{server.closeAllConnections();server.close();},Math.max(1,expiresAt-Date.now()));timer.unref();
 server.on('close',()=>clearTimeout(timer));
 return{server,state,port:server.address().port};
}
