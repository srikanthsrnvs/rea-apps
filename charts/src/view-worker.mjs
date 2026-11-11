import {startViewServer} from './view-server.mjs';
import {createSessionStore} from './session.mjs';
import {ChartsError,publicError} from './errors.mjs';
import {spawn} from 'node:child_process';
process.once('message',async message=>{
 let result,tunnel;
 try{
  const store=createSessionStore();
  result=await startViewServer({...message,persist:async config=>{
   const record=await store.read(`view-${message.id}`);
   if(record)await store.write(`view-${message.id}`,{...record,config});
  }});
  let publicUrl;
  if(message.public){
   publicUrl=await new Promise((resolve,reject)=>{
    tunnel=spawn(process.env.CHARTS_CLOUDFLARED??'cloudflared',['tunnel','--no-autoupdate','--url',`http://127.0.0.1:${result.port}`],{stdio:['ignore','ignore','pipe']});
    const timer=setTimeout(()=>reject(new ChartsError('VIEW_LINK_FAILED','Tunnel startup timed out.')),20000);let text='';
    tunnel.once('error',()=>{clearTimeout(timer);reject(new ChartsError('VIEW_LINK_FAILED','Install cloudflared to create a public chart link.'));});
    tunnel.stderr.on('data',chunk=>{text=(text+chunk).slice(-16000);const match=text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/u);if(match){clearTimeout(timer);resolve(match[0]);}});
    tunnel.once('exit',()=>{clearTimeout(timer);reject(new ChartsError('VIEW_LINK_FAILED','The chart tunnel exited before becoming ready.'));});
   });
  }
  result.server.on('close',()=>{tunnel?.kill();process.exit(0);});
  process.send({port:result.port,publicUrl,revision:1});
  process.disconnect();
 }catch(error){tunnel?.kill();result?.server.closeAllConnections();result?.server.close();process.send({error:publicError(error)});process.disconnect();process.exitCode=1;}
});
