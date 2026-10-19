import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';

// A genuine provider widget runs only in the user's browser. No Claude login
// form, password, browser session export, remote display or fabricated token.
const CSP="default-src 'none'; script-src 'self' https://hcaptcha.com https://*.hcaptcha.com; style-src 'self' 'unsafe-inline' https://hcaptcha.com https://*.hcaptcha.com; frame-src https://hcaptcha.com https://*.hcaptcha.com; connect-src 'self' https://hcaptcha.com https://*.hcaptcha.com; img-src https://hcaptcha.com https://*.hcaptcha.com data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const HTML='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verification</title><link rel="stylesheet" href="/style.css"></head><body><div id="verification"></div><script src="/client.js"></script></body></html>';
const STYLE='html,body{margin:0;min-height:100%;background:#fff}body{display:flex;align-items:center;justify-content:center;min-height:100vh}';
const CLIENT=`(async()=>{
 const key=new URLSearchParams(location.hash.slice(1)).get('key');history.replaceState(null,'',location.pathname);
 const headers={authorization:'Bearer '+key};let sent=false;
 const config=await fetch('/config',{headers,cache:'no-store'}).then(r=>{if(!r.ok)throw Error('Expired');return r.json()});
 const submit=async(token,error)=>{
  if(sent)return;sent=true;
  try{const response=await fetch('/result',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(token?{token}:{error:String(error).slice(0,256)})});document.title=response.ok?(token?'Verification complete':'Verification failed'):'Verification expired';}
  catch{document.title='Verification connection lost';}
 };
 window.providerReady=()=>{try{const widget=hcaptcha.render('verification',{sitekey:config.publicKey,size:'invisible',callback:token=>submit(token),'error-callback':error=>submit(null,error),'expired-callback':()=>submit(null,'expired')});hcaptcha.execute(widget);}catch{void submit(null,'widget_start_failed')}};
 const script=document.createElement('script');script.src='https://js.hcaptcha.com/1/api.js?render=explicit&recaptchacompat=off&onload=providerReady';script.async=true;script.onerror=()=>submit(null,'script_load_failed');document.head.appendChild(script);
})().catch(()=>{document.title='Verification failed'});`;
export async function createVerificationRelay({directory,publicKey,ttlMs=15*60000,onResult,onStop}={}){
 if(!path.isAbsolute(directory??'')||!/^[0-9a-f-]{36}$/i.test(publicKey??''))throw new TypeError('Private directory and provider site key required');
 if(!Number.isSafeInteger(ttlMs)||ttlMs<100||ttlMs>30*60000)throw new TypeError('Invalid verification lifetime');
 await fs.mkdir(directory,{recursive:true,mode:0o700});const info=await fs.lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw new TypeError('Real private directory required');
 await fs.chmod(directory,0o700);
 const id=randomUUID(),key=randomBytes(32).toString('base64url'),expiresAt=Date.now()+ttlMs;
 let result={status:'waiting'},publishing=false,closed=false;
 const status=()=>({id,status:Date.now()>=expiresAt&&result.status==='waiting'?'expired':result.status,expiresAt});
 const server=http.createServer({requestTimeout:10000,headersTimeout:10000,maxHeaderSize:8192},async(request,response)=>{
  const send=(code,body,type='application/json; charset=utf-8')=>{response.writeHead(code,{'content-type':type,'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':CSP});response.end(typeof body==='string'?body:JSON.stringify(body));};
  try{
   if(closed||Date.now()>=expiresAt)return send(410,{error:'expired'});
   if(request.method==='GET'&&request.url==='/')return send(200,HTML,'text/html; charset=utf-8');
   if(request.method==='GET'&&request.url==='/client.js')return send(200,CLIENT,'text/javascript; charset=utf-8');
   if(request.method==='GET'&&request.url==='/style.css')return send(200,STYLE,'text/css; charset=utf-8');
   const supplied=Buffer.from(request.headers.authorization??''),expected=Buffer.from('Bearer '+key);
   if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return send(401,{error:'unauthorized'});
   if(request.method==='GET'&&request.url==='/config')return send(200,{publicKey,expiresAt});
   if(request.method==='GET'&&request.url==='/status')return send(200,status());
   if(request.method==='POST'&&request.url==='/stop'){response.once('finish',()=>void Promise.resolve(onStop?onStop():close()).catch(()=>{}));return send(200,{status:'closing'});}
   if(request.method!=='POST'||request.url!=='/result')return send(404,{error:'not_found'});
   if(publishing||result.status!=='waiting')return send(409,{error:'already_completed'});
   if(!/^application\/json(?:;|$)/i.test(request.headers['content-type']??''))return send(415,{error:'json_required'});
   const chunks=[];let size=0;
   for await(const chunk of request){size+=chunk.length;if(size>24000)return send(413,{error:'too_large'});chunks.push(chunk);}
   const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(Date.now()>=expiresAt)return send(410,{error:'expired'});
   if(publishing||result.status!=='waiting')return send(409,{error:'already_completed'});
   let next;
   if(typeof input?.token==='string'&&input.token.length>=20&&input.token.length<=20000&&!/[\x00-\x1f\x7f]/.test(input.token))next={id,status:'completed',token:input.token,publicKey,receivedAt:new Date().toISOString()};
   else if(typeof input?.error==='string'&&input.error.length<=256)next={id,status:'failed',error:input.error,receivedAt:new Date().toISOString()};
   else return send(400,{error:'invalid_result'});
   publishing=true;
   try{const temp=path.join(directory,`.result-${randomUUID()}.tmp`);try{await fs.writeFile(temp,JSON.stringify(next),{flag:'wx',mode:0o600});await fs.link(temp,path.join(directory,'verification-result.json'));}finally{await fs.rm(temp,{force:true});}result=next;}finally{publishing=false;}
   send(200,{status:result.status});if(onResult)void Promise.resolve().then(()=>onResult(status())).catch(()=>{});
  }catch{if(!response.headersSent)send(400,{error:'invalid_request'});}
 });
 server.on('clientError',(_error,socket)=>socket.destroy());
 let closePromise;function close(){if(closePromise)return closePromise;closed=true;clearTimeout(timer);closePromise=new Promise(resolve=>{if(!server.listening)return resolve();server.close(resolve);server.closeAllConnections();});return closePromise;}
 const timer=setTimeout(()=>void close(),ttlMs);timer.unref();
 return {id,key,expiresAt,status,close,listen(){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve(server.address().port);});});}};
}
