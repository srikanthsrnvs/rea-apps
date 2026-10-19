import test from 'node:test';
import assert from 'node:assert/strict';
import {ClaudeClient,CookieJar} from '../src/http.mjs';
test('Claude session cookies remain on their source domain, HTTPS and path',()=>{
 const jar=new CookieJar([{name:'sessionKey',value:'example-private',domain:'claude.ai',path:'/',secure:true},{name:'local',value:'scoped',domain:'api.claude.ai',hostOnly:true,path:'/api/auth/'}]);
 assert.match(jar.header('https://api.claude.ai/api/account'),/sessionKey/);
 assert.equal(jar.header('https://api.anthropic.com/api/account'),'');
 assert.equal(jar.header('http://claude.ai/api/account'),'');
 assert.equal(jar.header('https://api.claude.ai/api/account').includes('local'),false);
 jar.merge([{name:'sessionKey',value:'',domain:'claude.ai',path:'/',expiresAt:0}]);assert.equal(jar.header('https://claude.ai/api/account'),'');
});
test('unsafe endpoints and redirects cannot forward account credentials',async()=>{
 const calls=[];const client=new ClaudeClient({cookies:[{name:'sessionKey',value:'private',domain:'claude.ai'}],fetchImpl:async(url,options)=>{calls.push({url:String(url),...options});return new Response('',{status:302,headers:{location:'https://example.com'}});}});
 for(const url of ['http://claude.ai/api/account','https://example.com/','https://claude.ai.evil.example/','https://user@claude.ai/','https://claude.ai:8443/'])await assert.rejects(client.request(url),{code:'INVALID_ENDPOINT'});
 await assert.rejects(client.request('https://api.claude.ai/api/account'),{code:'REDIRECT_REQUIRED'});assert.equal(calls.length,1);assert.equal(calls[0].redirect,'manual');
});
test('stream transport validates content type and never retries a completion POST',async()=>{
 let calls=0;const stream=new ClaudeClient({fetchImpl:async()=>{calls++;return new Response('data: {"type":"message_stop"}\n\n',{headers:{'content-type':'text/event-stream; charset=utf-8'}});}});
 const r=await stream.request('https://api.claude.ai/api/example',{method:'POST',json:{},responseType:'stream'});assert.ok(r.body);await r.body.cancel();assert.equal(calls,1);
 const wrong=new ClaudeClient({fetchImpl:async()=>new Response('<html/>',{headers:{'content-type':'text/html'}})});await assert.rejects(wrong.request('https://api.claude.ai/api/example',{method:'POST',json:{},responseType:'stream'}),{code:'UNEXPECTED_RESPONSE'});
 const broken=new ClaudeClient({fetchImpl:async()=>{calls++;throw Error('Connection lost after possible send');}});await assert.rejects(broken.request('https://api.claude.ai/api/example',{method:'POST',json:{},responseType:'stream'}),{code:'NETWORK_ERROR'});assert.equal(calls,2);
});
test('oversized bodies and rate limits stop without replay',async()=>{
 const client=new ClaudeClient({fetchImpl:async()=>new Response('123456789')});await assert.rejects(client.request('https://api.claude.ai/api/account',{maxBytes:5}),{code:'RESPONSE_TOO_LARGE'});
 let count=0;const limited=new ClaudeClient({fetchImpl:async()=>{count++;return new Response('wait',{status:429});}});await assert.rejects(limited.request('https://api.claude.ai/api/account'),{code:'RATE_LIMITED'});assert.equal(count,1);
});
