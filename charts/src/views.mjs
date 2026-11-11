import {fork} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createSessionStore} from './session.mjs';
import {initialView} from './view-model.mjs';
import {ChartsError} from './errors.mjs';
import {boundedFetch} from './http.mjs';

function summary(id,record,state){
 return{status:'ok',viewId:id,viewerUrl:record.viewerUrl,expiresAt:new Date(record.expiresAt).toISOString(),
  actualView:`${state.config.series[0]?.kind} | ${state.config.timeframe} bars | ${state.config.period??'custom dates'} | ${state.config.normalization} values | ${state.config.scale} scale | ${state.config.series.length} series | ${(state.config.studies??[]).map(s=>`${s.kind}(${s.length}) on ${s.symbol}`).join(', ')||'no indicators'}`,
  revision:state.revision,viewerSeenAt:state.viewerSeenAt,config:state.config,
  series:state.data?.series?.map(s=>({id:s.id,symbol:s.symbol,points:s.data.length,last:s.data.at(-1),coverage:s.coverage})),
  studies:state.data?.studies?.map(s=>({id:s.id,kind:s.kind,length:s.length,points:s.data.length,calculation:s.calculation})),
  warnings:state.data?.warnings??[],browserTabCloseStopsServer:false,message:'Open viewerUrl on the client. Edits update that same chart; price data is a snapshot until a data edit refreshes it. Closing the browser tab does not stop the server: use view close or its expiration. viewerSeenAt records a browser data read, not proof of visual rendering.'};
}
export async function executeView(command,args,signal){
 signal?.throwIfAborted();
 const store=createSessionStore();
 if(command==='view create'){
  const config=initialView(args),id=randomBytes(6).toString('hex'),key=randomBytes(32).toString('base64url');
  const expiresAt=Date.now()+(args['duration-seconds']??3600)*1000;
  const host=args.host??'127.0.0.1';
  if(!['127.0.0.1','0.0.0.0','::1'].includes(host))throw new ChartsError('INVALID_ARGUMENT','Use loopback or 0.0.0.0 as the listening host.');
  let publicBase=args['public-url']?new URL(args['public-url']):null;
  if(publicBase&&(!['http:','https:'].includes(publicBase.protocol)||publicBase.username||publicBase.password||publicBase.search||publicBase.hash||publicBase.pathname!=='/'))throw new ChartsError('INVALID_ARGUMENT','public-url must be a plain HTTP(S) origin reachable from the client.');
  if(publicBase&&args.public)throw new ChartsError('INVALID_ARGUMENT','Choose public or public-url, not both.');
  await store.lock(async()=>{
   const active=(await store.read('view-index')??[]).filter(v=>v.expiresAt>Date.now());
   if(active.length>=3)throw new ChartsError('VIEW_LIMIT','Close an existing chart before creating another. At most three views may run.');
   await store.write('view-index',[...active,{id,expiresAt}]);
  });
  const child=fork(fileURLToPath(new URL('./view-worker.mjs',import.meta.url)),[],{detached:true,stdio:['ignore','ignore','ignore','ipc'],execArgv:['--max-old-space-size=96']});
  let started;try{started=await new Promise((resolve,reject)=>{
   const abort=()=>{clearTimeout(timer);child.kill();reject(signal.reason);};
   const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);child.kill();reject(new ChartsError('TIMEOUT','Chart creation timed out.'));},60000);
   signal?.addEventListener('abort',abort,{once:true});
   const fail=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new ChartsError('VIEW_START_FAILED','Chart server failed to start.'));};
   child.once('error',fail);child.once('exit',fail);
   child.once('message',message=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);child.removeListener('exit',fail);message.error?reject(new ChartsError(message.error.code,message.error.message)):resolve(message);});
   child.send({id,key,config,host,port:args.port??0,expiresAt,auth:args.auth??'anonymous',public:args.public??false});
  });}catch(error){child.kill();await store.lock(async()=>store.write('view-index',(await store.read('view-index')??[]).filter(v=>v.id!==id)));throw error;}
  child.unref();
  const endpoint=`http://${host==='::1'?'[::1]':'127.0.0.1'}:${started.port}`;
  const viewerUrl=`${started.publicUrl??publicBase?.origin??endpoint}/#key=${key}`;
  const record={key,endpoint,viewerUrl,expiresAt,config};
  try{await store.write(`view-${id}`,record);}catch(error){child.kill();await store.lock(async()=>store.write('view-index',(await store.read('view-index')??[]).filter(v=>v.id!==id)));throw error;}
  return executeView('view state',{'view-id':id},signal);
 }
 const id=args['view-id'];
 if(!/^[a-f0-9]{12,24}$/u.test(id??''))throw new ChartsError('INVALID_ARGUMENT','Use a viewId returned by view create.');
 const record=await store.read(`view-${id}`);
 if(!record||record.expiresAt<=Date.now())throw new ChartsError('VIEW_EXPIRED','This chart is missing or expired. Create a new view.');
 let response;
 try{response=await boundedFetch(record.endpoint+(command==='view update'?'/api/edit':command==='view close'?'/api/close':'/api/view'),{
  method:command==='view state'?'GET':'POST',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(35000)]):AbortSignal.timeout(35000),headers:{Authorization:`Bearer ${record.key}`,'Content-Type':'application/json','X-Charts-Client':'cli'},
  ...(command==='view update'?{body:JSON.stringify({changes:args.changes,revision:args.revision})}:{})});
 }catch{throw new ChartsError('VIEW_UNREACHABLE','The chart server is no longer reachable. Create a new view.');}
 const state=await response.json();if(!response.ok)throw new ChartsError(state.error?.code??'VIEW_ERROR',state.error?.message??'Chart operation failed.');
 if(command==='view close'){await store.removeRecord(`view-${id}`);await store.lock(async()=>store.write('view-index',(await store.read('view-index')??[]).filter(v=>v.id!==id)));return{status:'ok',viewId:id,closed:true};}
 return summary(id,record,state);
}
